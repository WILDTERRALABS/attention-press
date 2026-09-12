import type { Hex } from "viem";
import { TypedEmitter } from "./util/emitter.js";
import { EngagementTracker } from "./engagement/EngagementTracker.js";
import { SessionKey } from "./session/SessionKey.js";
import { computeCumulative, isBudgetExhausted } from "./session/accrual.js";
import { openSession as defaultOpenSession, type OpenSessionFn } from "./chain/openSession.js";
import { closeSession as defaultCloseSession, type CloseSessionFn } from "./chain/closeSession.js";
import {
  finalizeSession as defaultFinalizeSession,
  type FinalizeSessionFn,
  type FinalizeSessionResult,
} from "./chain/finalizeSession.js";
import type { AttentionMeterConfig, EndReason, MeterEventMap, MeterState, VoucherRecord } from "./types.js";

const DEFAULTS = {
  voucherIntervalMs: 5_000,
  idleTimeoutMs: 30_000,
  scrollStallTimeoutMs: 0,
};

const UINT64_MAX = (1n << 64n) - 1n;
const UINT96_MAX = (1n << 96n) - 1n;

/** Test seam / advanced override for the on-chain calls. */
export interface AttentionMeterDeps {
  openSession?: OpenSessionFn;
  closeSession?: CloseSessionFn;
  finalizeSession?: FinalizeSessionFn;
}

/**
 * Drop-in reading meter: opens an on-chain session, tracks engagement, signs a
 * voucher every ~5s while the reader is actually reading, and closes the session
 * (refunding unspent budget) on `stop()`.
 *
 * Events: `session:started`, `voucher:signed`, `session:paused`,
 * `session:resumed`, `session:ended`, `error`.
 */
export class AttentionMeter extends TypedEmitter<MeterEventMap> {
  private readonly cfg: AttentionMeterConfig & {
    voucherIntervalMs: number;
    idleTimeoutMs: number;
    scrollStallTimeoutMs: number;
  };
  private readonly openSessionImpl: OpenSessionFn;
  private readonly closeSessionImpl: CloseSessionFn;
  private readonly finalizeSessionImpl: FinalizeSessionFn;
  private finalizeResult: FinalizeSessionResult | null = null;

  private state: MeterState = "idle";
  private tracker: EngagementTracker | null = null;
  private sessionKey: SessionKey | null = null;

  private sessionId: Hex | null = null;
  private startedAtMs = 0;
  private cumulative = 0n;
  private lastVoucher: VoucherRecord | null = null;
  private voucherIndex = 0;

  private voucherTimer: ReturnType<typeof setInterval> | null = null;
  private signing = false;
  private engagementInitialized = false;
  private unloadHandler: (() => void) | null = null;

  constructor(config: AttentionMeterConfig, deps: AttentionMeterDeps = {}) {
    super();
    validateConfig(config);
    this.cfg = {
      ...config,
      voucherIntervalMs: config.voucherIntervalMs ?? DEFAULTS.voucherIntervalMs,
      idleTimeoutMs: config.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs,
      scrollStallTimeoutMs: config.scrollStallTimeoutMs ?? DEFAULTS.scrollStallTimeoutMs,
    };
    this.openSessionImpl = deps.openSession ?? defaultOpenSession;
    this.closeSessionImpl = deps.closeSession ?? defaultCloseSession;
    this.finalizeSessionImpl = deps.finalizeSession ?? defaultFinalizeSession;
  }

  getState(): MeterState {
    return this.state;
  }

  getSnapshot() {
    return {
      state: this.state,
      sessionId: this.sessionId,
      signer: this.sessionKey?.address ?? null,
      cumulativeAmount: this.cumulative,
      engagedSeconds: this.tracker?.engagedSeconds ?? 0,
      budget: this.cfg.budget,
      lastVoucher: this.lastVoucher,
    };
  }

  /**
   * Sign an arbitrary message with this session's ephemeral key (the same key
   * that signs vouchers) — e.g. to prove session ownership to a relying party
   * without a wallet popup. The signature recovers to the `signer` address
   * registered on-chain for this session. Throws if no session is active.
   */
  async signWithSessionKey(message: string): Promise<Hex> {
    if (!this.sessionKey || this.sessionKey.destroyed) {
      throw new Error("signWithSessionKey(): no active session");
    }
    return this.sessionKey.signMessage(message);
  }

  async start(): Promise<void> {
    if (this.state !== "idle") throw new Error(`start() is invalid in state "${this.state}"`);
    this.state = "starting";
    try {
      this.sessionKey = SessionKey.generate();

      const { sessionId, txHash } = await this.openSessionImpl({
        provider: this.cfg.provider,
        chainId: this.cfg.chainId,
        contractAddress: this.cfg.contractAddress,
        articleId: this.cfg.articleId,
        budget: this.cfg.budget,
        ratePerSec: this.cfg.ratePerSec,
        signer: this.sessionKey.address,
        paymentToken: this.cfg.paymentToken,
        skipApproval: this.cfg.skipApproval,
        approveAmount: this.cfg.standingApproval,
      });

      this.sessionId = sessionId;
      this.startedAtMs = Date.now();

      this.emit("session:started", {
        sessionId,
        signer: this.sessionKey.address,
        txHash,
        startedAt: this.startedAtMs,
        budget: this.cfg.budget,
        ratePerSec: this.cfg.ratePerSec,
      });

      this.tracker = new EngagementTracker({
        target: this.cfg.target,
        idleTimeoutMs: this.cfg.idleTimeoutMs,
        scrollStallTimeoutMs: this.cfg.scrollStallTimeoutMs,
        onChange: ({ engaged, reason }) => {
          if (!this.engagementInitialized) return;
          if (this.state === "ended" || this.state === "stopping") return;
          if (engaged) {
            this.state = "reading";
            this.emit("session:resumed", { at: Date.now(), engagedSeconds: this.tracker?.engagedSeconds ?? 0 });
          } else {
            this.state = "paused";
            this.emit("session:paused", {
              reason: reason ?? "manual",
              at: Date.now(),
              engagedSeconds: this.tracker?.engagedSeconds ?? 0,
            });
          }
        },
      });
      this.tracker.start();
      this.engagementInitialized = true;

      if (this.tracker.isEngaged) {
        this.state = "reading";
      } else {
        this.state = "paused";
        this.emit("session:paused", {
          reason: this.tracker.pauseReason ?? "hidden",
          at: Date.now(),
          engagedSeconds: 0,
        });
      }

      this.voucherTimer = setInterval(() => void this.maybeSignVoucher(), this.cfg.voucherIntervalMs);

      if (typeof window !== "undefined") {
        this.unloadHandler = () => void this.maybeSignVoucher();
        window.addEventListener("pagehide", this.unloadHandler);
      }
    } catch (error) {
      this.state = "idle";
      this.sessionKey?.destroy();
      this.sessionKey = null;
      this.emit("error", { phase: "start", error });
      throw error;
    }
  }

  /** Manually pause accrual (e.g. a "take a break" control). Idempotent. */
  pause(): void {
    if (!this.tracker) throw new Error("pause() before start()");
    if (this.state === "ended" || this.state === "stopping") return;
    this.tracker.setManualPaused(true);
  }

  /** Undo a manual pause. Engagement resumes only if the tab is also visible/focused/active. */
  resume(): void {
    if (!this.tracker) throw new Error("resume() before start()");
    if (this.state === "ended" || this.state === "stopping") return;
    this.tracker.setManualPaused(false);
  }

  /**
   * Stop tracking, sign + deliver a final voucher for any uncounted time, and
   * send phase-1 `closeSession` on-chain. Does NOT refund — call {@link finalize}
   * after the challenge window (or let the author's collector do it).
   */
  async stop(reason: EndReason = "manual"): Promise<void> {
    if (this.state === "idle" || this.state === "ended" || this.state === "stopping") return;
    this.state = "stopping";

    if (this.voucherTimer) {
      clearInterval(this.voucherTimer);
      this.voucherTimer = null;
    }
    if (this.unloadHandler && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.unloadHandler);
      this.unloadHandler = null;
    }

    // Sign + deliver the final voucher so the collector can settle it during the
    // challenge window (closeSession no longer settles anything itself).
    await this.maybeSignVoucher();
    this.tracker?.stop();

    const sessionId = this.sessionId;
    if (!sessionId) {
      this.state = "ended";
      return;
    }

    let txHash: Hex | undefined;
    try {
      txHash = await this.closeSessionImpl({
        provider: this.cfg.provider,
        chainId: this.cfg.chainId,
        contractAddress: this.cfg.contractAddress,
        sessionId,
      });
    } catch (error) {
      // Session stays open on-chain; the reader can retry closeSession, or anyone
      // can force-close it after MAX_ACCRUAL_WINDOW.
      this.emit("error", { phase: "stop", error });
    }

    this.sessionKey?.destroy();
    this.state = "ended";
    this.emit("session:ended", {
      sessionId,
      reason,
      finalCumulative: this.cumulative,
      engagedSeconds: this.tracker?.engagedSeconds ?? 0,
      txHash,
    });
  }

  /**
   * Phase 2: refund `budget - claimed` to the reader and close the channel.
   * Valid only after {@link stop}. Reverts cleanly if the challenge window is
   * still open — poll `finalizeAvailableAt` from the `session:ended` payload.
   * Idempotent: returns the cached result once finalized.
   */
  async finalize(): Promise<FinalizeSessionResult> {
    if (this.state !== "ended") {
      throw new Error(`finalize() is invalid in state "${this.state}" — call stop() first`);
    }
    if (!this.sessionId) throw new Error("finalize(): no session");
    if (this.finalizeResult) return this.finalizeResult;

    try {
      const res = await this.finalizeSessionImpl({
        provider: this.cfg.provider,
        chainId: this.cfg.chainId,
        contractAddress: this.cfg.contractAddress,
        sessionId: this.sessionId,
      });
      this.finalizeResult = res;
      this.emit("session:finalized", { sessionId: this.sessionId, txHash: res.txHash, refunded: res.refunded });
      return res;
    } catch (error) {
      this.emit("error", { phase: "finalize", error });
      throw error;
    }
  }

  private async maybeSignVoucher(): Promise<void> {
    if (this.signing) return;
    // Runs while reading/paused (normal cadence) and once more during stop().
    if (this.state !== "reading" && this.state !== "paused" && this.state !== "stopping") return;
    const { sessionId, sessionKey, tracker } = this;
    if (!sessionId || !sessionKey || sessionKey.destroyed || !tracker) return;

    const engagedSeconds = tracker.engagedSeconds;
    const elapsedSeconds = (Date.now() - this.startedAtMs) / 1000;
    const next = computeCumulative({
      engagedSeconds,
      elapsedSeconds,
      ratePerSec: this.cfg.ratePerSec,
      budget: this.cfg.budget,
      previousCumulative: this.cumulative,
    });
    if (next <= this.cumulative) return;

    this.signing = true;
    try {
      const signature = await sessionKey.signVoucher({
        contractAddress: this.cfg.contractAddress,
        chainId: this.cfg.chainId,
        message: { sessionId, cumulativeAmount: next },
      });
      this.cumulative = next;

      const record: VoucherRecord = {
        sessionId,
        cumulativeAmount: next,
        signature,
        signer: sessionKey.address,
        engagedSeconds,
        elapsedSeconds,
        index: this.voucherIndex++,
        signedAt: Date.now(),
      };
      this.lastVoucher = record;
      this.emit("voucher:signed", record);

      if (this.cfg.onVoucher) {
        try {
          await this.cfg.onVoucher(record);
        } catch (error) {
          this.emit("error", { phase: "deliver", error });
        }
      }

      if (isBudgetExhausted(this.cumulative, this.cfg.budget) && this.state !== "stopping") {
        this.signing = false;
        await this.stop("budget-exhausted");
        return;
      }
    } catch (error) {
      this.emit("error", { phase: "voucher", error });
    } finally {
      this.signing = false;
    }
  }
}

function validateConfig(c: AttentionMeterConfig): void {
  if (!c.contractAddress) throw new Error("contractAddress is required");
  if (!Number.isInteger(c.chainId) || c.chainId <= 0) throw new Error("chainId must be a positive integer");
  if (!c.provider || typeof c.provider.request !== "function") {
    throw new Error("provider must be an EIP-1193 provider");
  }
  if (c.articleId < 0n || c.articleId > UINT64_MAX) throw new Error("articleId is out of uint64 range");
  if (c.ratePerSec <= 0n || c.ratePerSec > UINT64_MAX) throw new Error("ratePerSec must be in (0, uint64]");
  if (c.budget <= 0n || c.budget > UINT96_MAX) throw new Error("budget must be in (0, uint96]");
  if (c.ratePerSec > c.budget) throw new Error("ratePerSec cannot exceed budget");
  if (c.sessionKeyStorage && c.sessionKeyStorage !== "memory") {
    throw new Error(`sessionKeyStorage "${c.sessionKeyStorage}" is not supported in v0.1 (memory only)`);
  }
  if ((c.voucherIntervalMs ?? 1) <= 0) throw new Error("voucherIntervalMs must be > 0");
  if ((c.idleTimeoutMs ?? 1) <= 0) throw new Error("idleTimeoutMs must be > 0");
}
