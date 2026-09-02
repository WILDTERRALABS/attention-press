import { describe, it, expect } from "vitest";
import { SettleLoop } from "../src/settleLoop.js";
import { VoucherStore } from "../src/store.js";
import { FakeChain, makeSession, sid } from "./helpers.js";

const SIG = `0x${"11".repeat(65)}` as const;

function setup(minDelta = 0n) {
  const chain = new FakeChain();
  const store = new VoucherStore();
  const loop = new SettleLoop(chain, store, { intervalMs: 10_000, minDelta });
  return { chain, store, loop };
}

describe("SettleLoop.tick", () => {
  it("settles a session whose voucher is ahead of on-chain claimed", async () => {
    const { chain, store, loop } = setup();
    chain.sessions.set(sid(), makeSession({ claimed: 0n }));
    store.putVoucher({ sessionId: sid(), cumulativeAmount: 5_000n, signature: SIG });

    const r = await loop.tick();
    expect(r).toEqual({ settled: 1, failed: 0, skipped: 0 });
    expect(chain.settleCalls).toEqual([{ id: sid(), amount: 5_000n, sig: SIG }]);
    expect(store.get(sid())?.settledCumulative).toBe(5_000n);
    expect(store.metrics.settleSent).toBe(1);
  });

  it("does not re-settle on the next tick", async () => {
    const { chain, store, loop } = setup();
    chain.sessions.set(sid(), makeSession());
    store.putVoucher({ sessionId: sid(), cumulativeAmount: 5_000n, signature: SIG });

    await loop.tick();
    const second = await loop.tick();
    expect(second.settled).toBe(0);
    expect(chain.settleCalls).toHaveLength(1);
  });

  it("drops a session that closed on-chain and records its final claimed", async () => {
    const { chain, store, loop } = setup();
    chain.sessions.set(sid(), makeSession({ open: false, claimed: 4_200n }));
    store.putVoucher({ sessionId: sid(), cumulativeAmount: 9_000n, signature: SIG });

    const r = await loop.tick();
    expect(r.settled).toBe(0);
    expect(chain.settleCalls).toHaveLength(0);
    expect(store.get(sid())?.done).toBe(true);
    expect(store.get(sid())?.settledCumulative).toBe(4_200n);
    expect(store.pending()).toHaveLength(0);
  });

  it("drops a session that no longer exists", async () => {
    const { store, loop } = setup();
    store.putVoucher({ sessionId: sid(), cumulativeAmount: 1_000n, signature: SIG });
    const r = await loop.tick();
    expect(r.settled).toBe(0);
    expect(store.get(sid())?.done).toBe(true);
  });

  it("counts a reverting settle as failed without marking it settled", async () => {
    const { chain, store, loop } = setup();
    chain.sessions.set(sid(), makeSession());
    chain.settleError = new Error("execution reverted");
    store.putVoucher({ sessionId: sid(), cumulativeAmount: 5_000n, signature: SIG });

    const r = await loop.tick();
    expect(r).toEqual({ settled: 0, failed: 1, skipped: 0 });
    expect(store.metrics.settleFailed).toBe(1);
    expect(store.get(sid())?.settledCumulative).toBe(0n);
    expect(store.pending()).toHaveLength(1); // stays pending for a retry
  });

  it("skips deltas below minSettleDelta", async () => {
    const { chain, store, loop } = setup(1_000n);
    chain.sessions.set(sid(), makeSession({ claimed: 4_500n }));
    store.putVoucher({ sessionId: sid(), cumulativeAmount: 5_000n, signature: SIG }); // delta 500 < 1000

    const r = await loop.tick();
    expect(r.skipped).toBe(1);
    expect(chain.settleCalls).toHaveLength(0);
  });

  it("sets the author from chain so earnings can be queried", async () => {
    const { chain, store, loop } = setup();
    const author = "0x9999999999999999999999999999999999999999" as const;
    chain.sessions.set(sid(), makeSession({ author }));
    store.putVoucher({ sessionId: sid(), cumulativeAmount: 5_000n, signature: SIG });

    await loop.tick();
    expect(store.earningsByAuthor(author).settledTotal).toBe("5000");
  });
});
