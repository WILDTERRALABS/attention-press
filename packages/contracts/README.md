# @attention-press/contracts

Solidity 0.8.24 / Hardhat. Three contracts, OpenZeppelin 5.1
(`SafeERC20` · `ReentrancyGuard` · `Pausable` · `Ownable` · EIP-712),
`evmVersion: paris`, optimizer 200 runs.

Security posture and the honest audit gap: **[`SECURITY.md`](SECURITY.md)**.

## Contracts

### `ArticleRegistry.sol` — token-free index
- `publish(contentHash, uri) → id` — permissionless, ids start at 1.
- `retire(id)` / `updateMetadata(id, uri)` / `transferAuthorship(id, to)` — current author only.
- `authorOf(id)` / `isActive(id)` — the read surface the other contracts use.

`metadataURI` holds a base64 `data:application/json;base64,…` URI with the
encrypted body, plaintext preview, title, and rate tier. `contentHash` is
`keccak256(plaintext body)`.

### `AttentionStream.sol` — one payment channel per reading session
Opened and closed on-chain (~2 tx total regardless of reading time); everything
between is off-chain EIP-712 vouchers.

| Function | Caller | Effect |
|---|---|---|
| `openSession(articleId, budget, ratePerSec, signer)` | reader | Escrows `budget`. `signer` is an ephemeral browser key. Returns `sessionId`. |
| `settle(id, cumulativeAmount, sig)` | anyone | Verifies the voucher, ratchets `claimed` up, pays `delta − fee` to the author, `fee` to the treasury. |
| `closeSession(id, cumulativeAmount, sig)` | reader | Settles the final voucher, refunds `budget − claimed`. |
| `readerReclaim(id)` | reader | After `sessionTimeout` (default 3d): recover all unclaimed escrow, no voucher needed. |

`Voucher(bytes32 sessionId, uint256 cumulativeAmount)`, signed by the session
key. Guards: monotonic, `≤ budget`, `≤ ratePerSec × (elapsed + 1s)` (elapsed
clamped to `MAX_ACCRUAL_WINDOW` = 7d), `nonReentrant` + CEI, `SafeERC20`, fee
≤ `MAX_FEE_BPS` (10%), `sessionTimeout` ∈ [1d, 30d]. `token` is immutable.

### `ArticleActions.sol` — discrete paid engagement
Standalone: only **reads** `IArticleRegistry`; never touches `AttentionStream`.

| Action | Price | Paid to |
|---|---|---|
| `like` / `favorite` | 1 WMON | author − `actionFeeBps` to treasury |
| `reply(id, text)` | 2 WMON | author − fee; `text` in the `Replied` event, `{actor, blockTime}` on-chain |
| `dislike` | 1 WMON | **treasury only** — an author must not profit from a negative signal |
| `tip(id, amount)` | any | author − fee |

Never custodies the token (direct `transferFrom`); `nonReentrant` +
`whenNotPaused` + CEI on all five; `msg.sender != authorOf(id)` (`SelfAction`);
one like/dislike/favorite per `(wallet, article)`; `treasury` **immutable** (set
in the constructor, no setter); constant prices; `actionFeeBps` ≤ 10%
(re-checked in `setActionFeeBps`); `MAX_REPLY_BYTES` = 1000;
`MAX_REPLIES_PER_ARTICLE` = 100 000. Owner can only `pause`/`unpause` and set the
fee — it cannot move or redirect funds.

`mocks/` — `MockERC20` (test/testnet token) and `ReentrantERC20` (proves
`nonReentrant` blocks a reentrant `like()`). Never deployed to a real network.

## Test

```bash
npm test          # 37 — hardhat/chai
npm run lint:sol  # solhint, zero errors
npm run slither    # needs `pip install slither-analyzer`; zero findings on ArticleActions
```

`test/attention.test.ts` — registry, voucher settlement, budget/rate caps,
timeout reclaim, admin bounds, and the self-farm case netting `−fee`.
`test/articleActions.test.ts` — fee math per action, one-shot dedup, `SelfAction`,
retired/unknown article reverts, `transferFrom`-failure atomicity, reply length
+ count bounds, tip dust rounding, zero-balance invariant, a `ReentrantERC20`
reentrancy probe, and a combined fixture proving actions during a live session
leave the session's accounting byte-identical.

## Deploy (Monad testnet)

```bash
cp .env.example .env       # DEPLOYER_KEY, MONAD_RPC_URL (use a dedicated endpoint)
npm run deploy:monad          # ArticleRegistry (or reuse ARTICLE_REGISTRY) + AttentionStream
npm run deploy-actions:monad  # ArticleActions, reading contracts.* + protocolFeeBps from
                              # deployments/monadTestnet.json; writes ArticleActions back
```

`deploy.ts` sets the deployer as treasury; reuses `PAYMENT_TOKEN` (WMON) and
`ARTICLE_REGISTRY` when set, else deploys a fresh `MockERC20` / `ArticleRegistry`.
`deploy-actions.ts` accepts `ACTION_FEE_BPS` / `ACTIONS_TREASURY` overrides
(default: the recorded fee and treasury).

Ops scripts: `preflight:monad`, `list-articles:monad`,
`retire:monad` (`IDS=1,2,3 npm run retire:monad`),
`actions-smoke:monad` (live canary: all five actions + revert cases against the
deployed contract with a funded throwaway wallet; prints a PASS/FAIL table).

## Deployed

See [`deployments/monadTestnet.json`](deployments/monadTestnet.json) — the
canonical record of addresses, fee bps, treasury, and the ArticleActions deploy
block.
