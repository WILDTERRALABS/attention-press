# @attention-press/web

Next.js frontend for attention-press.

- **`/`** — discovery. Every article ranked by `AttentionStream.articleEarned` —
  real tokens streamed by readers, not clicks.
- **`/publish`** — connect wallet, write Markdown, pick a pay-rate tier
  (Casual / Standard / Deep). The body is **AES-256-GCM encrypted client-side**;
  metadata stores `{title, preview, ratePerMinute, enc}` as an on-chain `data:`
  URI, `contentHash = keccak256(plaintext)`. The key is registered with the
  collector (author-signed) *before* the `publish` tx. **The collector operator
  can decrypt** — self-host for confidentiality.
- **`/profile/[address]`** — published articles + earnings; reader totals (from
  the collector); an editable bio (owner signs a message, no gas).
- **`/article/[id]`** — public: title, byline, a short preview. On
  `session:started` the reader signs a request, the collector releases the key
  (checks `sessions(id)` is open + reader + articleId), and the body is decrypted
  client-side and verified against `contentHash`; it re-locks and is wiped on
  `session:ended`. Live **spend meter** for tokens streamed / engaged time /
  budget while reading. Vouchers POST to `NEXT_PUBLIC_COLLECTOR_URL`. Payment
  token is **WMON**; a one-click **Wrap MON** appears if your balance is short.

## Run

```bash
cp .env.example .env.local     # addresses default to the deployed testnet contracts
npm run build -w @attention-press/reader-sdk   # the web app consumes its dist/
npm run dev -w @attention-press/web            # http://localhost:3000
```

For the reader view to settle on-chain, run the collector too
(`packages/collector`, `npm start`) — otherwise vouchers are signed and shown in
the meter but never submitted.

Wallet: any injected EIP-1193 wallet (MetaMask, Rabby, …) on Monad Testnet
(chainId 10143). The app prompts a network switch.

## Env

| Var | Default |
| --- | --- |
| `NEXT_PUBLIC_CHAIN_ID` / `NEXT_PUBLIC_RPC_URL` | `10143` / `https://testnet-rpc.monad.xyz` |
| `NEXT_PUBLIC_ARTICLE_REGISTRY` / `NEXT_PUBLIC_ATTENTION_STREAM` | deployed testnet addresses |
| `NEXT_PUBLIC_COLLECTOR_URL` | `http://localhost:8787` |
| `NEXT_PUBLIC_DEFAULT_RATE_PER_SEC` / `NEXT_PUBLIC_DEFAULT_BUDGET` | `1e15` / `6e17` base units |

## Not done yet

- No indexer — discovery multicalls every article id `1..nextId-1`. Fine for
  tens of articles; add a subgraph for scale.
- Inline data-URI metadata only. Articles published with `ipfs://` metadata show
  a placeholder — wire a gateway fetch + a Pinata publish path next.
- No per-read rate/budget controls in the UI yet (uses the env defaults).
- `next lint` not configured.

## Develop

```bash
npm test -w @attention-press/web        # vitest: format + metadata helpers
npm run typecheck -w @attention-press/web
```
