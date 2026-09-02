import type { Address, Hex } from "viem";

/** `AttentionStream.sessions(id)` decoded. */
export interface OnChainSession {
  reader: Address;
  signer: Address;
  author: Address;
  budget: bigint;
  claimed: bigint;
  articleId: bigint;
  startTime: bigint;
  ratePerSec: bigint;
  open: boolean;
}

export interface VoucherInput {
  sessionId: Hex;
  cumulativeAmount: bigint;
  signature: Hex;
}

export interface StoredVoucher extends VoucherInput {
  receivedAt: number;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: string; code: "bad_request" | "conflict" };

export interface CollectorConfig {
  port: number;
  rpcUrl: string;
  chainId: number;
  streamAddress: Address;
  registryAddress: Address;
  settlerPrivateKey: Hex;
  settleIntervalMs: number;
  minSettleDelta: bigint;
  dataDir: string;
  /** Mirror of the contract's MAX_ACCRUAL_WINDOW (seconds). */
  maxAccrualWindowSec: bigint;
  /** Browser origins allowed to call the API (CORS). */
  allowedOrigins: string[];
}

export interface OnChainArticle {
  author: Address;
  contentHash: Hex;
  retired: boolean;
}

/** The chain operations the collector needs; real impl uses viem, tests fake it. */
export interface ChainAdapter {
  readonly chainId: number;
  readonly streamAddress: Address;
  readonly settlerAddress: Address;
  getSession(sessionId: Hex): Promise<OnChainSession | null>;
  getArticle(articleId: bigint): Promise<OnChainArticle | null>;
  latestBlockTimestamp(): Promise<bigint>;
  /** Send `settle(sessionId, cumulativeAmount, signature)` and wait for the receipt. */
  settle(sessionId: Hex, cumulativeAmount: bigint, signature: Hex): Promise<Hex>;
}

export interface ServerContext {
  chain: ChainAdapter;
  store: import("./store.js").VoucherStore;
  maxAccrualWindowSec: bigint;
}
