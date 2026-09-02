/** Format a base-unit bigint as a decimal string with up to `maxFrac` places. */
export function formatUnits(value: bigint, decimals: number, maxFrac = 4): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, Math.max(0, maxFrac));
  frac = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

export function shortAddress(a: string): string {
  return a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function formatSeconds(s: number): string {
  const sec = Math.max(0, Math.floor(s));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return `${m}m ${r}s`;
}

/** Longer spans: "3h 20m", "12m", "45s". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}
