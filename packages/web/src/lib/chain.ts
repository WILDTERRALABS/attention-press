import { defineChain, type Address } from "viem";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 10143);
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://testnet-rpc.monad.xyz";
export const COLLECTOR_URL = process.env.NEXT_PUBLIC_COLLECTOR_URL ?? "http://localhost:8787";

export const ARTICLE_REGISTRY = (process.env.NEXT_PUBLIC_ARTICLE_REGISTRY ??
  "0x34C48D04c566131aEa6DBA8E2727423A55e38aaa") as Address;
export const ATTENTION_STREAM = (process.env.NEXT_PUBLIC_ATTENTION_STREAM ??
  "0x29f111C6eadbe298865b8bF814d5fdafDB47A0AA") as Address;

/**
 * ArticleActions (like / dislike / favorite / reply / tip). Deployed separately
 * via `scripts/deploy-actions.ts` (see deployments/monadTestnet.json). Override
 * with NEXT_PUBLIC_ARTICLE_ACTIONS; empty string => the actions bar renders a
 * "not configured" note and makes no calls.
 */
export const ARTICLE_ACTIONS = (process.env.NEXT_PUBLIC_ARTICLE_ACTIONS ??
  "0x42F229857be71a239393F0eE218aE2A0823FaCa5") as Address | "";

/** Fixed action prices, mirrored from ArticleActions.sol (base units, 18 dp). */
export const ACTION_PRICES = {
  like: 1_000000000000000000n,
  dislike: 1_000000000000000000n,
  favorite: 1_000000000000000000n,
  reply: 2_000000000000000000n,
} as const;

/** Mirror of ArticleActions.MAX_REPLY_BYTES. */
export const MAX_REPLY_BYTES = 1_000;

/**
 * Standing WMON allowances — approve once, then every reading session / reaction
 * is a single confirmation instead of an approve + action pair. Bounded, not
 * infinite: an allowance is only ever drawn when the reader themselves opens a
 * session or taps an action (every transfer is `transferFrom(msg.sender, …)`),
 * neither contract is upgradeable, and ArticleActions prices are constants.
 * Tune freely — these are the only knobs.
 */
export const STANDING_ALLOWANCE_STREAM = 10_000000000000000000n; // 10 WMON — ~1 deep / 2 standard sessions
export const MIN_ALLOWANCE_STREAM = 5_000000000000000000n; //      re-prompt below 5 WMON (~1 standard session)
export const STANDING_ALLOWANCE_ACTIONS = 10_000000000000000000n; // 10 WMON — ~10 likes / 5 replies + tips
export const MIN_ALLOWANCE_ACTIONS = 5_000000000000000000n; //      re-prompt below 5 WMON

/**
 * Article floated to the top of discovery regardless of earnings (the project
 * explainer). Override with NEXT_PUBLIC_PINNED_ARTICLE_ID; 0 / unset => none.
 */
export const PINNED_ARTICLE_ID = (() => {
  const raw = process.env.NEXT_PUBLIC_PINNED_ARTICLE_ID ?? "8";
  try {
    const v = BigInt(raw);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
})();

/** Canonical Wrapped MON (WMON) on Monad testnet — the payment token. */
export const WMON = "0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541" as Address;

/**
 * Pay-rate tiers the author picks at publish time. Stored in article metadata as
 * the `perMinute` string (WMON/min); `ratePerSec` and the session budget are
 * derived from it (see lib/rate.ts).
 *
 * Placeholder testnet economics — tune freely. Standard = 1 WMON/min, so a
 * full 5-minute session costs 5 WMON and the spend meter moves visibly.
 */
export const RATE_TIERS = [
  { id: "casual", label: "Casual", perMinute: "0.4" },
  { id: "standard", label: "Standard", perMinute: "1" },
  { id: "deep", label: "Deep read", perMinute: "2" },
] as const;

export type RateTierId = (typeof RATE_TIERS)[number]["id"];
export const DEFAULT_TIER_ID: RateTierId = "standard";

/** Session budget = rate × this (a 5-minute hard cap on a single reading session). */
export const SESSION_SECONDS_CAP = 300n;

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
  { type: "function", name: "challengeWindow", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  {
    type: "function",
    name: "closeInitiatedAt",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ type: "uint64" }],
  },
  {
    // Public getter for the `sessions` mapping — used to resume the two-phase
    // close flow after a page reload (React state for a live session is gone).
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
    // Phase 1 of the two-phase close. Normally the reader SDK sends this; the UI
    // also sends it directly when resuming a still-open session after a reload.
    type: "function",
    name: "closeSession",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "finalizeSession",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "event",
    name: "SessionClosed",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "articleId", type: "uint256", indexed: true },
      { name: "totalPaid", type: "uint96", indexed: false },
      { name: "refunded", type: "uint96", indexed: false },
      { name: "duration", type: "uint64", indexed: false },
    ],
  },
] as const;

/** Fallback if the on-chain `challengeWindow()` read isn't in yet (contract default). */
export const CHALLENGE_WINDOW_SEC = 15 * 60;

export const articleActionsAbi = [
  ...(["likeCount", "dislikeCount", "favoriteCount", "replyCount", "totalTipped"] as const).map(
    (name) =>
      ({
        type: "function",
        name,
        stateMutability: "view",
        inputs: [{ name: "articleId", type: "uint256" }],
        outputs: [{ type: "uint256" }],
      }) as const,
  ),
  ...(["hasLiked", "hasDisliked", "hasFavorited"] as const).map(
    (name) =>
      ({
        type: "function",
        name,
        stateMutability: "view",
        inputs: [
          { name: "articleId", type: "uint256" },
          { name: "actor", type: "address" },
        ],
        outputs: [{ type: "bool" }],
      }) as const,
  ),
  { type: "function", name: "actionFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  ...(["like", "dislike", "favorite"] as const).map(
    (name) =>
      ({
        type: "function",
        name,
        stateMutability: "nonpayable",
        inputs: [{ name: "articleId", type: "uint256" }],
        outputs: [],
      }) as const,
  ),
  {
    type: "function",
    name: "reply",
    stateMutability: "nonpayable",
    inputs: [
      { name: "articleId", type: "uint256" },
      { name: "text", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "tip",
    stateMutability: "nonpayable",
    inputs: [
      { name: "articleId", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "Replied",
    inputs: [
      { name: "articleId", type: "uint256", indexed: true },
      { name: "actor", type: "address", indexed: true },
      { name: "index", type: "uint256", indexed: true },
      { name: "toAuthor", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "text", type: "string", indexed: false },
    ],
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
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
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
