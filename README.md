# attention-press

Reader-funded, pay-per-second publishing on the Monad blockchain.

Anyone can publish an article. Readers stream a micro-payment to the author for
every second they actually spend reading. Engaging pieces hold attention longer
and earn more — quality compounds, volume does not.

**Status:** contracts + reader SDK + collector + web frontend, all with test
suites (12 · 26 · 32 · 5 passing). Contracts deployed to Monad testnet and
exercised end-to-end (smoke test + live collector run).

## Packages

| Package | What |
|---|---|
| [`packages/contracts`](packages/contracts) | `ArticleRegistry` + `AttentionStream` (Hardhat, Solidity 0.8.24) |
| [`packages/reader-sdk`](packages/reader-sdk) | `AttentionMeter` — client-side engagement tracking + EIP-712 voucher signing (TypeScript, viem) |
| [`packages/collector`](packages/collector) | Author-side HTTP service — ingests vouchers, validates them like the contract, auto-`settle`s on an interval (Fastify, viem) |
| [`packages/web`](packages/web) | Next.js frontend — discovery ranked by real spend, publish flow, reader view with a live spend meter (Next 15, wagmi) |

---

## Why this design needs no anti-sybil machinery

The usual "read-to-earn" project has to fight bots because a third party (an ad
pool, token emissions) funds the payout, so fake attention extracts real value.

Here **the reader funds the stream**, and value flows reader → author. Work
through a publisher trying to farm their own article with a bot fleet:

- The bot wallets must hold the real payment token. That token comes from the
  publisher.
- Streaming it "to themselves" routes it back to the publisher **minus the
  protocol fee and minus gas** on `openSession` / `settle` / `closeSession`.
- Net result for the publisher-controlled cluster: a guaranteed loss equal to
  `fee + gas`, for every fake second.

So fake attention is strictly unprofitable by construction. The only way value
reaches an author is a distinct party choosing to spend their own money to keep
reading — which is exactly the signal we want. Wallet connect is all the identity
this needs. (`test/attention.test.ts` asserts the self-funded case nets `-fee`.)

What remains is a **UX** problem, not a security one: stop billing the reader the
moment they leave the page. The reader is the party motivated to enforce that,
and the contract backstops them with a hard budget cap, a rate cap, and a
timeout refund.

---

## Architecture

```
                 ┌────────────────────┐
   publish  ───▶ │  ArticleRegistry   │  author, contentHash, metadataURI
                 └────────────────────┘
                           ▲ authorOf / isActive
                           │
  reader   ─ openSession ─▶ ┌────────────────────┐ ─ settle(voucher) ─▶ author
  (escrow budget)          │  AttentionStream   │
  reader   ─ closeSession ▶ │  (payment channel) │ ─ fee ─▶ treasury
                           └────────────────────┘
       ▲ EIP-712 vouchers (off-chain, ~1 per 5s)      │
       │                                              ▼
  browser session key  ◀───────────  reader SDK: focus + scroll → sign
```

### Content layer (off-chain)
The article body lives on IPFS/Arweave. Only `contentHash` (a digest binding the
article id to an exact body) and a `metadataURI` pointer go on-chain.

### `ArticleRegistry.sol`
- `publish(contentHash, uri) → id` — permissionless, ids start at 1.
- `retire(id)` / `updateMetadata(id, uri)` / `transferAuthorship(id, to)` — current author only.
- `authorOf(id)` / `isActive(id)` — read surface used by the stream.

### `AttentionStream.sol` — one payment channel per reading session
A session is opened and closed on-chain (~2 transactions total, regardless of
reading time); everything in between is off-chain signed vouchers.

| Function | Caller | Effect |
|---|---|---|
| `openSession(articleId, budget, ratePerSec, signer)` | reader | Escrows `budget`. Registers `signer`, an **ephemeral key generated in the reader's browser**, so vouchers don't need a wallet popup. Returns `sessionId`. |
| `settle(id, cumulativeAmount, sig)` | anyone (author's collector) | Verifies the EIP-712 voucher, ratchets `claimed` up to `cumulativeAmount`, pays `delta − fee` to the author and `fee` to the treasury. |
| `closeSession(id, cumulativeAmount, sig)` | reader | Settles the final voucher, then refunds `budget − claimed`. |
| `readerReclaim(id)` | reader | After `sessionTimeout` (default 3d): recover all unclaimed escrow, no voucher needed. |

**Voucher** (EIP-712): `Voucher(bytes32 sessionId, uint256 cumulativeAmount)`,
signed by the session key. `cumulativeAmount` is the running total owed — always
increasing, always ≤ `budget`.

**On-chain guards**
- **Monotonic:** `cumulativeAmount ≥ claimed`.
- **Budget cap:** `cumulativeAmount ≤ budget` — the reader's hard spend limit.
- **Rate cap:** `cumulativeAmount ≤ ratePerSec × (elapsed + 1s)`, elapsed clamped
  to `MAX_ACCRUAL_WINDOW` (7d). Bounds a stolen/buggy session key to the
  advertised rate rather than the whole budget at once.
- `ReentrancyGuard` on every money path; checks-effects-interactions
  (`claimed` / `open` written before transfers); `SafeERC20`; `Ownable` admin.
- Fee ≤ `MAX_FEE_BPS` (10%); `sessionTimeout` ∈ [1d, 30d].

**Discovery stats** (`articleEarned`, `articleReaderSeconds`, `articleSessions`)
are emitted for indexers. Rank feeds on `articleEarned` / distinct payers — raw
session and second counts can be inflated by a self-funded reader (they just pay
the fee to do it).

---

## Threat model

| Vector | Mitigation |
|---|---|
| Publisher farms own article with bots | Economically self-defeating: loses `fee + gas` per fake second. No identity system needed. |
| Malicious/greedy frontend keeps signing after the reader leaves | Hard `budget` cap + on-chain `ratePerSec` cap + reader closes the session. UI ships a small default budget and short session length. |
| Session key stolen from the browser | Can drain at most `budget`, and no faster than `ratePerSec`. Reader can `closeSession` immediately to cut losses. |
| Reader withholds the final voucher to underpay | Author's collector receives vouchers in real time and calls `settle` to ratchet `claimed` up; the reader can never close below `claimed`. Residual risk = one voucher interval (~5s) if the reader closes in the same block — keep cadence tight. |
| Reader abandons the session, locking escrow | `readerReclaim` after `sessionTimeout`. The author had the full window to `settle` held vouchers. |
| Reentrancy / ERC-20 hooks | `nonReentrant` + effects-before-interactions + `SafeERC20`. |
| Fee-on-transfer / rebasing payment token | **Not supported.** Use a standard ERC-20 (stablecoin or WMON). Documented, enforced by choosing the token at deploy. |
| Signature replay across sessions/chains | Voucher binds `sessionId` (unique per reader/article/chain/contract) inside the EIP-712 domain (name, version, chainId, verifyingContract). |
| Admin key compromise | Admin can only move `treasury`, `protocolFeeBps` (≤10%), `sessionTimeout` (1–30d). It cannot touch live sessions, escrow, or `claimed`. Use a multisig/timelock as owner. |
| Plagiarism / spam publishing | Out of scope for v1. See Roadmap: stake-to-publish + slashing. |

**Known limitations**
- Unidirectional channel: the last un-settled increment is the author's risk if
  the reader closes first. Bounded by voucher cadence.
- Client-side attention detection (focus/scroll) is advisory. It protects the
  *reader's* wallet; it is not a payout oracle and does not need to be trusted by
  the author.
- No on-chain "reading proof". Time-on-page is inherently client-reported; the
  economic model is what makes that acceptable.
- Not yet audited. Do not use on mainnet with real value.

---

## Client-side integration

Use [`@attention-press/reader-sdk`](packages/reader-sdk) — its `AttentionMeter`
opens the session, tracks engagement (focus / scroll / idle / `visibilitychange`),
signs a voucher every ~5s with an in-memory ephemeral key, and closes the session
on `stop()`.

```ts
import { AttentionMeter } from "@attention-press/reader-sdk";

const meter = new AttentionMeter({
  contractAddress, chainId: 10143, articleId, ratePerSec, budget,
  provider: window.ethereum,
  target: document.querySelector("article") ?? undefined,
  onVoucher: (v) => fetch("/api/vouchers", { method: "POST", body: JSON.stringify(v) }),
});
meter.on("voucher:signed", ({ cumulativeAmount }) => updateSpendMeter(cumulativeAmount));
await meter.start();
// … reader reads …
await meter.stop();
```

---

## Getting started

```bash
npm install                     # workspace root — installs every package
npm test                        # contracts 12 · reader-sdk 26 · collector 32 · web 5
npm run build                   # hardhat compile + tsup + tsc + next build
```

Run the stack against Monad testnet:

```bash
# 1. collector — POSTs vouchers become settle() txs
cd packages/collector && cp .env.example .env   # set SETTLER_PRIVATE_KEY
npm run build && npm start                      # :8787

# 2. frontend
cd packages/web && cp .env.example .env.local   # addresses default to the deployed contracts
npm run build -w @attention-press/reader-sdk    # web consumes its dist/
npm run dev -w @attention-press/web             # http://localhost:3000
```

Deploy to Monad testnet:

```bash
cd packages/contracts
cp .env.example .env             # set DEPLOYER_KEY, verify MONAD_RPC_URL / chainId
npm run deploy:monad
```

The deploy script deploys `AttentionStream` with the deployer as treasury. It
reuses `ARTICLE_REGISTRY` and `PAYMENT_TOKEN` when set (the current testnet
deployment points at canonical **WMON**, `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541`),
and otherwise deploys a fresh `ArticleRegistry` / `MockERC20`.

> Verify the current Monad testnet RPC URL and chain id before deploying — the
> values in `packages/contracts/hardhat.config.ts` (chainId `10143`,
> `https://testnet-rpc.monad.xyz`) are placeholders to confirm.

---

## Layout

```
packages/
  contracts/
    contracts/
      ArticleRegistry.sol        registry of published articles
      AttentionStream.sol        per-session payment channel + fees + timeouts
      interfaces/IArticleRegistry.sol
      mocks/MockERC20.sol        test/testnet payment token
    scripts/deploy.ts
    test/attention.test.ts       registry, voucher settlement, caps, timeout, self-farm
  reader-sdk/
    src/
      AttentionMeter.ts          orchestrator + typed events
      engagement/                visibility + focus + idle + scroll tracking
      session/                   ephemeral key, EIP-712 voucher, accrual math
      chain/                     openSession / closeSession via EIP-1193
    test/                        voucher digest, accrual clamps, engagement, lifecycle
  collector/
    src/
      routes.ts                  POST /vouchers, GET /sessions/:id, /authors/:a/earnings
      voucher.ts                 EIP-712 recover + contract-mirroring validation
      settleLoop.ts              interval task: settle sessions with pending vouchers
      chain.ts store.ts config.ts
    test/                        voucher validation, store snapshot, settle loop, HTTP routes
  web/
    src/app/                     / (discovery), /publish, /article/[id]
    src/components/              ReaderClient (mounts AttentionMeter) + SpendMeter, PublishForm
    src/lib/                     chain defs/abis, wagmi config, data-URI metadata, formatting
```

### Deployed (Monad testnet, chainId 10143)

See [`packages/contracts/deployments/monadTestnet.json`](packages/contracts/deployments/monadTestnet.json).
`AttentionStream` `0xca364C7eC309c293216B43f6C069Ee9c5b6959cc` ·
`ArticleRegistry` `0x34C48D04c566131aEa6DBA8E2727423A55e38aaa` ·
payment token = WMON `0xFb8bf4c1CC7a94c73D209a149eA2AbEa852BC541`.

---

## Roadmap

1. ~~**Reader SDK**~~ — done: `@attention-press/reader-sdk`.
2. ~~**Author collector service**~~ — done: `@attention-press/collector`.
3. ~~**Next.js frontend**~~ — done: `@attention-press/web` (discovery, publish, reader view + live spend meter). Follow-ups: real IPFS pin, per-read rate/budget controls.
4. **Indexer/subgraph** — leaderboards, per-article retention curves ("engagement", not just clicks).
5. **Stake-to-publish** — refundable deposit, slashable by a plagiarism/DMCA challenge, to price out spam.
6. **Native MON support** — a wrapper so readers can stream MON directly without approving an ERC-20.
7. **Splitters** — `transferAuthorship` to a 0xSplits-style contract for co-authors.
8. **Audit** before any mainnet deployment.
```
