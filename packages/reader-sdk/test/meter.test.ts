import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Hex } from "viem";
import { AttentionMeter } from "../src/AttentionMeter.js";
import type { AttentionMeterConfig, MeterEventMap } from "../src/types.js";
import type { OpenSessionFn } from "../src/chain/openSession.js";
import type { CloseSessionFn } from "../src/chain/closeSession.js";

const RATE = 1_000_000_000_000n;
const SESSION_ID = ("0x" + "cd".repeat(32)) as Hex;
const CONTRACT = "0x2222222222222222222222222222222222222222" as const;
const READER = "0x3333333333333333333333333333333333333333" as const;
const AUTHOR = "0x4444444444444444444444444444444444444444" as const;

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function harness(configOverrides: Partial<AttentionMeterConfig> = {}, opts: { closeFn?: CloseSessionFn } = {}) {
  const openCalls: unknown[] = [];
  const closeCalls: unknown[] = [];

  const openSession: OpenSessionFn = async (p) => {
    openCalls.push(p);
    return { sessionId: SESSION_ID, txHash: "0xopen" as Hex, reader: READER, author: AUTHOR };
  };
  const closeSession: CloseSessionFn =
    opts.closeFn ??
    (async (p) => {
      closeCalls.push(p);
      return "0xclose" as Hex;
    });

  const events: Array<{ name: keyof MeterEventMap; payload: unknown }> = [];
  const meter = new AttentionMeter(
    {
      contractAddress: CONTRACT,
      chainId: 10143,
      articleId: 1n,
      ratePerSec: RATE,
      budget: 60n * RATE,
      provider: { request: async () => { throw new Error("provider should not be used in these tests"); } },
      voucherIntervalMs: 5_000,
      idleTimeoutMs: 30_000,
      ...configOverrides,
    },
    { openSession, closeSession },
  );

  for (const name of [
    "session:started",
    "voucher:signed",
    "session:paused",
    "session:resumed",
    "session:ended",
    "error",
  ] as const) {
    meter.on(name, (payload) => events.push({ name, payload }));
  }

  return { meter, events, openCalls, closeCalls };
}

const pick = (events: Array<{ name: keyof MeterEventMap; payload: unknown }>, name: keyof MeterEventMap) =>
  events.filter((e) => e.name === name).map((e) => e.payload);

describe("AttentionMeter lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.hasFocus = () => true;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("opens a session and emits session:started, then reads", async () => {
    const { meter, events } = harness();
    await meter.start();

    const started = pick(events, "session:started");
    expect(started).toHaveLength(1);
    expect((started[0] as { sessionId: Hex }).sessionId).toBe(SESSION_ID);
    expect((started[0] as { txHash: Hex }).txHash).toBe("0xopen");
    expect(meter.getState()).toBe("reading");

    await meter.stop();
  });

  it("signs an increasing voucher every interval while engaged and delivers it", async () => {
    const delivered: bigint[] = [];
    const { meter, events } = harness({ onVoucher: (v) => void delivered.push(v.cumulativeAmount) });
    await meter.start();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    const vouchers = pick(events, "voucher:signed") as Array<{ cumulativeAmount: bigint; index: number }>;
    expect(vouchers.length).toBeGreaterThanOrEqual(2);
    expect(vouchers[0]!.cumulativeAmount).toBe(5n * RATE);
    expect(vouchers[1]!.cumulativeAmount).toBe(10n * RATE);
    expect(vouchers[1]!.index).toBe(1);
    expect(delivered).toEqual([5n * RATE, 10n * RATE]);

    await meter.stop();
  });

  it("pauses accrual when the tab is hidden and resumes when visible", async () => {
    const { meter, events } = harness();
    await meter.start();

    await vi.advanceTimersByTimeAsync(5_000); // -> voucher at 5s
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(20_000); // no accrual, no new voucher
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(5_000); // -> voucher at ~10s engaged

    expect(pick(events, "session:paused").map((p) => (p as { reason: string }).reason)).toEqual(["hidden"]);
    expect(pick(events, "session:resumed")).toHaveLength(1);

    const vouchers = pick(events, "voucher:signed") as Array<{ cumulativeAmount: bigint }>;
    expect(vouchers.at(-1)!.cumulativeAmount).toBe(10n * RATE);

    await meter.stop();
  });

  it("pause()/resume() emit manual pause and resume", async () => {
    const { meter, events } = harness();
    await meter.start();
    meter.pause();
    meter.resume();
    expect(pick(events, "session:paused").map((p) => (p as { reason: string }).reason)).toEqual(["manual"]);
    expect(pick(events, "session:resumed")).toHaveLength(1);
    await meter.stop();
  });

  it("ends with reason budget-exhausted and closes on-chain once the cap is hit", async () => {
    const { meter, events, closeCalls } = harness({ budget: 3n * RATE, voucherIntervalMs: 1_000 });
    await meter.start();

    await vi.advanceTimersByTimeAsync(10_000);

    const ended = pick(events, "session:ended") as Array<{ reason: string; finalCumulative: bigint; txHash?: Hex }>;
    expect(ended).toHaveLength(1);
    expect(ended[0]!.reason).toBe("budget-exhausted");
    expect(ended[0]!.finalCumulative).toBe(3n * RATE);
    expect(ended[0]!.txHash).toBe("0xclose");
    expect(closeCalls).toHaveLength(1);
    expect((closeCalls[0] as { cumulativeAmount: bigint }).cumulativeAmount).toBe(3n * RATE);
    expect(meter.getState()).toBe("ended");
  });

  it("stop() signs a final voucher, closes, and blocks restart", async () => {
    const { meter, events, closeCalls } = harness();
    await meter.start();
    await vi.advanceTimersByTimeAsync(3_200); // 3 engaged seconds, no interval voucher yet

    await meter.stop();

    const ended = pick(events, "session:ended") as Array<{ reason: string; txHash?: Hex }>;
    expect(ended[0]!.reason).toBe("manual");
    expect(ended[0]!.txHash).toBe("0xclose");
    expect((closeCalls[0] as { cumulativeAmount: bigint }).cumulativeAmount).toBe(3n * RATE);

    await expect(meter.start()).rejects.toThrow(/invalid in state/);
  });

  it("surfaces onVoucher delivery failures as error events without stopping", async () => {
    const { meter, events } = harness({
      onVoucher: () => {
        throw new Error("collector down");
      },
    });
    await meter.start();
    await vi.advanceTimersByTimeAsync(5_000);

    const errs = pick(events, "error") as Array<{ phase: string }>;
    expect(errs.some((e) => e.phase === "deliver")).toBe(true);
    expect(meter.getState()).toBe("reading");
    await meter.stop();
  });

  it("propagates a failed openSession as an error event and stays idle", async () => {
    const failingOpen: OpenSessionFn = async () => {
      throw new Error("user rejected");
    };
    const events: Array<{ name: string; payload: unknown }> = [];
    const meter = new AttentionMeter(
      {
        contractAddress: CONTRACT,
        chainId: 10143,
        articleId: 1n,
        ratePerSec: RATE,
        budget: 60n * RATE,
        provider: { request: async () => undefined },
      },
      { openSession: failingOpen },
    );
    meter.on("error", (p) => events.push({ name: "error", payload: p }));

    await expect(meter.start()).rejects.toThrow(/user rejected/);
    expect(events).toHaveLength(1);
    expect(meter.getState()).toBe("idle");
  });
});

describe("AttentionMeter config validation", () => {
  const good: AttentionMeterConfig = {
    contractAddress: CONTRACT,
    chainId: 10143,
    articleId: 1n,
    ratePerSec: RATE,
    budget: 60n * RATE,
    provider: { request: async () => undefined },
  };

  it("rejects out-of-range and nonsensical values", () => {
    expect(() => new AttentionMeter({ ...good, budget: 0n })).toThrow(/budget/);
    expect(() => new AttentionMeter({ ...good, ratePerSec: 0n })).toThrow(/ratePerSec/);
    expect(() => new AttentionMeter({ ...good, ratePerSec: good.budget + 1n })).toThrow(/ratePerSec cannot exceed budget/);
    expect(() => new AttentionMeter({ ...good, chainId: 0 })).toThrow(/chainId/);
    expect(() => new AttentionMeter({ ...good, articleId: (1n << 64n) })).toThrow(/uint64/);
    // @ts-expect-error deliberately wrong
    expect(() => new AttentionMeter({ ...good, sessionKeyStorage: "local" })).toThrow(/memory only/);
  });
});
