# @attention-press/web

Next.js frontend for attention-press.

- **`/`** — discovery, two tabs: **Articles** (ranked by `AttentionStream.articleEarned`)
  and **Authors** (top authors by total earned, with bio snippets, → their page).
- **`/publish`** — connect wallet, write Markdown, pick a pay-rate tier
  (Casual / Standard / Deep). The body is **AES-256-GCM encrypted client-side**;
  metadata stores `{title, preview, ratePerMinute, enc}` as an on-chain `data:`
  URI, `contentHash = keccak256(plaintext)`. The key is registered with the
  collector (author-signed) *before* the `publish` tx. **The collector operator
  can decrypt** — self-host for confidentiality.
- **`/profile/[address]`** — author landing page: header card (name + featured
  bio + totals: articles / WMON earned / reading time), articles sortable by
  newest or most-earned, and reader totals from the collector. Editable bio
  (owner signs a message, no gas).
- **`/article/[id]`** — public: title, byline, a short preview. On
  `session:started` the reader signs a request, the collector releases the key
  (checks `sessions(id)` is open + reader + articleId), and the body is decrypted
  client-side and verified against `contentHash`; it re-locks and is wiped on
  `session:ended`. Live **spend meter** for tokens streamed / engaged time /
  budget while reading. Vouchers POST to `NEXT_PUBLIC_COLLECTOR_URL`. Payment
  token is **WMON**; a one-click **Wrap MON** appears if your balance is short.
  Below the body, a **paid-actions bar** — like / dislike / favorite (one each
  per wallet), tip, and a reply composer — talking to `ArticleActions`. Replies
  render from the collector's index (`GET /articles/:id/replies`, chronological,
  "show more" pagination, ~20s poll, optimistic insert of a just-posted reply).
- **Standing allowance.** Instead of an `approve` tx before every session and
  action, the reader approves once per contract (a bounded amount — 500 WMON to
  `AttentionStream`, 100 WMON to `ArticleActions`) via an "Approve once, then
  read / react freely" panel that discloses the trade-off. After that every
  `openSession` / like / tip / reply is a single confirmation. `MaxUint256` is
  deliberately not used.
- Discovery pins `NEXT_PUBLIC_PINNED_ARTICLE_ID` (default 8, the project
  explainer) to the top with a "Start here" badge, regardless of earnings.

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

All must be `NEXT_PUBLIC_` to reach the browser. Contract addresses have in-code
defaults (the deployed testnet contracts) — env only overrides.

| Var | Default |
| --- | --- |
| `NEXT_PUBLIC_CHAIN_ID` / `NEXT_PUBLIC_RPC_URL` | `10143` / `https://testnet-rpc.monad.xyz` — **set a dedicated endpoint** (QuickNode / Alchemy); the browser trips the public RPC's rate limit |
| `NEXT_PUBLIC_ARTICLE_REGISTRY` / `NEXT_PUBLIC_ATTENTION_STREAM` / `NEXT_PUBLIC_ARTICLE_ACTIONS` | the deployed testnet addresses |
| `NEXT_PUBLIC_PINNED_ARTICLE_ID` | `8` (0 disables) |
| `NEXT_PUBLIC_COLLECTOR_URL` | `http://localhost:8787` |

Pay-rate tiers live in `src/lib/chain.ts` (`RATE_TIERS`), chosen per article at
publish time; the session budget is derived (rate × 10-minute cap).

## Not done yet

- No indexer — discovery multicalls every article id `1..nextId-1`. Fine for
  tens of articles; add a subgraph for scale.
- Inline data-URI metadata only. Articles published with `ipfs://` metadata show
  a placeholder — wire a gateway fetch + a real pin path next.
- Reply history depends on a single collector's index being up.
- `next lint` is not configured — `next build` drops into an interactive setup
  prompt. CI relies on `tsc` + `next build` + vitest.

## Develop

```bash
npm test -w @attention-press/web        # 24 — format + metadata + rate + author helpers
npm run typecheck -w @attention-press/web
npm run build -w @attention-press/web   # also runs type-checking
```
