import { defineChain, type Address } from "viem";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://testnet-rpc.monad.xyz";
export const COLLECTOR_URL = process.env.NEXT_PUBLIC_COLLECTOR_URL ?? "http://localhost:8787";

export const ARTICLE_REGISTRY = (process.env.NEXT_PUBLIC_ARTICLE_REGISTRY ??
  "0x34C48D04c566131aEa6DBA8E2727423A55e38aaa") as Address;
export const ATTENTION_STREAM = (process.env.NEXT_PUBLIC_ATTENTION_STREAM ??
  "0xca364C7eC309c293216B43f6C069Ee9c5b6959cc") as Address;

/** Canonical Wrapped MON (WMON) on Monad testnet — the payment token. */
export const WMON = "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541" as Address;

/**
 * Pay-rate tiers the author picks at publish time. Stored in article metadata as
 * the `perMinute` string (WMON/min); `ratePerSec` and the session budget are
 * derived from it (see lib/rate.ts).
 *
 * Placeholder testnet economics — tune freely. Standard = 1 WMON/min, so a
 * 10-minute read costs 10 WMON and the spend meter moves visibly.
 */
export const RATE_TIERS = [
  { id: "casual", label: "Casual", perMinute: "0.4" },
  { id: "standard", label: "Standard", perMinute: "1" },
  { id: "deep", label: "Deep read", perMinute: "2" },
] as const;

export type RateTierId = (typeof RATE_TIERS)[number]["id"];
export const DEFAULT_TIER_ID: RateTierId = "standard";

/** Session budget = rate × this (a 10-minute hard cap on a single reading session). */
export const SESSION_SECONDS_CAP = 600n;

export const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "MonadScan", url: "https://testnet.monadscan.com" } },
  contracts: {
    // Canonical Multicall3 — lets viem collapse many reads into one eth_call
    // so the public RPC's rate limit isn't tripped.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

export const articleRegistryAbi = [
  { type: "function", name: "nextId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "articles",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "author", type: "address" },
      { name: "contentHash", type: "bytes32" },
      { name: "createdAt", type: "uint64" },
      { name: "retired", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "metadataURI",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "publish",
    stateMutability: "nonpayable",
    inputs: [
      { name: "contentHash", type: "bytes32" },
      { name: "uri", type: "string" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "event",
    name: "Published",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "author", type: "address", indexed: true },
      { name: "contentHash", type: "bytes32", indexed: false },
      { name: "metadataURI", type: "string", indexed: false },
    ],
  },
] as const;

export const attentionStreamAbi = [
  { type: "function", name: "token", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "articleEarned",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "articleReaderSeconds",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "articleSessions",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "uint32" }],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  // WETH9-style: wrap native MON 1:1 into WMON / unwrap back.
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [{ name: "amount", type: "uint256" }],
    outputs: [],
  },
] as const;
