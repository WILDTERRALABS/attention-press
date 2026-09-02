import { defineChain, type Address } from "viem";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://testnet-rpc.monad.xyz";
export const COLLECTOR_URL = process.env.NEXT_PUBLIC_COLLECTOR_URL ?? "http://localhost:8787";

export const ARTICLE_REGISTRY = (process.env.NEXT_PUBLIC_ARTICLE_REGISTRY ??
  "0x34C48D04c566131aEa6DBA8E2727423A55e38aaa") as Address;
export const ATTENTION_STREAM = (process.env.NEXT_PUBLIC_ATTENTION_STREAM ??
  "0xcf3B5EB6dF13Fd6a7D2df26E57549653bB700a9F") as Address;

export const DEFAULT_RATE_PER_SEC = BigInt(
  process.env.NEXT_PUBLIC_DEFAULT_RATE_PER_SEC ?? "1000000000000000",
);
export const DEFAULT_BUDGET = BigInt(process.env.NEXT_PUBLIC_DEFAULT_BUDGET ?? "600000000000000000");

export const monadTestnet = defineChain({
  id: CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "MonadScan", url: "https://testnet.monadscan.com" } },
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
] as const;
