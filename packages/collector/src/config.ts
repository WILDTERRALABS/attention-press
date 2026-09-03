import { isAddress, isHex, type Address, type Hex } from "viem";
import type { CollectorConfig } from "./types.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const required = (key: string): string => {
    const v = env[key];
    if (!v || v.trim() === "") throw new Error(`missing required env var ${key}`);
    return v.trim();
  };

  const streamAddress = required("ATTENTION_STREAM_ADDRESS");
  if (!isAddress(streamAddress)) throw new Error("ATTENTION_STREAM_ADDRESS is not a valid address");

  const registryAddress = required("ARTICLE_REGISTRY_ADDRESS");
  if (!isAddress(registryAddress)) throw new Error("ARTICLE_REGISTRY_ADDRESS is not a valid address");

  const articleActionsAddress = required("ARTICLE_ACTIONS_ADDRESS");
  if (!isAddress(articleActionsAddress)) throw new Error("ARTICLE_ACTIONS_ADDRESS is not a valid address");

  const settlerPrivateKey = required("SETTLER_PRIVATE_KEY");
  if (!isHex(settlerPrivateKey) || settlerPrivateKey.length !== 66) {
    throw new Error("SETTLER_PRIVATE_KEY must be 0x-prefixed 32-byte hex");
  }

  const chainId = Number(required("CHAIN_ID"));
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error("CHAIN_ID must be a positive integer");

  return {
    port: Number(env.PORT ?? 8787),
    rpcUrl: required("RPC_URL"),
    chainId,
    streamAddress: streamAddress as Address,
    registryAddress: registryAddress as Address,
    articleActionsAddress: articleActionsAddress as Address,
    settlerPrivateKey: settlerPrivateKey as Hex,
    settleIntervalMs: Number(env.SETTLE_INTERVAL_MS ?? 30_000),
    minSettleDelta: BigInt(env.MIN_SETTLE_DELTA ?? "0"),
    dataDir: env.DATA_DIR?.trim() || ".data",
    maxAccrualWindowSec: BigInt(env.MAX_ACCRUAL_WINDOW_SEC ?? String(7 * 24 * 60 * 60)),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "http://localhost:3000")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    articleActionsFromBlock: BigInt(env.ARTICLE_ACTIONS_FROM_BLOCK ?? "0"),
    replyIndexIntervalMs: Number(env.REPLY_INDEX_INTERVAL_MS ?? 15_000),
    // QuickNode's Monad testnet caps eth_getLogs at 1000 blocks; the public RPC
    // at 100. 900 clears QuickNode with no wasted shrink; the indexer halves to
    // a 100 floor for anything stricter.
    logQueryRange: Number(env.LOG_QUERY_RANGE ?? 900),
  };
}
