import { describe, expect, it } from "vitest";
import { RATE_TIERS, SESSION_SECONDS_CAP } from "../src/lib/chain";
import { budgetFor, costForMinutes, ratePerSecFromPerMinute, tierById, tierByPerMinute } from "../src/lib/rate";

describe("rate tiers", () => {
  it("Standard tier ≈ 0.25 WMON for a 10-minute read", () => {
    const std = tierById("standard");
    expect(std.perMinute).toBe("0.025");
    expect(costForMinutes(std.perMinute, 10)).toBe("0.25");
  });

  it("ratePerSecFromPerMinute divides the per-minute rate by 60", () => {
    // 0.025 WMON/min = 25e15 wei/min / 60
    expect(ratePerSecFromPerMinute("0.025")).toBe(25_000_000_000_000_000n / 60n);
    expect(ratePerSecFromPerMinute("0.05")).toBe(50_000_000_000_000_000n / 60n);
  });

  it("budgetFor is rate × the 30-minute session cap", () => {
    const r = ratePerSecFromPerMinute("0.025");
    expect(budgetFor(r)).toBe(r * SESSION_SECONDS_CAP);
    expect(SESSION_SECONDS_CAP).toBe(1800n);
  });

  it("all tier rates are safely within uint64 and below their budget", () => {
    const UINT64_MAX = (1n << 64n) - 1n;
    for (const t of RATE_TIERS) {
      const r = ratePerSecFromPerMinute(t.perMinute);
      expect(r).toBeGreaterThan(0n);
      expect(r).toBeLessThan(UINT64_MAX);
      expect(r).toBeLessThan(budgetFor(r));
    }
  });

  it("tierByPerMinute resolves stored strings, falls back to Standard", () => {
    expect(tierByPerMinute("0.05").id).toBe("deep");
    expect(tierByPerMinute(undefined).id).toBe("standard");
    expect(tierByPerMinute("0.999").id).toBe("standard");
  });
});
