import type { Address, Hex } from "viem";

/** Minimal EIP-1193 provider surface (e.g. `window.ethereum`). */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Where the ephemeral session key is kept.
 * v0.1 supports `"memory"` only — the key never touches disk and is dropped on
 * `stop()` / page unload. A reload therefore ends the session's ability to sign
 * new vouchers; the reader recovers any unspent budget on-chain via
 * `closeSession` / `readerReclaim`.
 */
export type SessionKeyStorage = "memory";

export interface AttentionMeterConfig {
  /** Deployed `AttentionStream` address. */
  contractAddress: Address;
  /** Chain id the contract lives on (e.g. `10143` for Monad testnet). */
  chainId: number;
  /** Article being read (on-chain `uint64`). */
  articleId: bigint;
  /** Streaming rate in payment-token base units per second (on-chain `uint64`). */
  ratePerSec: bigint;
  /** Total escrow and hard spend cap for the session, in base units (on-chain `uint96`). */
  budget: bigint;
  /** Injected wallet, used for token approval + `openSession` + `closeSession`. */
  provider: Eip1193Provider;
  /** ERC-20 used by the contract. Read from `AttentionStream.token()` when omitted. */
  paymentToken?: Address;

  /** Element whose scroll/visibility scopes "reading". Defaults to the document. */
  target?: HTMLElement;

  /** How often to sign a voucher while engaged. Default `5000`. */
  voucherIntervalMs?: number;
  /** No user input for this long ⇒ idle, accrual pauses. Default `30000`. */
  idleTimeoutMs?: number;
  /**
   * Require scroll progress within this window to stay engaged on a scrollable
   * target (anti-AFK for long reads). Default `0` (disabled).
   */
  scrollStallTimeoutMs?: number;

  /** Called for every signed voucher — deliver it to the author's collector. */
  onVoucher?: (voucher: VoucherRecord) => void | Promise<void>;

  /** Session-key storage strategy. Default and only supported value: `"memory"`. */
  sessionKeyStorage?: SessionKeyStorage;

  /** Skip the ERC-20 allowance check/approval (host already approved). Default `false`. */
  skipApproval?: boolean;
}

export interface VoucherRecord {
  /** `bytes32` session id from the `SessionOpened` event. */
  sessionId: Hex;
  /** Running total owed to the author — monotonic, `<= budget`. */
  cumulativeAmount: bigint;
  /** 65-byte EIP-712 signature from the ephemeral session key. */
  signature: Hex;
  /** Address of the ephemeral session key that produced `signature`. */
  signer: Address;
  /** Engaged seconds represented by this voucher. */
  engagedSeconds: number;
  /** Wall-clock seconds since `openSession` (for the on-chain rate-cap check). */
  elapsedSeconds: number;
  /** 0-based index within the session. */
  index: number;
  /** Client timestamp (ms) when signed. */
  signedAt: number;
}

export type PauseReason = "hidden" | "blur" | "idle" | "scroll-stall" | "manual";
export type EndReason = "manual" | "budget-exhausted" | "error";

export type MeterEventMap = {
  "session:started": {
    sessionId: Hex;
    signer: Address;
    txHash: Hex;
    startedAt: number;
    budget: bigint;
    ratePerSec: bigint;
  };
  "voucher:signed": VoucherRecord;
  "session:paused": { reason: PauseReason; at: number; engagedSeconds: number };
  "session:resumed": { at: number; engagedSeconds: number };
  "session:ended": {
    sessionId: Hex;
    reason: EndReason;
    finalCumulative: bigint;
    engagedSeconds: number;
    txHash?: Hex;
  };
  error: { phase: "start" | "voucher" | "deliver" | "stop"; error: unknown };
};

export type MeterEventName = keyof MeterEventMap;

export type MeterState = "idle" | "starting" | "reading" | "paused" | "stopping" | "ended";
