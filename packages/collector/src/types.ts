import type { Address, Hex } from "viem";

/** `AttentionStream.sessions(id)` decoded, plus `closeInitiatedAt(id)`. */
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
  /** 0 while live; the timestamp `closeSession` was called (challenge window running). */
  closeInitiatedAt: bigint;
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
  articleActionsAddress: Address;
  settlerPrivateKey: Hex;
  settleIntervalMs: number;
  minSettleDelta: bigint;
  dataDir: string;
  /** Mirror of the contract's MAX_ACCRUAL_WINDOW (seconds). */
  maxAccrualWindowSec: bigint;
  /** Browser origins allowed to call the API (CORS). */
  allowedOrigins: string[];
  /** Block to start the reply backfill from (≈ the ArticleActions deploy block). */
  articleActionsFromBlock: bigint;
  /** How often the reply indexer polls for new logs. */
  replyIndexIntervalMs: number;
  /** Max block span per `eth_getLogs` call (shrinks adaptively on provider error). */
  logQueryRange: number;
}

export interface OnChainArticle {
  author: Address;
  contentHash: Hex;
  retired: boolean;
}

/** One decoded `ArticleActions.Replied` log. */
export interface RepliedLog {
  articleId: bigint;
  actor: Address;
  /** The contract's per-article reply index — a stable idempotency key. */
  index: bigint;
  toAuthor: bigint;
  fee: bigint;
  text: string;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
}

/** A reply as stored/served by the collector index (all JSON-safe). */
export interface ReplyRecord {
  articleId: string;
  index: number;
  actor: Address;
  text: string;
  toAuthor: string;
  fee: string;
  blockNumber: number;
  /** Unix seconds of the block, or 0 if not resolved. */
  blockTime: number;
  txHash: Hex;
}

export interface ReplyPage {
  items: ReplyRecord[];
  total: number;
  nextCursor: number | null;
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
  /** Send phase-2 `finalizeSession(id)` (refund the reader) and wait for the receipt. */
  finalizeSession(sessionId: Hex): Promise<Hex>;
  /** `challengeWindow()` seconds — cached after the first read. */
  getChallengeWindow(): Promise<bigint>;
  // --- reply indexer ---
  latestBlockNumber(): Promise<bigint>;
  /** `ArticleActions.Replied` logs in [fromBlock, toBlock]. May throw if the range is too wide for the provider. */
  getRepliedLogs(fromBlock: bigint, toBlock: bigint): Promise<RepliedLog[]>;
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
}

export interface ServerContext {
  chain: ChainAdapter;
  store: import("./store.js").VoucherStore;
  maxAccrualWindowSec: bigint;
}
