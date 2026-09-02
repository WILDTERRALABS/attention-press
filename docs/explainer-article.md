# attention-press: get paid for attention, not clicks

**attention-press** is a publishing protocol on the Monad blockchain where readers
pay authors *per second of genuine reading time*. There are no ads, no
subscriptions, and no view-count metrics to game. If someone reads your article
for four minutes, you are paid for four minutes. If they bounce after ten
seconds, you are paid for ten seconds — and the reader keeps the rest of what
they set aside.

This article explains how the system works and how to use it. Reading it costs a
few WMON, streamed to the project treasury while you read — so by the time you
reach the bottom, you have already used the product.

---

## The core idea

Every attention economy today rewards the *click*: the headline that gets
opened, the thumbnail that gets tapped. Whether the thing behind the click was
worth anyone's time is invisible to the payment layer. That gap is why the web
is full of bait.

attention-press closes the gap by making **time the unit of account**:

- A reader opens an article and starts a **reading session**, escrowing a small
  budget up front.
- While the reader is actually looking at the page — tab focused, scrolling,
  not idle — the client meters engaged seconds and streams micro-payments to
  the author.
- When the reader leaves, the session closes and **the unspent budget is
  refunded**.

The author's payout is a direct function of aggregate real reading time. Better
writing holds attention longer and earns more. That is the whole mechanism.

### Why fake reading doesn't work

The obvious attack is to point a bot at your own article and let it "read" all
day. It doesn't pay, because **the reader funds the session**. A bot reading
your article is your own wallet paying your own wallet, minus a protocol fee
that is burned from your side every time. Self-farming is strictly
loss-making by construction — there is no faucet of external money to capture.

---

## How a reading session works

1. **Escrow.** The reader calls `openSession` on the `AttentionStream` contract,
   locking a budget (the pay rate × a time cap) in WMON. This is a hard ceiling
   on what the session can ever cost.
2. **An ephemeral key.** The client generates a throwaway signing key that lives
   only in memory for the length of the session. The reader never signs a
   wallet popup again until they leave.
3. **Vouchers.** Every few seconds the client signs a tiny EIP-712 message —
   "session X has now earned Y total" — with the ephemeral key. Each voucher is
   monotonic (only ever goes up) and is capped by elapsed time × rate, so a
   buggy or malicious client cannot over-claim.
4. **Settlement.** A small service called the **collector** submits the latest
   voucher on-chain, ratcheting the author's claimable balance up to Y. Anyone
   can call `settle` — it only needs a valid signed voucher — so the author is
   never dependent on a single party's goodwill.
5. **Close & refund.** When the reader navigates away, `closeSession` settles
   the final voucher and returns every unspent unit of the budget. If the
   collector vanishes, a timeout lets the reader reclaim the full remainder
   unilaterally.

The reader's worst case is the budget they explicitly escrowed. The author's
worst case is not getting paid for a session that was never settled — which is
why the collector exists and why settlement is permissionless.

---

## Reading is gated, not free

The article body is **encrypted (AES-256-GCM) before it is published**. What
goes on-chain is the ciphertext plus a short plaintext preview. The decryption
key is released by the collector only to a wallet with an **open, funded
session** for that article, after an on-chain check.

Honest caveat: this means the collector *can* technically read any article whose
key it holds. It is a convenience-vs-confidentiality tradeoff for v1. Anyone can
run their own collector; a future version can push key custody to the reader or
a threshold network. The on-chain `contentHash` always commits to the plaintext,
so a reader can verify that what they decrypted is exactly what the author
published.

---

## Paid reactions and replies

Beyond streaming, there are five discrete paid actions on the separate
`ArticleActions` contract. All are denominated in WMON and paid straight to the
author (minus a small protocol fee), with no funds ever held by the contract:

| Action | Price | Goes to |
| --- | --- | --- |
| 👍 Like | 1 WMON | author |
| ⭐ Favorite | 1 WMON | author |
| 💬 Reply | 2 WMON | author (reply text is in the event log) |
| 👎 Dislike | 1 WMON | **treasury only** — an author must not profit from a negative signal |
| 🎁 Tip | you choose | author |

Like, dislike, and favorite are one per wallet per article. A downvote still
costs the downvoter real money, so brigading is expensive rather than free.
Replies are capped in length and in count per article to bound spam.

None of this is moderated by the contract — reply text is permanent and public
by design. Front-ends and collectors can choose what to display.

---

## How to use it

### 1. Get on Monad testnet

Add the Monad testnet to your wallet (chain ID `10143`, RPC
`https://testnet-rpc.monad.xyz`) and claim test **MON** from the Monad faucet.
MON is the gas token.

### 2. Wrap MON into WMON

Payments are in **WMON** (wrapped MON, 1:1). The reader screen has a **Wrap**
button that deposits native MON and returns WMON; you only need to do this once,
for roughly the budget of the sessions you plan to open.

### 3. Read something

Open an article. You'll see the title, author, and a preview. Click **Start
reading session** and approve the one escrow transaction. The body decrypts, and
a live meter shows engaged seconds and WMON streamed. Look away, switch tabs, or
go idle and the meter pauses — you are not charged for time you didn't spend.
Click **Stop** (or just leave) to close the session and get your refund.

### 4. React, reply, tip

Under any article, the actions bar lets you like/dislike/favorite once, post a
paid reply, or send the author a tip of any size. Each does an exact-amount WMON
approval followed by the call — no infinite approvals.

### 5. Publish

Go to **Publish**. Write in Markdown, pick a pay tier, and submit. Your browser
encrypts the body, registers the key with the collector, and calls `publish` on
the `ArticleRegistry`. Your article appears in discovery, ranked by how much
readers have actually streamed to it.

Pay tiers are placeholder testnet economics and exist to be tuned:

| Tier | Rate | ~10-minute read |
| --- | --- | --- |
| Casual | 0.4 WMON/min | ~4 WMON |
| Standard | 1 WMON/min | ~10 WMON |
| Deep read | 2 WMON/min | ~20 WMON |

A single session is capped at 10 minutes of billable time regardless of tier.

---

## What's under the hood

- **`ArticleRegistry`** — on-chain index of articles: author, content hash,
  metadata pointer, retired flag. Handles no money.
- **`AttentionStream`** — the escrow + voucher + streaming-settlement contract.
  Holds reader budgets; pays authors; refunds the rest.
- **`ArticleActions`** — like / dislike / favorite / reply / tip. Never
  custodies funds; every payment is a direct transfer. Immutable treasury,
  reentrancy-guarded, pausable as an emergency stop.
- **Collector** — a small service that settles vouchers on a timer and brokers
  decryption keys. Permissionless settlement means it is a convenience, not a
  gatekeeper.
- **Reader SDK** — the browser library that meters engagement (focus, scroll,
  idle), manages the ephemeral key, and signs vouchers.

## Status and trust

This is a **testnet build for a contest**. The contracts are **not
professionally audited**. They have unit and adversarial test suites, static
analysis (Slither, solhint) with zero findings on the actions contract, a
containment review, and a live testnet canary — a competent-solo-dev bar, not a
mainnet-with-real-money bar. A real mainnet posture would additionally need a
paid audit, a bug bounty, timelocked multisig ownership, on-chain monitoring,
and a rigorous mechanism-design review. The gap is documented in `SECURITY.md`
rather than hidden.

If you're reading this on the live site: the meter above has been paying the
treasury for your attention this whole time. That's the product. Thanks for
spending the time.
