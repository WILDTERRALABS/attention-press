import type { Hex } from "viem";
import type { ChainAdapter } from "./types.js";
import type { VoucherStore } from "./store.js";

export interface SettleLoopOptions {
  intervalMs: number;
  minDelta: bigint;
  log?: (msg: string, extra?: unknown) => void;
}

export interface TickResult {
  settled: number;
  failed: number;
  skipped: number;
  finalized: number;
}

/**
 * Periodically walks pending sessions and calls `settle` for any whose latest
 * voucher is ahead of on-chain `claimed`. Closing is two-phase: a session with
 * `closeInitiatedAt != 0` is still settled until `closeInitiatedAt +
 * challengeWindow`, then this loop calls `finalizeSession` so the reader is
 * refunded without having to come back.
 */
export class SettleLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  /** Sessions observed in their challenge window; finalized once it elapses. */
  private readonly closing = new Set<Hex>();

  constructor(
    private readonly chain: ChainAdapter,
    private readonly store: VoucherStore,
    private readonly opts: SettleLoopOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<TickResult> {
    if (this.inFlight) return { settled: 0, failed: 0, skipped: 0, finalized: 0 };
    this.inFlight = true;
    let settled = 0;
    let failed = 0;
    let skipped = 0;
    let finalized = 0;
    try {
      for (const { sessionId, voucher } of this.store.pending()) {
        const session = await this.chain.getSession(sessionId);
        if (!session) {
          this.store.markDone(sessionId);
          this.closing.delete(sessionId);
          continue;
        }
        this.store.setSessionMeta(sessionId, {
          author: session.author,
          reader: session.reader,
          articleId: session.articleId,
        });

        if (!session.open) {
          this.store.markSettled(sessionId, session.claimed);
          this.store.markDone(sessionId);
          this.closing.delete(sessionId);
          continue;
        }
        if (session.closeInitiatedAt > 0n) this.closing.add(sessionId);

        if (voucher.cumulativeAmount <= session.claimed) {
          this.store.markSettled(sessionId, session.claimed);
          continue;
        }
        if (voucher.cumulativeAmount - session.claimed < this.opts.minDelta) {
          skipped++;
          continue;
        }

        try {
          const tx = await this.chain.settle(sessionId, voucher.cumulativeAmount, voucher.signature);
          this.store.markSettled(sessionId, voucher.cumulativeAmount);
          this.store.metrics.settleSent++;
          settled++;
          this.opts.log?.("settled", {
            sessionId,
            cumulativeAmount: voucher.cumulativeAmount.toString(),
            tx,
          });
        } catch (err) {
          this.store.metrics.settleFailed++;
          failed++;
          this.opts.log?.("settle failed", { sessionId, err: String(err) });
        }
      }

      finalized = await this.finalizeElapsed();
    } finally {
      this.inFlight = false;
      this.store.snapshot();
    }
    return { settled, failed, skipped, finalized };
  }

  /** Finalize any tracked closing session whose challenge window has elapsed. */
  private async finalizeElapsed(): Promise<number> {
    if (this.closing.size === 0) return 0;
    const now = await this.chain.latestBlockTimestamp();
    const window = await this.chain.getChallengeWindow();
    let finalized = 0;

    for (const sessionId of [...this.closing]) {
      const session = await this.chain.getSession(sessionId);
      if (!session || !session.open) {
        this.store.markSettled(sessionId, session?.claimed ?? 0n);
        this.store.markDone(sessionId);
        this.closing.delete(sessionId);
        continue;
      }
      if (session.closeInitiatedAt === 0n) {
        this.closing.delete(sessionId); // reopened? shouldn't happen — stop tracking
        continue;
      }
      if (now <= session.closeInitiatedAt + window) continue; // window still open

      try {
        const tx = await this.chain.finalizeSession(sessionId);
        this.store.markSettled(sessionId, session.claimed);
        this.store.markDone(sessionId);
        this.closing.delete(sessionId);
        this.store.metrics.finalizeSent++;
        finalized++;
        this.opts.log?.("finalized", { sessionId, tx });
      } catch (err) {
        this.store.metrics.finalizeFailed++;
        this.opts.log?.("finalize failed", { sessionId, err: String(err) });
      }
    }
    return finalized;
  }
}
