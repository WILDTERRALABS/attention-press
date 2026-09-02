import { parseUnits } from "viem";
import { DEFAULT_TIER_ID, RATE_TIERS, SESSION_SECONDS_CAP, type RateTierId } from "./chain";

/** WMON/min string -> wei per second (integer division; sub-wei truncation is fine). */
export function ratePerSecFromPerMinute(perMinute: string): bigint {
  return parseUnits(perMinute, 18) / 60n;
}

/** Hard spend cap for a single session, in payment-token base units. */
export function budgetFor(ratePerSec: bigint): bigint {
  return ratePerSec * SESSION_SECONDS_CAP;
}

export function tierById(id: RateTierId) {
  return RATE_TIERS.find((t) => t.id === id) ?? RATE_TIERS.find((t) => t.id === DEFAULT_TIER_ID)!;
}

/** Resolve an article's stored `perMinute` back to a tier; unknown/missing -> default. */
export function tierByPerMinute(perMinute: string | undefined) {
  return (
    RATE_TIERS.find((t) => t.perMinute === perMinute) ?? RATE_TIERS.find((t) => t.id === DEFAULT_TIER_ID)!
  );
}

/** "≈ 0.25 WMON for a 10-minute read" helper. */
export function costForMinutes(perMinute: string, minutes: number): string {
  const n = Number(perMinute) * minutes;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
