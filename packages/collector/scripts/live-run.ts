import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  keccak256,
  parseEther,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { VOUCHER_TYPES, voucherDomain } from "../src/voucher.js";

/**
 * End-to-end exercise of a running collector against Monad testnet:
 *   publish -> openSession -> POST voucher -> (collector auto-settles) -> POST
 *   higher voucher -> (settles again) -> closeSession -> read /metrics + earnings.
 *
 * Uses SETTLER_PRIVATE_KEY (from packages/collector/.env) as operator + author;
 * a fresh wallet is the reader so its txs never contend for the settler nonce.
 *
 * Start the collector first (see README), then: npx tsx scripts/live-run.ts
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

const RPC_URL = process.env.RPC_URL ?? "https://testnet-rpc.monad.xyz";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 10143);
const COLLECTOR_URL = process.env.COLLECTOR_URL ?? "http://localhost:8787";
const STREAM = (process.env.ATTENTION_STREAM_ADDRESS ?? "") as Address;
const KEY = (process.env.SETTLER_PRIVATE_KEY ?? "") as Hex;
if (!STREAM || !KEY) {
  throw new Error("set ATTENTION_STREAM_ADDRESS and SETTLER_PRIVATE_KEY in packages/collector/.env");
}

const deployments = JSON.parse(
  readFileSync(join(__dirname, "../../contracts/deployments/monadTestnet.json"), "utf8"),
) as { contracts: { ArticleRegistry: Address; paymentToken: Address } };
const REGISTRY = deployments.contracts.ArticleRegistry;
const TOKEN = deployments.contracts.paymentToken;

const abi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }, // WMON wrap
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "publish", stateMutability: "nonpayable", inputs: [{ name: "contentHash", type: "bytes32" }, { name: "uri", type: "string" }], outputs: [{ name: "id", type: "uint256" }] },
  { type: "event", name: "Published", inputs: [{ name: "id", type: "uint256", indexed: true }, { name: "author", type: "address", indexed: true }, { name: "contentHash", type: "bytes32", indexed: false }, { name: "metadataURI", type: "string", indexed: false }] },
  { type: "function", name: "openSession", stateMutability: "nonpayable", inputs: [{ name: "articleId", type: "uint64" }, { name: "budget", type: "uint96" }, { name: "ratePerSec", type: "uint64" }, { name: "signer", type: "address" }], outputs: [{ name: "id", type: "bytes32" }] },
  { type: "event", name: "SessionOpened", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "articleId", type: "uint256", indexed: true }, { name: "reader", type: "address", indexed: true }, { name: "author", type: "address", indexed: false }, { name: "signer", type: "address", indexed: false }, { name: "budget", type: "uint96", indexed: false }, { name: "ratePerSec", type: "uint64", indexed: false }] },
  { type: "function", name: "closeSession", stateMutability: "nonpayable", inputs: [{ name: "id", type: "bytes32" }, { name: "cumulativeAmount", type: "uint96" }, { name: "sig", type: "bytes" }], outputs: [] },
  {
    type: "function", name: "sessions", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "reader", type: "address" }, { name: "signer", type: "address" }, { name: "author", type: "address" },
      { name: "budget", type: "uint96" }, { name: "claimed", type: "uint96" }, { name: "articleId", type: "uint64" },
      { name: "startTime", type: "uint64" }, { name: "ratePerSec", type: "uint64" }, { name: "open", type: "bool" },
    ],
  },
] as const;

const chain = {
  id: CHAIN_ID,
  name: `chain-${CHAIN_ID}`,
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;

const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const operator = privateKeyToAccount(KEY);
const operatorWallet = createWalletClient({ account: operator, chain, transport: http(RPC_URL) });
const reader = privateKeyToAccount(generatePrivateKey());
const readerWallet = createWalletClient({ account: reader, chain, transport: http(RPC_URL) });
const sessionKey = privateKeyToAccount(generatePrivateKey());

const RATE = 1_000_000_000_000_000n; // 1e15 base units / sec
const BUDGET = 30n * RATE;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

async function api(method: "GET" | "POST", path: string, body?: unknown) {
  const res = await fetch(`${COLLECTOR_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

function signVoucher(sessionId: Hex, cumulativeAmount: bigint): Promise<Hex> {
  return sessionKey.signTypedData({
    domain: voucherDomain(CHAIN_ID, STREAM),
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: { sessionId, cumulativeAmount },
  });
}

async function readSession(sessionId: Hex) {
  const raw = (await pub.readContract({
    address: STREAM,
    abi,
    functionName: "sessions",
    args: [sessionId],
  })) as unknown;
  const s = raw as
    | readonly [Address, Address, Address, bigint, bigint, bigint, bigint, bigint, boolean]
    | { claimed: bigint; open: boolean };
  const claimed = Array.isArray(s) ? s[4] : (s as { claimed: bigint }).claimed;
  const open = Array.isArray(s) ? s[8] : (s as { open: boolean }).open;
  return { claimed: BigInt(claimed as bigint), open: Boolean(open) };
}

async function waitForClaimed(sessionId: Hex, target: bigint, timeoutMs: number): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { claimed } = await readSession(sessionId);
    if (claimed >= target) return claimed;
    await sleep(3000);
  }
  throw new Error(`timed out waiting for on-chain claimed >= ${target}`);
}

async function tokenBalance(who: Address): Promise<bigint> {
  return (await pub.readContract({ address: TOKEN, abi, functionName: "balanceOf", args: [who] })) as bigint;
}

// Monad testnet executes state effects a little after a tx's receipt lands, so
// poll for balances to appear before a dependent transaction reads them.
async function waitForBalance(who: Address, target: bigint, label: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await tokenBalance(who)) >= target) return;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${label} balance >= ${target}`);
}

function eventArg(logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[], addr: Address, name: string, key: string) {
  for (const lg of logs) {
    if (lg.address.toLowerCase() !== addr.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi, data: lg.data, topics: lg.topics as [Hex, ...Hex[]] });
      if (d.eventName === name) return (d.args as Record<string, unknown>)[key];
    } catch {
      /* not our event */
    }
  }
  return undefined;
}

async function main() {
  console.log(`collector:  ${COLLECTOR_URL}`);
  console.log(`operator (author+settler): ${operator.address}`);
  console.log(`reader (fresh):            ${reader.address}`);
  console.log(`session key:               ${sessionKey.address}`);

  const health = await api("GET", "/health");
  console.log(`\nGET /health -> ${health.status} ${j(health.body)}`);
  if (health.status !== 200) throw new Error("collector /health not OK — is it running?");

  // Operator wraps MON -> WMON and sends it to the reader (keeps funding txs on
  // the settled operator account); reader just gets MON for gas.
  const wrap = BUDGET * 2n;
  console.log(`\nfunding reader 0.3 MON gas + ${wrap} WMON (operator-wrapped) ...`);
  await pub.waitForTransactionReceipt({
    hash: await operatorWallet.sendTransaction({ to: reader.address, value: parseEther("0.3"), chain: null }),
  });
  await pub.waitForTransactionReceipt({
    hash: await operatorWallet.writeContract({ address: TOKEN, abi, functionName: "deposit", value: wrap, chain: null }),
  });
  await waitForBalance(operator.address, wrap, "operator WMON");
  await pub.waitForTransactionReceipt({
    hash: await operatorWallet.writeContract({ address: TOKEN, abi, functionName: "transfer", args: [reader.address, wrap], chain: null }),
  });
  await waitForBalance(reader.address, wrap, "reader WMON");

  const contentHash = keccak256(toHex(`live-run ${Date.now()}`));
  const pubRc = await pub.waitForTransactionReceipt({
    hash: await operatorWallet.writeContract({ address: REGISTRY, abi, functionName: "publish", args: [contentHash, "ipfs://live-run"], chain: null }),
  });
  const articleId = eventArg(pubRc.logs, REGISTRY, "Published", "id") as bigint | undefined;
  if (articleId === undefined) throw new Error("no Published event");
  console.log(`published article ${articleId} (author ${operator.address})`);

  await pub.waitForTransactionReceipt({
    hash: await readerWallet.writeContract({ address: TOKEN, abi, functionName: "approve", args: [STREAM, BUDGET], chain: null }),
  });
  const openRc = await pub.waitForTransactionReceipt({
    hash: await readerWallet.writeContract({ address: STREAM, abi, functionName: "openSession", args: [articleId, BUDGET, RATE, sessionKey.address], chain: null }),
  });
  const sessionId = eventArg(openRc.logs, STREAM, "SessionOpened", "id") as Hex | undefined;
  if (!sessionId) throw new Error("no SessionOpened event");
  console.log(`openSession ${sessionId}`);

  // --- voucher 1 -> collector should auto-settle ---
  await sleep(7000);
  const v1 = 3n * RATE;
  const p1 = await api("POST", "/vouchers", { sessionId, cumulativeAmount: v1.toString(), signature: await signVoucher(sessionId, v1) });
  console.log(`\nPOST /vouchers v1=${v1} -> ${p1.status} ${j(p1.body)}`);
  if (p1.status !== 202) throw new Error("collector rejected v1");
  console.log("waiting for collector to settle v1 on-chain ...");
  console.log(`  claimed = ${await waitForClaimed(sessionId, v1, 120_000)}  (target ${v1})`);
  console.log(`  GET /sessions/:id -> ${j((await api("GET", `/sessions/${sessionId}`)).body)}`);

  // --- voucher 2 -> settles again ---
  await sleep(6000);
  const v2 = 6n * RATE;
  const p2 = await api("POST", "/vouchers", { sessionId, cumulativeAmount: v2.toString(), signature: await signVoucher(sessionId, v2) });
  console.log(`\nPOST /vouchers v2=${v2} -> ${p2.status} ${j(p2.body)}`);
  if (p2.status !== 202) throw new Error("collector rejected v2");
  console.log("waiting for collector to settle v2 on-chain ...");
  console.log(`  claimed = ${await waitForClaimed(sessionId, v2, 120_000)}  (target ${v2})`);

  // --- reader closes (v2 already settled, so this just finalizes + refunds) ---
  await pub.waitForTransactionReceipt({
    hash: await readerWallet.writeContract({ address: STREAM, abi, functionName: "closeSession", args: [sessionId, v2, await signVoucher(sessionId, v2)], chain: null }),
  });
  console.log(`\ncloseSession -> session.open = ${(await readSession(sessionId)).open}`);

  await sleep(8000); // let the collector observe the close on its next tick
  console.log(`\nGET /metrics                 -> ${j((await api("GET", "/metrics")).body)}`);
  console.log(`GET /authors/${operator.address}/earnings -> ${j((await api("GET", `/authors/${operator.address}/earnings`)).body)}`);
  console.log(`GET /sessions/:id            -> ${j((await api("GET", `/sessions/${sessionId}`)).body)}`);

  console.log(`\n✅ live collector run complete`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
