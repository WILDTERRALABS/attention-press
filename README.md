# attention-press

Reader-funded, pay-per-second publishing on the Monad blockchain.

Anyone can publish an article. Readers stream a micro-payment to the author for
every second they actually spend reading. Engaging pieces hold attention longer
and earn more — quality compounds, volume does not.

**Status:** smart-contract core + full test suite. No frontend/SDK yet (see
[Roadmap](#roadmap)).

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

## Client-side voucher signing (reference)

```ts
import { Wallet, JsonRpcProvider, Contract } from "ethers";

// 1. One-time per session: create an ephemeral key, keep it in memory only.
const sessionKey = Wallet.createRandom();

// 2. openSession(articleId, budget, ratePerSec, sessionKey.address) via the reader's wallet.
//    Read `sessionId` from the SessionOpened event.

// 3. While the tab is focused AND the reader is scrolling/progressing, tick every ~5s:
const domain = {
  name: "AttentionStream",
  version: "1",
  chainId,
  verifyingContract: streamAddress,
};
const types = {
  Voucher: [
    { name: "sessionId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint256" },
  ],
};

let cumulative = 0n;
function tick(secondsElapsedSinceLastTick: bigint) {
  cumulative += ratePerSec * secondsElapsedSinceLastTick; // clamp to budget
  return sessionKey.signTypedData(domain, types, { sessionId, cumulativeAmount: cumulative });
}
// POST each signed voucher to the author's collector. On unload / "done reading",
// call closeSession(sessionId, cumulative, latestSig) from the reader's wallet.
```

Pause the ticker on `visibilitychange`, prolonged idle, or when scroll progress
stalls — that is how "engagement" maps to payment.

---

## Getting started

```bash
npm install
npm run build      # hardhat compile  (solc 0.8.24, evm target: paris)
npm test           # 12 passing
```

Deploy to Monad testnet:

```bash
cp .env.example .env    # set DEPLOYER_KEY, verify MONAD_RPC_URL / chainId
npm run deploy:monad
```

The deploy script publishes `ArticleRegistry`, a `MockERC20` (unless
`PAYMENT_TOKEN` is set), and `AttentionStream` with the deployer as treasury.

> Verify the current Monad testnet RPC URL and chain id before deploying — the
> values in `hardhat.config.ts` (chainId `10143`, `https://testnet-rpc.monad.xyz`)
> are placeholders to confirm.

---

## Layout

```
contracts/
  ArticleRegistry.sol          registry of published articles
  AttentionStream.sol          per-session payment channel + fees + timeouts
  interfaces/IArticleRegistry.sol
  mocks/MockERC20.sol          test/testnet payment token
scripts/deploy.ts
test/attention.test.ts         registry, voucher settlement, caps, timeout, self-farm
```

---

## Roadmap

1. **Reader SDK** — focus/scroll/idle tracking, voucher signing, session lifecycle, `visibilitychange` pause.
2. **Author collector service** — receives vouchers, auto-`settle`s on an interval, exposes earnings.
3. **Next.js frontend** — publish flow (upload to IPFS → `publish`), reader view with a live spend meter, discovery ranked by real spend.
4. **Indexer/subgraph** — leaderboards, per-article retention curves ("engagement", not just clicks).
5. **Stake-to-publish** — refundable deposit, slashable by a plagiarism/DMCA challenge, to price out spam.
6. **Native MON support** — a wrapper so readers can stream MON directly without approving an ERC-20.
7. **Splitters** — `transferAuthorship` to a 0xSplits-style contract for co-authors.
8. **Audit** before any mainnet deployment.
```
