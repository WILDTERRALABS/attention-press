# @attention-press/collector

Author-side service. It does four things, none of which can custody user funds:

1. **Settlement.** Reader SDKs `POST` signed vouchers here; the collector
   validates each exactly as `AttentionStream` would, keeps the highest per
   session, and periodically calls `settle(...)` so the author's balance tracks
   reading in near real time. `settle` is permissionless — the collector's
   wallet only pays gas.
2. **Content-key custody.** Authors register an article's AES key (by plaintext
   `contentHash`); readers with a verified open session get it back.
3. **Reply index.** Backfills and polls `ArticleActions.Replied` logs into a
   local store, served paginated at `GET /articles/:id/replies`.
4. **Author bios + per-reader stats** — small read helpers for the frontend.

## Run

```bash
cp .env.example .env      # fill in the required vars below
npm run build
npm start                 # or: npm run dev  (tsx watch)
```

| Env | Meaning |
| --- | --- |
| `RPC_URL`, `CHAIN_ID` | chain endpoint + id (`10143`). Use a **dedicated endpoint** — the public RPC rate-limits and caps `eth_getLogs` at 100 blocks. |
| `ATTENTION_STREAM_ADDRESS` | deployed `AttentionStream` |
| `ARTICLE_REGISTRY_ADDRESS` | deployed `ArticleRegistry` (key-release author check) |
| `ARTICLE_ACTIONS_ADDRESS` | deployed `ArticleActions` (reply indexer source) |
| `SETTLER_PRIVATE_KEY` | **dedicated gas-only wallet** — the settle loop signs `settle` txs from it (the reply indexer only reads). Anything else using this key races the nonce. `settle` is permissionless, so it never holds fees. |
| `SETTLE_INTERVAL_MS` | settle-loop cadence (default `30000`) |
| `MIN_SETTLE_DELTA` | skip settling deltas below this to save gas (default `0`) |
| `ARTICLE_ACTIONS_FROM_BLOCK` | start block for the one-time reply backfill (default `0` = genesis; set to just before the ArticleActions deploy). Backfill is idempotent. |
| `REPLY_INDEX_INTERVAL_MS` | reply-poll cadence (default `15000`) |
| `LOG_QUERY_RANGE` | max block span per `eth_getLogs` (default `900`; QuickNode Monad caps at 1000, public RPC at 100). Halves to a 100 floor and remembers the working size if a provider rejects a range. |
| `MAX_ACCRUAL_WINDOW_SEC` | mirror of the contract's `MAX_ACCRUAL_WINDOW` (default `604800`) |
| `DATA_DIR` | crash-recovery snapshot location (default `.data`) |
| `ALLOWED_ORIGINS` | comma-separated CORS origins (default `http://localhost:3000`) |

## HTTP API

### `POST /vouchers`
```json
{ "sessionId": "0x…32 bytes", "cumulativeAmount": "1000000000000", "signature": "0x…65 bytes" }
```
`cumulativeAmount` is a base-10 integer string. Responses:

- `202 { ok: true, sessionId, cumulativeAmount }` — stored
- `400` — malformed field or unrecoverable signature
- `404` — no such session on-chain
- `409 { ok: false, reason }` — the contract would revert it (closed, non-monotonic, over budget, over rate cap, wrong signer)

### `GET /sessions/:id`
On-chain session struct + the latest stored voucher + `pendingDelta`
(`latestVoucher.cumulativeAmount − onChain.claimed`).

### `GET /authors/:address/earnings`
`{ author, settledTotal, pendingTotal, sessions: [{ sessionId, settled, pending }] }`
— all base-10 strings. Totals are what this collector has observed.

### `GET /readers/:address/stats`
`{ reader, totalPaid, sessionsOpened, articlesRead }` — reflects only sessions
whose vouchers reached this collector.

### `GET /articles/:id/replies`
Indexed `ArticleActions.Replied` logs for an article.
`?order=asc|desc` (default `asc` = chronological), `?cursor=<offset>`,
`?limit=1..200` (default 50). Returns:
```json
{
  "articleId": "9", "order": "asc", "total": 3, "nextCursor": 50,
  "replies": [
    { "index": 0, "actor": "0x…", "text": "…", "toAuthor": "1950000000000000000",
      "fee": "50000000000000000", "blockNumber": 59088175, "blockTime": 1788360192,
      "txHash": "0x…" }
  ]
}
```
`nextCursor` is `null` on the last page. 400 on a bad id / order / limit / cursor.
Served from the local index — up to `REPLY_INDEX_INTERVAL_MS` behind chain head.

### `GET /profiles/:address` · `GET /profiles?addresses=a,b,c` · `POST /profiles`
Off-chain author bio (≤280 chars). `GET /profiles/:address` → `{ address, text, updatedAt }`.
`GET /profiles?addresses=` (1..100) → `{ "<lowercased addr>": { text, updatedAt }, … }`.
`POST { address, text, signature }` stores it — `signature` must sign
`attention-press: set bio for <address>\n\n<text>` from that address (401 otherwise).

### `POST /articles/key` · `POST /articles/:id/key`  (content-gating key custody)
- **Register** `{ contentHash, key, signature }` — the author uploads an article's
  AES-256 key, keyed by the plaintext `contentHash`, signing
  `attention-press: register key for <contentHash>`. Last write wins; verified
  against the on-chain author only at release. **The operator can read any article
  it holds a key for** — run your own collector for real confidentiality.
- **Release** `{ address, sessionId, signature, timestamp }` — returns `{ key }`
  only if `sessions(sessionId)` is open, `.reader == address`, `.articleId == id`,
  the signature over `attention-press: unlock article <id> for <address> at <minute>`
  recovers to `address` (≤5 min old), and the registered key's signer matches
  `ArticleRegistry.authorOf(id)`. Otherwise 401/403/404/409.

### `GET /health` · `GET /metrics`
Wiring + liveness (`status`, `chainId`, `streamAddress`, `settler`,
`blockTimestamp`; `status: "degraded"` if the RPC is unreachable) and counters
(`vouchersReceived/Accepted/Rejected`, `settleSent/Failed`).

## How settlement works

Every `SETTLE_INTERVAL_MS` the loop walks sessions whose stored voucher is ahead
of the on-chain `claimed`. For each it re-reads the session and then:

- session gone → stop tracking
- session closed → record final `claimed`, stop tracking
- `voucher ≤ claimed` (settled elsewhere) → catch up local state, skip
- delta `< MIN_SETTLE_DELTA` → skip this round
- otherwise → `settle(sessionId, cumulativeAmount, signature)`; on revert, count
  it failed and leave it pending for the next tick

## How the reply index works

On startup, one backfill from `ARTICLE_ACTIONS_FROM_BLOCK` (or the persisted
cursor, whichever is higher) to chain head, walking blocks in `LOG_QUERY_RANGE`
windows; if the provider rejects a range it halves the window down to a 100-block
floor and remembers the working size. Then it polls every
`REPLY_INDEX_INTERVAL_MS`, re-scanning a small block buffer below the cursor to
absorb reorgs. Idempotent — replies are keyed by the contract's own per-article
`Replied` index, so overlapping ranges and restarts never double-count. Block
timestamps are fetched once per block and cached.

## Persistence

State is snapshotted to `DATA_DIR/collector-state.json` (version 4: sessions,
settled totals, bios, content keys, the reply index, and the reply cursor block)
after each settle tick / index pass and on `SIGINT`/`SIGTERM`, and reloaded on
boot.

## Not done yet

- In-memory store + JSON snapshot only — swap for SQLite/Postgres for
  multi-author scale.
- No auth or rate limiting on `POST /vouchers` (vouchers are self-authenticating
  and only ever help the author get paid; add a limiter before exposing publicly).
- Sequential settlement, one tx at a time. Fine at low volume; batch/parallelise
  with managed nonces later.
- No websocket/event subscription — settlement and the reply index both poll.
- **Trusted key custodian:** the operator can decrypt any article whose key it
  holds. A threshold/DKG release scheme fits the same endpoint.

## Develop

```bash
npm test        # 74 — voucher validation, store snapshot, settle loop, HTTP routes,
                #      reply indexer (backfill windows, idempotency, adaptive getLogs
                #      range, reorg buffer, cached timestamps)
npm run typecheck
```
