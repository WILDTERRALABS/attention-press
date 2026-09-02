# @attention-press/web

Next.js frontend for attention-press.

- **`/`** — discovery. Every article ranked by `AttentionStream.articleEarned` —
  real tokens streamed by readers, not clicks.
- **`/publish`** — connect wallet, write Markdown, pick a pay-rate tier
  (Casual / Standard / Deep), `ArticleRegistry.publish`. Stores
  `{title, body, ratePerMinute}` as an on-chain `data:` URI;
  `contentHash = keccak256(body)`. Tiers live in `src/lib/chain.ts`;
  session budget = rate × 30 min.
- **`/profile/[address]`** — published articles + earnings; reader totals (from
  the collector); an editable bio (owner signs a message, no gas).
- **`/article/[id]`** — renders the article and mounts `AttentionMeter` from
  `@attention-press/reader-sdk`. A live **spend meter** shows tokens streamed,
  engaged reading time, budget remaining and voucher count while you read.
  Vouchers are POSTed to the collector at `NEXT_PUBLIC_COLLECTOR_URL`. The
  payment token is **WMON**; if your WMON balance is below the session budget the
  page offers a one-click **Wrap MON** (`WMON.deposit()`) using your native MON.

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
