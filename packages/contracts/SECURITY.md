# Security notes — @attention-press/contracts

## Status

**Not audited.** These contracts run on Monad **testnet** for a build contest.
Do **not** deploy them to any mainnet with real value on the strength of this
document alone — see "The gap" below.

## Contracts

| Contract | Handles value? | Notes |
| --- | --- | --- |
| `ArticleRegistry` | no | Author + contentHash + metadata pointer. Token-free. |
| `AttentionStream` | yes (WMON escrow) | Streaming pay-per-second reading. **Two-phase closure** (see below) landed after an external AI audit (Savant.chat) flagged close/settle races. |
| `ArticleActions` | yes (WMON, no custody) | Discrete paid actions. `_payAuthor` / `_actionableAuthor` now reject `address(this)` as the recipient. |
| `MockERC20`, `ReentrantERC20` | test only | Never deployed to a real network. |

## External audit — Savant.chat (AI), findings addressed

| # | Finding | Fix |
| --- | --- | --- |
| 3.2 / 3.4 | `ArticleActions` funds locked forever if an article's author is set (via `ArticleRegistry.transferAuthorship`) to the `ArticleActions` contract — actions still increment counts / record replies while the WMON is stuck. | `_actionableAuthor` **and** `_payAuthor` revert `InvalidRecipient` when `author == address(this)`. No state written, no transfer. |
| 3.1 / 3.3 / 3.5 / 3.6 | Reader can `closeSession` at a stale `cumulativeAmount` (or `== claimed` with empty sig, skipping `_verify`) and front-run the collector's `settle` of the latest voucher; once `open == false` the settle reverts and the author loses the un-settled delta. `readerReclaim` had the same shape after the timeout. | **Two-phase closure.** `closeSession(id)` takes no voucher — it only records `closeInitiatedAt` and freezes accrual at that timestamp. For `challengeWindow` (default 15 min, owner-settable `[1 min, 1 day]`) anyone may still `settle` vouchers signed at/before the cutoff; `_maxAccrued` is measured to `closeInitiatedAt`, not `now`, so nothing signed after close helps the reader. `finalizeSession(id)` (permissionless) then refunds `budget − claimed`. `readerReclaim` / `sessionTimeout` removed — a collector-less reader recovers via `closeSession → wait → finalizeSession`; an abandoned session is force-closeable by anyone after `MAX_ACCRUAL_WINDOW`. |

Regression tests for all of the above are in `test/attention.test.ts` and
`test/articleActions.test.ts`.

`ArticleActions` is standalone: it only **reads** `IArticleRegistry`
(`isActive`, `authorOf`) and never calls / is called by `AttentionStream`, so
deploying it cannot affect sessions or the streaming flow. `git diff` on
`contracts/` for this change shows only the new files.

## `ArticleActions` — threat model

### Design invariants
- **Never custodies the token.** Every payment is
  `transferFrom(payer → recipient)` — the contract's WMON balance is always 0
  (tested).
- Every state-changing function is `nonReentrant`, `whenNotPaused`, and written
  **checks → effects → interactions** (all storage writes before any transfer).
- `msg.sender != authorOf(id)` on all five actions (`SelfAction`).
- All actions require `registry.isActive(id)` (`ArticleInactive`) — retiring an
  article freezes interaction with it.
- Fixed prices are `constant`s (1 / 1 / 1 / 2 WMON); no setter, so a mutable
  price cannot inflate to drain a standing approval. For usability the frontend
  requests a **bounded standing allowance** (default 100 WMON to `ArticleActions`,
  500 WMON to `AttentionStream`) instead of an approval per action. That
  allowance is only ever spent by a `transferFrom(msg.sender, …)` the caller
  themselves triggers; neither contract is upgradeable; the reader can revoke in
  their wallet. It is a real increase in trust surface over exact-amount
  approvals — disclosed in the approval UI — bounded by an undiscovered contract
  bug rather than by the approval amount.
- `treasury` is **immutable** — set once in the constructor, no setter. The
  owner cannot redirect the fee / dislike flow to a new address; changing it
  means a redeploy.
- `actionFeeBps` ≤ `MAX_FEE_BPS` (1000 = 10%), owner-settable. The cap is
  re-checked inside `setActionFeeBps` itself, so it is unbypassable. Applied to
  like / favorite / reply / tip. **Not** applied to `dislike`, which pays the
  full price to the treasury (the author must not earn from a negative signal).
- `replyCount[id]` ≤ `MAX_REPLIES_PER_ARTICLE` (100 000) — a hard ceiling that
  bounds worst-case event-log / indexer griefing by a well-funded spammer,
  while sitting far above any realistic legitimate thread.

### Accepted risks (documented, not fixed)
| Risk | Why it's accepted |
| --- | --- |
| Fee-on-transfer / rebasing tokens would under-deliver | `token` is immutable and set to WMON (a WETH9-style, non-fee token). Same stance as `AttentionStream`. |
| Author-transfer front-run redirects a pending action's payment to the *new* author | No theft; the actor still performed the action. |
| Reply text is permanent + public; the contract cannot moderate | By design (censorship-resistant). Bounded by `MAX_REPLY_BYTES = 1000` per reply and `MAX_REPLIES_PER_ARTICLE = 100 000` per article; frontend/collector can hide entries. |
| Sock-puppet inflation of like/favorite **counts** | Each fake action costs `actionFeeBps` of real WMON (the same defense `AttentionStream` uses for self-farming). `SelfAction` blocks the trivial same-address case. |
| `pause()` is owner centralization (owner can freeze all interactions) | Standard emergency stop for a funds contract. **Mainnet requires `owner` = a timelocked multisig.** Testnet uses an EOA. |
| `block.timestamp` in the reply record | Display-only; never gates logic. Slither does not flag it. |
| `AttentionStream` reads `block.timestamp` on every close/settle path: the per-second accrual cap (`_maxAccrued`, `_applySettlement`), the `challengeWindow` boundary (`settle`, `finalizeSession`), the `MAX_ACCRUAL_WINDOW` abandoned-session threshold (`closeSession`), and their view mirror (`claimableFor`). Slither's `timestamp` detector flags all of these — plus, as false positives, a couple of `== address(0)` checks in `authorOf` / `openSession`. The exact site list shifts as the code changes; the class does not. | A validator can nudge `block.timestamp` by a few seconds at most. The challenge window is 15 min and the accrual window 7 days, so seconds of skew are economically irrelevant. Inherent to a pay-per-second channel. |

## What was done

- **Unit + adversarial tests** (`test/articleActions.test.ts`, 25 cases): fee
  math for every action, one-shot dedup reverts, `SelfAction`, retired/unknown
  article reverts, `transferFrom`-failure atomicity (no flag, no count), reply
  length bounds, `MAX_REPLIES_PER_ARTICLE` enforcement (storage-slot fast-forward
  to index 99 999), tip dust rounding, zero-balance invariant, owner-only + bps
  cap, fee-0 path, `treasury` has no setter, constructor rejects zero
  token/registry/treasury and an over-cap fee, `pause` gating, a `ReentrantERC20`
  proving `nonReentrant` rejects a reentrant `like()` during `transferFrom`, and
  a combined `AttentionStream` + `ArticleActions` fixture proving likes/tips
  during a live session leave the session's `claimed` / `articleEarned`
  byte-identical.
- **Static analysis**: `slither .` (v0.11.6) — **zero findings on
  `ArticleActions.sol`**; on `AttentionStream.sol` only informational
  `timestamp` comparisons (accepted, table above) and one pre-existing
  `unindexed-event-address` on `TreasuryUpdated`. `solhint` — **zero errors**
  (`npm run lint:sol`).
- **Containment check**: grep-confirmed `ArticleActions` only reads
  `IArticleRegistry`; no other `.sol` changed.
- **Testnet canary**: `scripts/actions-smoke.ts` runs the full action set +
  revert cases against the live deployment with a throwaway wallet.

## The gap — what a real mainnet posture needs that we did not do

- **A professional audit** (Trail of Bits / OpenZeppelin / Spearbit / Code4rena):
  $15k–$100k+, 1–4 weeks. Slither + adversarial tests catch the common bug
  classes (reentrancy, access control, arithmetic, unchecked calls) but do not
  reliably catch subtle economic/incentive bugs, novel attack compositions, or
  mismatches between WMON's actual deployed bytecode and our mock.
- **Formal verification** (Certora / deep SMTChecker).
- **A bug bounty** (Immunefi).
- **Timelocked multisig ownership** — mainnet must not have an EOA holding
  `pause` / `setActionFeeBps` (`ArticleActions`) or the `AttentionStream` admin
  setters. `ArticleActions.treasury` is already immutable, so it is not part of
  this surface.
- **On-chain monitoring / alerting** (Tenderly, OZ Defender Sentinels).
- **A rigorous mechanism-design review** of the like/dislike/tip incentives —
  this file is reasoning, not modeling.

This change reaches *"competent solo dev + static analysis + adversarial tests +
testnet canary."* That is a reasonable bar for a testnet build contest and an
insufficient one for mainnet with real WMON.
