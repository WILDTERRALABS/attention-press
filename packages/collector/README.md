# @attention-press/collector

Author-side service. Reader SDKs `POST` signed vouchers here; the collector
validates each one exactly as `AttentionStream` would, keeps the highest per
session, and periodically calls `settle(...)` on-chain so the author's balance
tracks reading in near real time.

`settle` is permissionless — the collector's wallet only pays gas, it never
receives fees or author payments.

## Run

```bash
cp .env.example .env      # set RPC_URL, ATTENTION_STREAM_ADDRESS, SETTLER_PRIVATE_KEY
npm run build
npm start                 # or: npm run dev
```

| Env | Meaning |
| --- | --- |
| `RPC_URL`, `CHAIN_ID` | chain endpoint (Monad testnet: `https://testnet-rpc.monad.xyz`, `10143`) |
| `ATTENTION_STREAM_ADDRESS` | deployed `AttentionStream` |
| `SETTLER_PRIVATE_KEY` | gas wallet for `settle` txs |
| `SETTLE_INTERVAL_MS` | settle-loop cadence (default `30000`) |
| `MIN_SETTLE_DELTA` | skip settling deltas below this to save gas (default `0`) |
| `DATA_DIR` | crash-recovery snapshot location (default `.data`) |

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
Wiring + liveness, and counters (`vouchersReceived/Accepted/Rejected`,
`settleSent/Failed`).

CORS: browser origins are allowed via `ALLOWED_ORIGINS` (comma-separated; default
`http://localhost:3000`).

## How settlement works

Every `SETTLE_INTERVAL_MS` the loop walks sessions whose stored voucher is ahead
of the on-chain `claimed`. For each it re-reads the session and then:

- session gone → stop tracking
- session closed → record final `claimed`, stop tracking
- `voucher ≤ claimed` (settled elsewhere) → catch up local state, skip
- delta `< MIN_SETTLE_DELTA` → skip this round
- otherwise → `settle(sessionId, cumulativeAmount, signature)`; on revert, count
  it failed and leave it pending for the next tick

State is snapshotted to `DATA_DIR/collector-state.json` after each tick and on
`SIGINT`/`SIGTERM`, and reloaded on boot.

## Not done yet

- In-memory store + JSON snapshot only — swap for SQLite/Postgres for
  multi-author scale.
- No auth or rate limiting on `POST /vouchers` (vouchers are self-authenticating
  and only ever help the author get paid; add a limiter before exposing publicly).
- Sequential settlement, one tx at a time. Fine at low volume; batch/parallelise
  with managed nonces later.
- No websocket/event subscription — it polls on an interval.

## Develop

```bash
npm test        # vitest: voucher validation, store, settle loop, HTTP routes
npm run typecheck
```
