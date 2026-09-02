# Security notes — @attention-press/contracts

## Status

**Not audited.** These contracts run on Monad **testnet** for a build contest.
Do **not** deploy them to any mainnet with real value on the strength of this
document alone — see "The gap" below.

## Contracts

| Contract | Handles value? | Notes |
| --- | --- | --- |
| `ArticleRegistry` | no | Author + contentHash + metadata pointer. Token-free. |
| `AttentionStream` | yes (WMON escrow) | Streaming pay-per-second reading. Reviewed; unchanged. |
| `ArticleActions` | yes (WMON, no custody) | Discrete paid actions: like / dislike / favorite / reply / tip. |
| `MockERC20`, `ReentrantERC20` | test only | Never deployed to a real network. |

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
  price cannot interact badly with a `type(uint256).max` approval. The frontend
  requests exact-amount approvals anyway.
- `actionFeeBps` ≤ `MAX_FEE_BPS` (1000 = 10%), owner-settable. Applied to
  like / favorite / reply / tip. **Not** applied to `dislike`, which pays the
  full price to the treasury (the author must not earn from a negative signal).

### Accepted risks (documented, not fixed)
| Risk | Why it's accepted |
| --- | --- |
| Fee-on-transfer / rebasing tokens would under-deliver | `token` is immutable and set to WMON (a WETH9-style, non-fee token). Same stance as `AttentionStream`. |
| Author-transfer front-run redirects a pending action's payment to the *new* author | No theft; the actor still performed the action. |
| Reply text is permanent + public; the contract cannot moderate | By design (censorship-resistant). Bounded by `MAX_REPLY_BYTES = 1000`; frontend/collector can hide entries. |
| Sock-puppet inflation of like/favorite **counts** | Each fake action costs `actionFeeBps` of real WMON (the same defense `AttentionStream` uses for self-farming). `SelfAction` blocks the trivial same-address case. |
| `pause()` is owner centralization (owner can freeze all interactions) | Standard emergency stop for a funds contract. **Mainnet requires `owner` = a timelocked multisig.** Testnet uses an EOA. |
| `block.timestamp` in the reply record | Display-only; never gates logic. Slither does not flag it. |

## What was done

- **Unit + adversarial tests** (`test/articleActions.test.ts`, 22 cases): fee
  math for every action, one-shot dedup reverts, `SelfAction`, retired/unknown
  article reverts, `transferFrom`-failure atomicity (no flag, no count), reply
  length bounds, tip dust rounding, zero-balance invariant, owner-only + bps cap,
  fee-0 path, `pause` gating, a `ReentrantERC20` proving `nonReentrant` rejects a
  reentrant `like()` during `transferFrom`, and a combined `AttentionStream` +
  `ArticleActions` fixture proving likes/tips during a live session leave the
  session's `claimed` / `articleEarned` byte-identical.
- **Static analysis**: `slither .` (v0.11.6) — **zero findings on
  `ArticleActions.sol`** (`npm run slither`, needs `pip install
  slither-analyzer`). `solhint` — **zero errors** (`npm run lint:sol`).
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
  `pause` / `setActionFeeBps` / `setTreasury`.
- **On-chain monitoring / alerting** (Tenderly, OZ Defender Sentinels).
- **A rigorous mechanism-design review** of the like/dislike/tip incentives —
  this file is reasoning, not modeling.

This change reaches *"competent solo dev + static analysis + adversarial tests +
testnet canary."* That is a reasonable bar for a testnet build contest and an
insufficient one for mainnet with real WMON.
