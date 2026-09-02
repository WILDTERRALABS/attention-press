import {
  createPublicClient,
  createWalletClient,
  http,
  zeroAddress,
  type Address,
  type Hex,
  type PrivateKeyAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainAdapter, CollectorConfig, OnChainSession } from "./types.js";

export const streamAbi = [
  {
    type: "function",
    name: "sessions",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "reader", type: "address" },
      { name: "signer", type: "address" },
      { name: "author", type: "address" },
      { name: "budget", type: "uint96" },
      { name: "claimed", type: "uint96" },
      { name: "articleId", type: "uint64" },
      { name: "startTime", type: "uint64" },
      { name: "ratePerSec", type: "uint64" },
      { name: "open", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "settle",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "cumulativeAmount", type: "uint96" },
      { name: "sig", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export class ViemChainAdapter implements ChainAdapter {
  readonly chainId: number;
  readonly streamAddress: Address;
  readonly settlerAddress: Address;

  private readonly pub: ReturnType<typeof createPublicClient>;
  private readonly wallet: ReturnType<typeof createWalletClient>;
  private readonly account: PrivateKeyAccount;

  constructor(cfg: CollectorConfig) {
    this.chainId = cfg.chainId;
    this.streamAddress = cfg.streamAddress;
    const account = privateKeyToAccount(cfg.settlerPrivateKey);
    this.account = account;
    this.settlerAddress = account.address;

    const chain = {
      id: cfg.chainId,
      name: `chain-${cfg.chainId}`,
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [cfg.rpcUrl] } },
    } as const;

    this.pub = createPublicClient({ chain, transport: http(cfg.rpcUrl) });
    this.wallet = createWalletClient({ chain, account, transport: http(cfg.rpcUrl) });
  }

  async getSession(sessionId: Hex): Promise<OnChainSession | null> {
    const raw = (await this.pub.readContract({
      address: this.streamAddress,
      abi: streamAbi,
      functionName: "sessions",
      args: [sessionId],
    })) as unknown;

    const t = raw as
      | readonly [Address, Address, Address, bigint, bigint, bigint, bigint, bigint, boolean]
      | {
          reader: Address;
          signer: Address;
          author: Address;
          budget: bigint;
          claimed: bigint;
          articleId: bigint;
          startTime: bigint;
          ratePerSec: bigint;
          open: boolean;
        };

    const s = Array.isArray(t)
      ? {
          reader: t[0],
          signer: t[1],
          author: t[2],
          budget: t[3],
          claimed: t[4],
          articleId: t[5],
          startTime: t[6],
          ratePerSec: t[7],
          open: t[8],
        }
      : (t as Exclude<typeof t, readonly unknown[]>);

    if (s.reader === zeroAddress) return null;
    return {
      reader: s.reader,
      signer: s.signer,
      author: s.author,
      budget: BigInt(s.budget),
      claimed: BigInt(s.claimed),
      articleId: BigInt(s.articleId),
      startTime: BigInt(s.startTime),
      ratePerSec: BigInt(s.ratePerSec),
      open: Boolean(s.open),
    };
  }

  async latestBlockTimestamp(): Promise<bigint> {
    const block = await this.pub.getBlock({ blockTag: "latest" });
    return block.timestamp;
  }

  async settle(sessionId: Hex, cumulativeAmount: bigint, signature: Hex): Promise<Hex> {
    const hash = await this.wallet.writeContract({
      account: this.account,
      address: this.streamAddress,
      abi: streamAbi,
      functionName: "settle",
      args: [sessionId, cumulativeAmount, signature],
      chain: null,
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }
}
