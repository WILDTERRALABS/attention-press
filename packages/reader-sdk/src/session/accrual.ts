/**
 * Turn engaged reading time into the next voucher's `cumulativeAmount`, clamped
 * to every constraint `AttentionStream` enforces on-chain:
 *
 *   - monotonic:  never below the previous cumulative
 *   - budget cap: `<= budget`
 *   - rate cap:   `<= ratePerSec * (wallClockElapsed + 1)`   (the contract adds 1s slack)
 *
 * Because we only ever accumulate *engaged* time, `engagedSeconds <= elapsedSeconds`
 * always holds, so in normal operation the rate clamp never binds — it is here as
 * defence against a clock glitch or a caller passing bad numbers.
 *
 * Seconds are floored to match the contract's integer `ratePerSec * seconds` math.
 */
function toWholeSeconds(n: number): bigint {
  return Number.isFinite(n) ? BigInt(Math.max(0, Math.floor(n))) : 0n;
}

export function computeCumulative(args: {
  engagedSeconds: number;
  elapsedSeconds: number;
  ratePerSec: bigint;
  budget: bigint;
  previousCumulative: bigint;
}): bigint {
  const engaged = toWholeSeconds(args.engagedSeconds);
  const elapsed = toWholeSeconds(args.elapsedSeconds);

  let next = args.ratePerSec * engaged;

  const rateCap = args.ratePerSec * (elapsed + 1n);
  if (next > rateCap) next = rateCap;
  if (next > args.budget) next = args.budget;
  if (next < args.previousCumulative) next = args.previousCumulative;

  return next;
}

export function isBudgetExhausted(cumulative: bigint, budget: bigint): boolean {
  return cumulative >= budget;
}
