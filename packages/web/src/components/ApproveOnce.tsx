"use client";

import { useState } from "react";
import type { Address } from "viem";
import { useAccount } from "wagmi";
import { useStandingAllowance } from "@/lib/allowance";
import { formatUnits } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";

/**
 * "Approve once, then read / react freely." Shows a single standing-allowance
 * approval when the connected wallet's WMON allowance to `spender` is below
 * `min`; renders nothing once it's covered. Fully discloses the trust tradeoff.
 */
export function ApproveOnce({
  spender,
  standing,
  min,
  what,
  tokenSymbol,
  tokenDecimals,
  onApproved,
}: {
  spender: Address;
  standing: bigint;
  min: bigint;
  /** e.g. "read" / "react and tip" — completes "…then <what> freely." */
  what: string;
  tokenSymbol: string;
  tokenDecimals: number;
  onApproved?: () => void;
}) {
  const hydrated = useHydrated();
  const { address, isConnected } = useAccount();
  const { allowance, sufficient, isLoading, approve } = useStandingAllowance({
    owner: address,
    spender,
    standing,
    min,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!hydrated || !isConnected || isLoading || sufficient) return null;

  const amount = `${formatUnits(standing, tokenDecimals)} ${tokenSymbol}`;

  return (
    <div className="approve-once">
      <p className="approve-once-head">Approve once, then {what} freely</p>
      <p className="muted">
        This sets a standing allowance of <b>{amount}</b> so every reading session and reaction is a
        single wallet confirmation — no separate approval each time. It can be spent <b>only</b> when
        you personally start a session or tap an action; these contracts aren&apos;t upgradeable and
        can&apos;t move your WMON on their own. Revoke anytime in your wallet.
        {allowance > 0n && (
          <> Remaining from a previous approval: {formatUnits(allowance, tokenDecimals)} {tokenSymbol}.</>
        )}
      </p>
      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={async () => {
          setErr(null);
          setBusy(true);
          try {
            await approve();
            onApproved?.();
          } catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Approving…" : `Approve ${amount} (one time)`}
      </button>
      {err && <p className="notice err">{err}</p>}
    </div>
  );
}
