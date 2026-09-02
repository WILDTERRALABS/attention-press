import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Account, Address, Hex } from "viem";
import type { ChainAdapter, OnChainSession } from "../src/types.js";
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

export class FakeChain implements ChainAdapter {
  readonly chainId = CHAIN_ID;
  readonly streamAddress = STREAM;
  readonly settlerAddress = "0x00000000000000000000000000000000000000BB" as Address;

  sessions = new Map<string, OnChainSession>();
  ts = 2_000_000n;
  settleCalls: Array<{ id: Hex; amount: bigint; sig: Hex }> = [];
  settleError: Error | null = null;
  blockError: Error | null = null;

  async getSession(id: Hex): Promise<OnChainSession | null> {
    return this.sessions.get(id) ?? null;
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
}
