import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account, Address, Hex } from "viem";
import type { ChainAdapter, OnChainArticle, OnChainSession, RepliedLog } from "../src/types.js";
import { VOUCHER_TYPES, voucherDomain } from "../src/voucher.js";

export const STREAM = "0x00000000000000000000000000000000000000AA" as Address;
export const CHAIN_ID = 10143;
export const MAX_ACCRUAL_WINDOW = BigInt(7 * 24 * 60 * 60);

export function sid(byte = "ab"): Hex {
  return ("0x" + byte.repeat(32)) as Hex;
}

export function newAccount(): Account {
  return privateKeyToAccount(generatePrivateKey());
}

export async function signVoucher(
  account: Account,
  sessionId: Hex,
  cumulativeAmount: bigint,
  opts: { chainId?: number; stream?: Address } = {},
): Promise<Hex> {
  if (!account.signTypedData) throw new Error("account cannot sign");
  return account.signTypedData({
    domain: voucherDomain(opts.chainId ?? CHAIN_ID, opts.stream ?? STREAM),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: { sessionId, cumulativeAmount },
  });
}

export function makeSession(over: Partial<OnChainSession> = {}): OnChainSession {
  return {
    reader: "0x1111111111111111111111111111111111111111",
    signer: "0x2222222222222222222222222222222222222222",
    author: "0x3333333333333333333333333333333333333333",
    budget: 1_000_000n,
    claimed: 0n,
    articleId: 1n,
    startTime: 1_000n,
    ratePerSec: 1_000n,
    open: true,
    ...over,
  };
}

export function makeRepliedLog(over: Partial<RepliedLog> = {}): RepliedLog {
  return {
    articleId: 1n,
    actor: "0x5555555555555555555555555555555555555555",
    index: 0n,
    toAuthor: 1_950_000_000_000_000_000n,
    fee: 50_000_000_000_000_000n,
    text: "a reply",
    blockNumber: 100n,
    txHash: ("0x" + "ab".repeat(32)) as Hex,
    logIndex: 0,
    ...over,
  };
}

export class FakeChain implements ChainAdapter {
  readonly chainId = CHAIN_ID;
  readonly streamAddress = STREAM;
  readonly settlerAddress = "0x00000000000000000000000000000000000000BB" as Address;

  sessions = new Map<string, OnChainSession>();
  ts = 2_000_000n;
  articles = new Map<string, OnChainArticle>();
  settleCalls: Array<{ id: Hex; amount: bigint; sig: Hex }> = [];
  settleError: Error | null = null;
  blockError: Error | null = null;

  // --- reply indexer fakes ---
  head = 1_000n;
  repliedLogs: RepliedLog[] = [];
  /** getRepliedLogs throws if (toBlock - fromBlock + 1) exceeds this. */
  maxLogRange = Number.POSITIVE_INFINITY;
  getLogsCalls: Array<{ from: bigint; to: bigint }> = [];
  blockTimes = new Map<bigint, bigint>();
  blockTimeCalls: bigint[] = [];

  async getSession(id: Hex): Promise<OnChainSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async getArticle(id: bigint): Promise<OnChainArticle | null> {
    return this.articles.get(id.toString()) ?? null;
  }

  async latestBlockTimestamp(): Promise<bigint> {
    if (this.blockError) throw this.blockError;
    return this.ts;
  }

  async settle(id: Hex, amount: bigint, sig: Hex): Promise<Hex> {
    if (this.settleError) throw this.settleError;
    this.settleCalls.push({ id, amount, sig });
    const s = this.sessions.get(id);
    if (s) s.claimed = amount;
    return ("0x" + "cc".repeat(32)) as Hex;
  }

  async latestBlockNumber(): Promise<bigint> {
    return this.head;
  }

  async getRepliedLogs(fromBlock: bigint, toBlock: bigint): Promise<RepliedLog[]> {
    this.getLogsCalls.push({ from: fromBlock, to: toBlock });
    if (Number(toBlock - fromBlock + 1n) > this.maxLogRange) {
      throw new Error(`range ${fromBlock}-${toBlock} exceeds provider limit`);
    }
    return this.repliedLogs
      .filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
      .sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
  }

  async getBlockTimestamp(blockNumber: bigint): Promise<bigint> {
    this.blockTimeCalls.push(blockNumber);
    return this.blockTimes.get(blockNumber) ?? 1_700_000_000n + blockNumber;
  }
}
