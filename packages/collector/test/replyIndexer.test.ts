import { describe, it, expect } from "vitest";
import { ReplyIndexer } from "../src/replyIndexer.js";
import { VoucherStore } from "../src/store.js";
import { FakeChain, makeRepliedLog } from "./helpers.js";

function setup(opts: Partial<Parameters<typeof mk>[2]> = {}) {
  return mk(new FakeChain(), new VoucherStore(), {
    intervalMs: 10_000,
    fromBlock: 0n,
    rangeSize: 1_000,
    reorgBuffer: 5n,
    minRange: 10n,
    ...opts,
  });
}
function mk(chain: FakeChain, store: VoucherStore, o: ConstructorParameters<typeof ReplyIndexer>[2]) {
  return { chain, store, indexer: new ReplyIndexer(chain, store, o) };
}

describe("ReplyIndexer", () => {
  it("backfills every Replied log across multiple range windows", async () => {
    const { chain, store, indexer } = setup({ rangeSize: 100 });
    chain.head = 350n;
    chain.repliedLogs = [
      makeRepliedLog({ articleId: 1n, index: 0n, blockNumber: 20n, text: "first" }),
      makeRepliedLog({ articleId: 1n, index: 1n, blockNumber: 140n, text: "second" }),
      makeRepliedLog({ articleId: 2n, index: 0n, blockNumber: 260n, text: "other article" }),
    ];

    const r = await indexer.runOnce();
    expect(r.added).toBe(3);
    expect(store.getReplyCursor()).toBe(350n);
    expect(store.replyCount("1")).toBe(2);
    expect(store.replyCount("2")).toBe(1);
    expect(store.repliesFor("1").items.map((x) => x.text)).toEqual(["first", "second"]);
    // 100-block windows: [0-99],[100-199],[200-299],[300-350]
    expect(chain.getLogsCalls).toHaveLength(4);
  });

  it("is idempotent — a second pass adds nothing and does not duplicate", async () => {
    const { chain, store, indexer } = setup();
    chain.head = 200n;
    chain.repliedLogs = [
      makeRepliedLog({ index: 0n, blockNumber: 10n }),
      makeRepliedLog({ index: 1n, blockNumber: 20n }),
    ];

    await indexer.runOnce();
    const second = await indexer.runOnce();
    expect(second.added).toBe(0);
    expect(store.replyCount("1")).toBe(2);
  });

  it("picks up new logs after the cursor on a later pass and advances it", async () => {
    const { chain, store, indexer } = setup();
    chain.head = 100n;
    chain.repliedLogs = [makeRepliedLog({ index: 0n, blockNumber: 50n })];
    await indexer.runOnce();
    expect(store.replyCount("1")).toBe(1);
    expect(store.getReplyCursor()).toBe(100n);

    chain.head = 500n;
    chain.repliedLogs.push(makeRepliedLog({ index: 1n, blockNumber: 300n, text: "later" }));
    const r = await indexer.runOnce();
    expect(r.added).toBe(1);
    expect(store.getReplyCursor()).toBe(500n);
    expect(store.repliesFor("1").items.map((x) => x.text)).toEqual(["a reply", "later"]);
  });

  it("shrinks the window adaptively when getLogs rejects a too-wide range", async () => {
    const { chain, store, indexer } = setup({ rangeSize: 1_000, minRange: 100n });
    chain.head = 5_000n; // big enough that the first window is the full rangeSize
    chain.maxLogRange = 150; // provider rejects any span > 150 blocks
    chain.repliedLogs = [makeRepliedLog({ index: 0n, blockNumber: 375n })];

    const r = await indexer.runOnce();
    expect(r.added).toBe(1);
    expect(store.getReplyCursor()).toBe(5_000n);
    // 0-999 (1000) throws -> 500 throws -> 250 throws -> 125 ok, then stays 125-wide to head
    const widths = chain.getLogsCalls.map((c) => Number(c.to - c.from + 1n));
    expect(widths.filter((w) => w > 150)).toEqual([1_000, 500, 250]); // the shrink attempts
    expect(widths.filter((w) => w <= 150).every((w) => w <= 125)).toBe(true); // successes never widen again
    expect(widths.filter((w) => w === 125).length).toBeGreaterThan(10); // walked to head in 125s
  });

  it("remembers a shrunk range across passes — no repeated shrinking", async () => {
    const { chain, store, indexer } = setup({ rangeSize: 1_000, minRange: 100n, reorgBuffer: 0n });
    chain.head = 2_000n;
    chain.maxLogRange = 150;
    await indexer.runOnce(); // shrinks 1000 -> ... -> 125
    const callsAfterFirst = chain.getLogsCalls.length;

    chain.head = 5_000n;
    await indexer.runOnce(); // must NOT retry 1000/500/250 again
    const widthsSecondPass = chain.getLogsCalls
      .slice(callsAfterFirst)
      .map((c) => Number(c.to - c.from + 1n));
    expect(widthsSecondPass.every((w) => w <= 125)).toBe(true);
  });

  it("re-scans the reorg buffer without duplicating", async () => {
    const { chain, store, indexer } = setup({ reorgBuffer: 20n });
    chain.head = 100n;
    chain.repliedLogs = [makeRepliedLog({ index: 0n, blockNumber: 95n })];
    await indexer.runOnce();
    expect(store.getReplyCursor()).toBe(100n);

    chain.head = 120n;
    await indexer.runOnce(); // rescans from ~81 (100+1-20) — block 95 seen again
    expect(store.replyCount("1")).toBe(1);
  });

  it("attaches block timestamps, fetching each distinct block once", async () => {
    const { chain, store, indexer } = setup();
    chain.head = 100n;
    chain.blockTimes.set(40n, 1_788_000_000n);
    chain.repliedLogs = [
      makeRepliedLog({ index: 0n, blockNumber: 40n }),
      makeRepliedLog({ index: 1n, blockNumber: 40n }), // same block
      makeRepliedLog({ index: 2n, blockNumber: 60n }),
    ];

    await indexer.runOnce();
    const items = store.repliesFor("1").items;
    expect(items[0]!.blockTime).toBe(1_788_000_000);
    expect(items[1]!.blockTime).toBe(1_788_000_000);
    expect(chain.blockTimeCalls.filter((b) => b === 40n)).toHaveLength(1); // cached
  });

  it("honours fromBlock and never scans below it", async () => {
    const { chain, store, indexer } = setup({ fromBlock: 5_000n, rangeSize: 1_000 });
    chain.head = 6_500n;
    chain.repliedLogs = [makeRepliedLog({ index: 0n, blockNumber: 6_000n })];

    await indexer.runOnce();
    expect(chain.getLogsCalls[0]!.from).toBe(5_000n);
    expect(store.replyCount("1")).toBe(1);
  });

  it("does nothing when the resume point is already past head", async () => {
    const { chain, store, indexer } = setup({ fromBlock: 9_000n });
    chain.head = 100n;
    const r = await indexer.runOnce();
    expect(r.added).toBe(0);
    expect(chain.getLogsCalls).toHaveLength(0);
  });
});
