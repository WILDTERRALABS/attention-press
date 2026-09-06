# @attention-press/reader-sdk

Client-side reading-engagement tracking and EIP-712 voucher signing for
[attention-press](../../README.md).

Drop it onto an article page. It opens an on-chain reading session, watches
whether the reader is actually reading (tab focus, scroll, idle), signs a
payment voucher every ~5 seconds with an ephemeral in-memory key, and closes the
session — refunding the reader's unspent budget — when they leave.

## Install

```bash
npm install @attention-press/reader-sdk viem
```

`viem` is a peer dependency.

## Usage

```ts
import { AttentionMeter } from "@attention-press/reader-sdk";
import { parseUnits } from "viem";

const meter = new AttentionMeter({
  contractAddress: "0xAttentionStream…",
  chainId: 10143,                          // Monad testnet
  articleId: 42n,
  ratePerSec: parseUnits("0.0001", 18),    // payment-token units per second
  budget: parseUnits("0.5", 18),           // hard spend cap for this visit
  provider: window.ethereum,               // EIP-1193 wallet
  target: document.querySelector("article") ?? undefined,
  onVoucher: (v) =>
    fetch("https://collector.example/vouchers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: v.sessionId,
        cumulativeAmount: v.cumulativeAmount.toString(),
        signature: v.signature,
      }),
    }),
});

meter.on("session:started", ({ sessionId }) => console.log("reading", sessionId));
meter.on("voucher:signed", ({ cumulativeAmount }) => updateSpendMeter(cumulativeAmount));
meter.on("session:paused", ({ reason }) => console.log("paused:", reason));
meter.on("session:resumed", () => console.log("resumed"));
meter.on("session:ended", ({ finalCumulative }) => console.log("closing", finalCumulative));
meter.on("session:finalized", ({ refunded }) => console.log("refunded", refunded));
meter.on("error", ({ phase, error }) => console.warn(phase, error));

await meter.start();                        // approves token if needed, sends openSession
// … reader reads …
await meter.stop();                         // final voucher + closeSession (phase 1, no refund)
// … wait challengeWindow (read `challengeWindow()` from the contract) …
await meter.finalize();                     // phase 2: refunds budget - claimed to the reader
```

## How it maps to `AttentionStream.sol`

| SDK | Contract |
| --- | --- |
| `meter.start()` | ERC-20 `approve` **only if allowance < budget** → `openSession(articleId, budget, ratePerSec, sessionKey.address)`; `sessionId` read from the `SessionOpened` event. (The `@attention-press/web` app pre-approves a standing allowance, so the approve step is normally skipped.) Pass `skipApproval: true` if the host handles approval itself. |
| voucher every `voucherIntervalMs` | EIP-712 `Voucher(bytes32 sessionId, uint256 cumulativeAmount)` signed by the ephemeral key, under domain `("AttentionStream", "1", chainId, contractAddress)` — the author's collector submits it to `settle` |
| `meter.stop()` | signs + delivers the final voucher, then `closeSession(sessionId)` � **phase 1**: records the accrual cutoff, no refund |
| `meter.finalize()` | `finalizeSession(sessionId)` after `closeInitiatedAt + challengeWindow` � **phase 2**: refunds `budget - claimed` to the reader (permissionless on-chain; the author's collector may call it too) |

`cumulativeAmount` is computed as `ratePerSec × engagedSeconds`, floored to whole
seconds (matching on-chain integer math) and clamped to `budget` and to
`ratePerSec × (wallClockElapsed + 1)` so it can never trip the contract's rate
cap.

## Engagement model

A session **starts engaged** the moment it opens (as long as the tab is
visible). It only pauses on *positive* evidence of disengagement:

- `document.visibilityState` goes `hidden` (`visibilitychange`, `pagehide`)
- the window fires `blur`
- no user activity for `idleTimeoutMs` (default 30s) — pointer, key, wheel, scroll, touch
- `meter.pause()` was called
- *(optional)* scroll hasn't progressed within `scrollStallTimeoutMs` on a scrollable `target` — off by default

Focus is assumed at start rather than read from `document.hasFocus()`, which is
an unreliable false-negative right after a wallet popup closes and would
otherwise require a click to begin accruing normal reading.

Any of the above flipping emits `session:paused` with the `reason`; recovering
emits `session:resumed`. Engaged time is measured with a monotonic clock
(`performance.now()`).

## Ephemeral key & security

- **In-memory only.** The session key is generated in the browser, never
  persisted, and dropped on `stop()`. A page reload loses it — by design.
- Its blast radius is bounded on-chain: it can authorize at most `budget`, and
  no faster than `ratePerSec`. If a reload orphans a session, the reader recovers
  the full unspent budget with `closeSession` then `finalizeSession` after the
  challenge window � no voucher needed.
- Vouchers must reach the author's collector in real time (`onVoucher`). The
  author calls `settle` to ratchet `claimed` up; the reader can never close below
  what has been settled. The one unsettled increment (≤ one voucher interval) is
  the author's risk if the reader closes in the same block — keep
  `voucherIntervalMs` small.

## API

- `new AttentionMeter(config, deps?)` — `deps` is an optional `{ openSession, closeSession }` test seam.
- `meter.start(): Promise<void>` · `meter.stop(reason?): Promise<void>` · `meter.pause()` · `meter.resume()`
- `meter.getState()` → `"idle" | "starting" | "reading" | "paused" | "stopping" | "ended"`
- `meter.getSnapshot()` → state, `sessionId`, `signer`, `cumulativeAmount`, `engagedSeconds`, `budget`, `lastVoucher`
- `meter.on(event, fn)` → unsubscribe fn; events: `session:started`, `voucher:signed`, `session:paused`, `session:resumed`, `session:ended`, `error`

Lower-level exports are available too: `EngagementTracker`, `IdleDetector`,
`SessionKey`, `computeCumulative`, `buildTypedData` / `VOUCHER_TYPES`,
`openSession` / `closeSession` / `finalizeSession`, `attentionStreamAbi`.

## Develop

```bash
npm run build      # tsup -> dist/ (ESM + CJS + d.ts)
npm test           # 30 — vitest (happy-dom): voucher digest, accrual clamps,
                   #      engagement model, meter lifecycle
npm run typecheck
```

## Not done yet

- On-chain paths (`openSession` / `closeSession`) are unit-tested via the `deps`
  seam; an integration test against a local Monad/Hardhat node is a follow-up.
- No batching/retry queue for voucher delivery — `onVoucher` is called once per
  voucher and the host owns transport.
