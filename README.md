# attention-press

**Get paid for attention, not clicks.** A publishing protocol on the Monad
blockchain where readers pay authors *per second of genuine reading time* —
no ads, no subscriptions, no view-count metrics to game.

Anyone publishes an article. A reader escrows a small budget, and while they're
actually reading — tab focused, scrolling, not idle — the client streams
micro-payments to the author. Leave early and the unspent budget is refunded.
The author's payout is a direct function of aggregate real reading time, so
better writing holds attention longer and earns more. That's the whole
mechanism.

> **Status:** testnet-only build for **Monad's Metropolis hackathon**, built with
> AI pair-programming (see [Built with AI](#built-with-ai)). Contracts, reader
> SDK, collector, and web frontend are all implemented and tested
> (**37 · 30 · 74 · 24** = 165 passing), and the three contracts are deployed to
> Monad testnet and exercised end-to-end (smoke + live canary). **Not audited.
> Not for real funds.** See [Known limitations](#known-limitations).

---

## How it works

1. **Escrow.** The reader calls `openSession` on `AttentionStream`, locking a
   budget (pay rate × a time cap) in WMON — a hard ceiling on what the session
   can ever cost.
2. **Ephemeral key.** The client generates a throwaway signing key that lives
   only in browser memory for the session. No wallet popup per voucher.
3. **Vouchers.** Every ~5s the client signs a tiny EIP-712 message — "session X
   has now earned Y total" — monotonic and capped by `ratePerSec × elapsed`.
4. **Settlement.** The **collector** submits the latest voucher on-chain,
   ratcheting the author's claimable balance up. `settle` is permissionless, so
   the author never depends on a single party's goodwill.
5. **Close & refund.** On leave, `closeSession` settles the final voucher and
   returns the unspent budget. If the collector vanishes, `readerReclaim` lets
   the reader recover the remainder unilaterally after a timeout.

**Why no anti-sybil machinery is needed:** the reader funds the stream. A
publisher pointing a bot fleet at their own article is their own wallet paying
their own wallet, minus the protocol fee and gas every session — a guaranteed
loss per fake second. Value only reaches an author when a distinct party spends
their own money to keep reading. Wallet connect is all the identity this needs.
(`packages/contracts/test/attention.test.ts` asserts the self-funded case nets
`−fee`.)

**Content gating:** article bodies are AES-256-GCM encrypted client-side before
publishing; only the ciphertext + a short plaintext preview go on-chain, and
`contentHash` still commits to the plaintext. The collector custodies the
per-article key and releases it only after verifying an open on-chain session
for that reader + article.

**Beyond streaming**, a separate `ArticleActions` contract adds discrete paid
engagement — like / favorite (1 WMON → author), reply (2 WMON → author, text in
the event log), dislike (1 WMON → treasury only), and tips (any amount →
author). All exact-amount WMON, no funds ever custodied by the contract.

---

## Why Monad

The core mechanism — settling a payment channel every few seconds for every open
reading session — only makes sense on a chain where a `settle` transaction costs
a rounding error and confirms in well under a second.

- **~400 ms blocks, ~800 ms finality.** `openSession` / `settle` / `closeSession`
  feel synchronous: the reader watches the spend meter move and their refund land
  almost immediately, instead of staring at a pending spinner.
- **Low, predictable gas.** Gas per `settle` is negligible next to the WMON being
  streamed, so the *protocol fee* — not gas — stays the dominant cost of a fake
  read. That's what makes the reader-funded anti-sybil argument actually hold.
- **High throughput + parallel execution.** Many concurrent readers, each
  emitting a voucher/settle cadence, don't contend for blockspace.
- **Full EVM + Ethereum-RPC compatibility.** Hardhat, OpenZeppelin, viem and
  wagmi all worked unmodified. The only Monad-specific accommodations are using
  canonical **WMON** as the payment token and tuning the collector's
  `eth_getLogs` range for the reply indexer.

---

## Monorepo

npm workspaces. `npm install` at the root installs everything.

| Package | What it is |
|---|---|
| **[`packages/contracts`](packages/contracts)** | Solidity 0.8.24 / Hardhat. `ArticleRegistry` (author + contentHash + metadata pointer), `AttentionStream` (per-session payment channel, escrow + EIP-712 vouchers + fee + timeouts), `ArticleActions` (like/dislike/favorite/reply/tip). OpenZeppelin 5.1, `SafeERC20` + `ReentrancyGuard` + `Pausable`. Slither + solhint clean. See [`SECURITY.md`](packages/contracts/SECURITY.md). |
| **[`packages/reader-sdk`](packages/reader-sdk)** | `@attention-press/reader-sdk` — client library. `AttentionMeter` opens the session, tracks engagement (focus / scroll / idle / `visibilitychange`), signs a voucher every ~5s with an in-memory ephemeral key, closes the session on `stop()`. TypeScript, viem, tsup (ESM + CJS + d.ts). |
| **[`packages/collector`](packages/collector)** | `@attention-press/collector` — author-side HTTP service (Fastify + viem). Ingests vouchers → validates them exactly as the contract would → auto-`settle`s on an interval. Also: custodies content-decryption keys, serves signed author bios + per-reader stats, and **indexes `ArticleActions.Replied` logs** (backfill + poll) behind `GET /articles/:id/replies`. |
| **[`packages/web`](packages/web)** | `@attention-press/web` — Next.js 15 / wagmi frontend. Discovery (Articles ranked by real spend, Authors ranked by earnings), publish flow (3 rate tiers, client-side encryption), reader view (session-gated decryption + live spend meter + one-click **Wrap MON**), `/profile/[address]`, and a **paid-actions bar** with a one-time standing WMON allowance ("approve once, then react freely"). |

---

## Deployed — Monad testnet (chainId `10143`)

Canonical source: [`packages/contracts/deployments/monadTestnet.json`](packages/contracts/deployments/monadTestnet.json).

| Contract | Address |
|---|---|
| `ArticleRegistry` | `0x34C48D04c566131aEa6DBA8E2727423A55e38aaa` |
| `AttentionStream` | `0xca364C7eC309c293216B43f6C069Ee9c5b6959cc` |
| `ArticleActions` | `0x04D91BC0bF42EF2bD639B565b5f53644930E80AC` (deploy block 59017209) |
| WMON (payment token) | `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541` |
| treasury / deployer | `0x67dEf124555dDAABb406D4c79e65218F952f3668` |

Protocol fee and action fee are both **250 bps (2.5%)**. The web app falls back
to these addresses in code (env only overrides); the collector requires them
explicitly in its `.env`.

---

## Run it locally

```bash
npm install       # workspace root
npm test          # contracts 37 · reader-sdk 30 · collector 74 · web 24
npm run build     # hardhat compile + tsup + tsc + next build
```

The contracts are **already deployed to testnet**, so a local run is just the
collector + web against those addresses. Order matters: **collector → web**
(the web reader view needs the collector for settlement and key release).

### 1. Collector — `packages/collector`

```bash
cd packages/collector
cp .env.example .env      # then edit .env
npm run build && npm start   # :8787   (or: npm run dev)
```

| Env | Notes |
|---|---|
| `RPC_URL`, `CHAIN_ID` | `10143`. Use a **dedicated endpoint** (QuickNode / Alchemy) — the public RPC rate-limits and caps `eth_getLogs` at 100 blocks. |
| `ATTENTION_STREAM_ADDRESS`, `ARTICLE_REGISTRY_ADDRESS`, `ARTICLE_ACTIONS_ADDRESS` | the deployed addresses above |
| `SETTLER_PRIVATE_KEY` | **dedicated gas-only wallet**, used by nothing else — the settle loop signs `settle` txs from it, and any other use races the nonce. `settle` is permissionless, so this key never holds fees. (The reply indexer only reads.) |
| `ARTICLE_ACTIONS_FROM_BLOCK` | start block for the one-time reply backfill (`59015000` is safely before the deploy; idempotent) |
| `SETTLE_INTERVAL_MS`, `MIN_SETTLE_DELTA`, `REPLY_INDEX_INTERVAL_MS`, `LOG_QUERY_RANGE`, `DATA_DIR`, `MAX_ACCRUAL_WINDOW_SEC`, `ALLOWED_ORIGINS` | have working defaults; see `.env.example` |

### 2. Web — `packages/web`

```bash
cd packages/web
cp .env.example .env.local     # contract addresses have in-code defaults
npm run build -w @attention-press/reader-sdk   # web consumes its dist/
npm run dev -w @attention-press/web            # http://localhost:3000
```

Set `NEXT_PUBLIC_RPC_URL` to a dedicated endpoint — the browser fans out many
`eth_call`s per render and trips the public RPC's rate limit. Wallet: any
injected EIP-1193 wallet on Monad Testnet; the app prompts a network switch and
offers a one-click Wrap MON → WMON.

### Deploy the contracts yourself — `packages/contracts`

```bash
cd packages/contracts
cp .env.example .env          # set DEPLOYER_KEY, MONAD_RPC_URL
npm run deploy:monad          # ArticleRegistry (or reuse) + AttentionStream
npm run deploy-actions:monad  # ArticleActions, against the JSON from the step above
```

Other scripts: `preflight:monad` (whoami), `list-articles:monad`,
`retire:monad` (`IDS=1,2,3 …`), `actions-smoke:monad` (live canary — all five
actions + revert cases against the deployed contract with a throwaway wallet),
`lint:sol`, `slither`.

---

## Tests

```bash
npm test                              # all four packages
npm test -w @attention-press/contracts   # 37 — registry, voucher settlement, caps,
                                         #      timeout, self-farm, ArticleActions
                                         #      (fees, dedup, SelfAction, reentrancy,
                                         #      reply cap, atomicity), independence
npm test -w @attention-press/reader-sdk  # 30 — voucher digest, accrual clamps,
                                         #      engagement model, meter lifecycle
npm test -w @attention-press/collector   # 74 — voucher validation, store snapshot,
                                         #      settle loop, HTTP routes, reply indexer
                                         #      (backfill windows, idempotency, adaptive
                                         #      getLogs range, reorg buffer)
npm test -w @attention-press/web         # 24 — format + metadata + rate + author helpers
```

Contracts also pass `slither .` (zero findings on `ArticleActions`) and
`solhint` (zero errors). `packages/web` `next lint` is not configured — CI relies
on `tsc` + `next build` + vitest.

---

## Known limitations

This is a hackathon build. What's deliberately out of scope for this version:

**Not audited.** No professional audit, no formal verification, no bug bounty,
no on-chain monitoring, no timelocked-multisig owner (the admin is an EOA on
testnet). `packages/contracts/SECURITY.md` documents the full gap. Do not deploy
to mainnet with real value on the strength of this repo.

**Content storage.** Article metadata (encrypted body + preview) is a base64
`data:` URI stored directly in `ArticleRegistry.metadataURI` — not IPFS/Arweave.
Articles published with an `ipfs://` pointer render a placeholder; a gateway
fetch + a real pin path are future work.

**Trusted collector.** The collector operator can decrypt any article whose key
it holds, and the reply index is served by a single collector. Run your own for
confidentiality. A threshold/DKG key-release scheme removes the trust assumption
and slots into the same endpoint.

**Collector internals.** In-memory store + JSON snapshot (no DB); no auth or rate
limiting on `POST /vouchers`; sequential one-at-a-time settlement; polling, not
event subscriptions.

**Payment channel is unidirectional.** The last un-settled voucher increment
(≤ one ~5s interval) is the author's risk if the reader closes in the same
block. Bounded by voucher cadence, not eliminated.

**Attention detection is advisory.** Focus/scroll/idle tracking protects the
*reader's* wallet; it is not a payout oracle and the author does not have to
trust it. There is no on-chain "reading proof" — time-on-page is inherently
client-reported, and the economic model is what makes that acceptable.

**No indexer.** Discovery multicalls every article id `1..nextId-1` — fine for
tens of articles, needs a subgraph for scale.

**Tokens.** Fee-on-transfer / rebasing tokens are not supported (`token` is
immutable, set to WMON at deploy). Sock-puppet inflation of like/favorite counts
is possible but costs the action fee per fake action.

---

## Architecture

```
                 ┌────────────────────┐
   publish  ───▶ │  ArticleRegistry   │  author, contentHash, metadataURI (data: URI)
                 └────────────────────┘
                     ▲ authorOf / isActive
        ┌────────────┼───────────────────────────┐
        │            │                           │
  reader ─ openSession ▶ ┌──────────────────┐ ─ settle(voucher) ─▶ author
  (escrow budget)        │  AttentionStream │
  reader ─ closeSession ▶ │  payment channel │ ─ fee ─▶ treasury
                         └──────────────────┘
        ▲ EIP-712 vouchers (off-chain, ~1 / 5s)   │
        │                                         ▼
   browser session key ◀──── reader SDK: focus + scroll → sign
                                                  │
  reader ─ like/dislike/favorite/reply/tip ▶ ┌──────────────────┐
                                            │  ArticleActions  │ ─▶ author / treasury
                                            └──────────────────┘
                                                  │ Replied logs
                                                  ▼
                                    collector reply indexer → GET /articles/:id/replies
```

**On-chain guards (`AttentionStream`):** monotonic `cumulativeAmount`, budget
cap (reader's hard limit), rate cap (`ratePerSec × (elapsed + 1s)`, elapsed
clamped to `MAX_ACCRUAL_WINDOW` = 7d), `ReentrancyGuard` + checks-effects-
interactions on every money path, `SafeERC20`, fee ≤ 10%, `sessionTimeout` ∈
[1d, 30d], EIP-712 domain binds chainId + verifyingContract.

**`ArticleActions`:** never custodies the token (every payment is a direct
`transferFrom(payer → recipient)`); `nonReentrant` + `whenNotPaused` +
checks-effects-interactions on all five actions; `msg.sender != authorOf(id)`;
one like / dislike / favorite per `(wallet, article)`; `treasury` **immutable**;
constant prices; `actionFeeBps` ≤ 10% (re-checked in the setter);
`MAX_REPLY_BYTES` = 1000, `MAX_REPLIES_PER_ARTICLE` = 100 000.

---

## Roadmap

Done: reader SDK · collector (auto-settle + key custody + reply index) · web
(discovery, publish, reader view, profiles, paid actions + standing allowance).

Next:

1. **Real IPFS/Arweave** pinning + gateway fetch for article bodies.
2. **Subgraph / indexer** — leaderboards, per-article retention curves.
3. **Threshold key release** — remove the collector as a trusted decryptor.
4. **Native MON** streaming without an ERC-20 approve step.
5. **Stake-to-publish** — refundable deposit, slashable by a plagiarism/DMCA
   challenge, to price out spam.
6. **Splitters** — `transferAuthorship` to a 0xSplits-style contract.
7. **Audit** + timelocked-multisig ownership before any mainnet deployment.

---

## Technology stack

| Layer | Stack |
|---|---|
| Contracts | Solidity 0.8.24 · Hardhat · OpenZeppelin Contracts 5.1 · `evmVersion: paris` · Hardhat/Chai tests · Slither + solhint |
| Reader SDK | TypeScript · viem · tsup (ESM + CJS + d.ts) · vitest + happy-dom |
| Collector | Node ≥ 20 · TypeScript · Fastify 5 · `@fastify/cors` · viem · vitest |
| Web | Next.js 15 (App Router) · React 19 · wagmi v2 (injected connector) · viem · TanStack Query · `marked` + DOMPurify · Inter + Roboto Mono |
| Chain | Monad testnet (chainId 10143) · WMON payment token · Multicall3 |
| Infra | QuickNode RPC · Vercel (web) · Railway (collector) |

## Attribution

Third-party code and services used (all under permissive licenses):

- **OpenZeppelin Contracts 5.1.0** (MIT) — `SafeERC20`, `ReentrancyGuard`,
  `Ownable`, `Pausable`, and EIP-712 utilities in the Solidity contracts.
- **viem** (MIT), **wagmi** (MIT), **@tanstack/react-query** (MIT) — chain
  interaction and React wallet/query hooks.
- **Next.js** (MIT), **React** (MIT) — the web frontend.
- **Fastify** + **@fastify/cors** (MIT) — the collector HTTP service.
- **tsup** (MIT) — the reader-SDK bundler. **vitest** (MIT) — tests.
- **marked** (MIT) + **DOMPurify** (Apache-2.0 / MPL-2.0) — Markdown render +
  sanitize in the reader view.
- **Hardhat** + `@nomicfoundation/hardhat-toolbox` (MIT) — contract build/test.
- **Slither**, **solhint** (AGPL-3.0 / MIT) — static analysis, dev-only, not shipped.
- **Multicall3** (`0xcA11bde05977b3631167028862bE2a173976CA11`) — canonical
  batched-read contract, used by the web app.
- **WMON** (`0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541`) — canonical Wrapped
  Monad on testnet, used as the payment token (not our code).
- **Inter** and **Roboto Mono** (SIL Open Font License) — via Google Fonts.

## Built with AI

attention-press was built with **Claude Code** (Anthropic's agentic coding tool)
as an AI pair-programmer. The architecture, the Solidity contracts, the reader
SDK, the collector service, and the Next.js frontend were designed and written in
collaboration with the AI agent across the build window. All contract code was
reviewed, unit- and adversarially-tested (**165 tests** across the four
packages), and run through Slither + solhint — see
[`packages/contracts/SECURITY.md`](packages/contracts/SECURITY.md) for the
honest security gap. Commits are co-authored `Claude Sonnet`.

## License

[MIT](LICENSE) © 2026 WILDTERRALABS.
