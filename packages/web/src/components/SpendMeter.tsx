"use client";

import { formatSeconds, formatUnits } from "@/lib/format";

export interface MeterSnapshot {
  state: "idle" | "starting" | "reading" | "paused" | "stopping" | "ended";
  pauseReason: string | null;
  engagedSeconds: number;
  streamed: bigint;
  budget: bigint;
  ratePerSec: bigint;
  voucherCount: number;
  sessionId: string | null;
  txHash: string | null;
  error: string | null;
}

const DOT: Record<string, string> = { reading: "reading", paused: "paused", ended: "ended", stopping: "ended" };

export function SpendMeter({
  snap,
  tokenSymbol,
  tokenDecimals,
  explorerUrl,
  onStart,
  onStop,
  canStart,
  starting,
}: {
  snap: MeterSnapshot;
  tokenSymbol: string;
  tokenDecimals: number;
  explorerUrl: string;
  onStart: () => void;
  onStop: () => void;
  canStart: boolean;
  starting: boolean;
}) {
  const pct = snap.budget > 0n ? Number((snap.streamed * 10000n) / snap.budget) / 100 : 0;
  const ratePerMin = formatUnits(snap.ratePerSec * 60n, tokenDecimals);
  const active = snap.state === "reading" || snap.state === "paused";

  return (
    <div className="meter">
      <div className="meter-top">
        <span className="meter-state">
          <span className={`dot ${DOT[snap.state] ?? ""}`} />
          {snap.state === "reading" && "Streaming payment"}
          {snap.state === "paused" && `Paused — ${snap.pauseReason ?? ""}`}
          {snap.state === "ended" && "Session ended"}
          {(snap.state === "idle" || snap.state === "starting") && "Not started"}
          {snap.state === "stopping" && "Closing…"}
        </span>
        {!active && snap.state !== "ended" && (
          <button className="btn btn-primary" disabled={!canStart || starting} onClick={onStart}>
            {starting ? "Confirm in wallet…" : "Start reading & paying"}
          </button>
        )}
        {active && (
          <button className="btn" onClick={onStop}>
            Stop & close
          </button>
        )}
      </div>

      <div className="meter-stats">
        <span>
          <b>
            {formatUnits(snap.streamed, tokenDecimals)} {tokenSymbol}
          </b>
          streamed to author
        </span>
        <span>
          <b>{formatSeconds(snap.engagedSeconds)}</b>
          engaged reading
        </span>
        <span>
          <b>
            {formatUnits(snap.budget - snap.streamed, tokenDecimals)} {tokenSymbol}
          </b>
          budget left
        </span>
        <span>
          <b>{ratePerMin}/min</b>
          rate · {snap.voucherCount} vouchers
        </span>
      </div>

      <div className="bar">
        <i style={{ width: `${Math.min(100, pct)}%` }} />
      </div>

      {snap.txHash && (
        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          session{" "}
          <a href={`${explorerUrl}/tx/${snap.txHash}`} target="_blank" rel="noreferrer">
            {snap.txHash.slice(0, 10)}…
          </a>
        </p>
      )}
      {snap.error && <p className="notice err" style={{ marginTop: 8 }}>{snap.error}</p>}
    </div>
  );
}
