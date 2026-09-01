import { describe, it, expect } from "vitest";
import { computeCumulative, isBudgetExhausted } from "../src/session/accrual.js";

const rate = 1_000_000_000_000n; // wei/sec
const budget = 60n * rate; // 60 seconds of reading

const base = { ratePerSec: rate, budget, previousCumulative: 0n };

describe("computeCumulative", () => {
  it("scales linearly with engaged seconds", () => {
    expect(computeCumulative({ ...base, engagedSeconds: 10, elapsedSeconds: 10 })).toBe(10n * rate);
  });

  it("floors partial seconds to match on-chain integer math", () => {
    expect(computeCumulative({ ...base, engagedSeconds: 10.9, elapsedSeconds: 11 })).toBe(10n * rate);
  });

  it("never exceeds the budget", () => {
    expect(computeCumulative({ ...base, engagedSeconds: 9_999, elapsedSeconds: 9_999 })).toBe(budget);
  });

  it("never exceeds the on-chain rate cap ratePerSec*(elapsed+1)", () => {
    // engaged somehow ahead of the wall clock -> clamp to (elapsed + 1) * rate
    expect(computeCumulative({ ...base, engagedSeconds: 50, elapsedSeconds: 5 })).toBe(6n * rate);
  });

  it("is monotonic — never returns below previousCumulative", () => {
    expect(
      computeCumulative({ ...base, engagedSeconds: 3, elapsedSeconds: 100, previousCumulative: 20n * rate }),
    ).toBe(20n * rate);
  });

  it("clamps negative / NaN inputs to zero", () => {
    expect(computeCumulative({ ...base, engagedSeconds: -5, elapsedSeconds: -5 })).toBe(0n);
    expect(computeCumulative({ ...base, engagedSeconds: Number.NaN, elapsedSeconds: 10 })).toBe(0n);
  });
});

describe("isBudgetExhausted", () => {
  it("is true only at or above the budget", () => {
    expect(isBudgetExhausted(budget, budget)).toBe(true);
    expect(isBudgetExhausted(budget + 1n, budget)).toBe(true);
    expect(isBudgetExhausted(budget - 1n, budget)).toBe(false);
  });
});
