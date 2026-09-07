"use client";

import DOMPurify from "dompurify";
import Link from "next/link";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeEventLog } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContract, useSignMessage, useWriteContract } from "wagmi";
import { AttentionMeter, type Eip1193Provider } from "@attention-press/reader-sdk";
import { ApproveOnce } from "@/components/ApproveOnce";
import { ArticleActions } from "@/components/ArticleActions";
import { SpendMeter, type MeterSnapshot } from "@/components/SpendMeter";
import {
  ATTENTION_STREAM,
  CHAIN_ID,
  CHALLENGE_WINDOW_SEC,
  COLLECTOR_URL,
  MIN_ALLOWANCE_STREAM,
  STANDING_ALLOWANCE_STREAM,
  attentionStreamAbi,
  erc20Abi,
  monadTestnet,
} from "@/lib/chain";
import { decryptBody } from "@/lib/crypto";
import { formatUnits, shortAddress } from "@/lib/format";
import { contentHashOf, previewText, type ArticleMetadata } from "@/lib/metadata";
import { budgetFor, ratePerSecFromPerMinute, tierByPerMinute } from "@/lib/rate";
import { useHydrated } from "@/lib/useHydrated";

const makeInitialSnap = (budget: bigint, ratePerSec: bigint): MeterSnapshot => ({
  state: "idle",
  pauseReason: null,
  engagedSeconds: 0,
  streamed: 0n,
  budget,
  ratePerSec,
  voucherCount: 0,
  sessionId: null,
  txHash: null,
  error: null,
});

export function ReaderClient({
  articleId,
  meta,
  author,
  contentHash,
  tokenAddress,
  tokenSymbol,
  tokenDecimals,
}: {
  articleId: bigint;
  meta: ArticleMetadata;
  author: `0x${string}`;
  contentHash: `0x${string}`;
  tokenAddress?: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
}) {
  const hydrated = useHydrated();
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const bodyRef = useRef<HTMLDivElement>(null);
  const meterRef = useRef<AttentionMeter | null>(null);

  const tier = tierByPerMinute(meta.ratePerMinute);
  const ratePerSec = ratePerSecFromPerMinute(tier.perMinute);
  const budget = budgetFor(ratePerSec);
  const isEncrypted = !!meta.enc;

  const [snap, setSnap] = useState<MeterSnapshot>(() => makeInitialSnap(budget, ratePerSec));
  const [starting, setStarting] = useState(false);
  // Paywall: full body renders only while a reading session is open. For encrypted
  // articles it also requires the decryption key from the collector.
  const [unlocked, setUnlocked] = useState(false);
  const [decrypted, setDecrypted] = useState<string | null>(null);
  const [unlockErr, setUnlockErr] = useState<string | null>(null);

  // Two-phase close: after `stop()` the refund needs `finalizeSession` once the
  // challenge window elapses (the collector usually does it; this is the fallback).
  const [finalizeAt, setFinalizeAt] = useState<number | null>(null);
  const [finalizeState, setFinalizeState] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [refunded, setRefunded] = useState<bigint | null>(null);
  const [finalizeErr, setFinalizeErr] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // A session recovered from a previous page load (its in-memory meter is gone).
  // `needsClose` = it's still fully open, so phase-1 `closeSession` runs first.
  const [resumed, setResumed] = useState(false);
  const [needsClose, setNeedsClose] = useState(false);
  const [closing, setClosing] = useState(false);

  const sessionStoreKey = useMemo(
    () => (address ? `ap:sess:${articleId}:${address.toLowerCase()}` : null),
    [address, articleId],
  );
  const rememberSession = useCallback(
    (id: string) => {
      if (!sessionStoreKey) return;
      try {
        localStorage.setItem(sessionStoreKey, id);
      } catch {
        /* private mode / storage disabled */
      }
    },
    [sessionStoreKey],
  );
  const forgetSession = useCallback(() => {
    if (!sessionStoreKey) return;
    try {
      localStorage.removeItem(sessionStoreKey);
    } catch {
      /* ignore */
    }
  }, [sessionStoreKey]);

  const challengeWindow = useReadContract({
    address: ATTENTION_STREAM,
    abi: attentionStreamAbi,
    functionName: "challengeWindow",
  });
  const challengeWindowSec = Number(challengeWindow.data ?? BigInt(CHALLENGE_WINDOW_SEC));

  const preview = useMemo(() => previewText(meta), [meta]);
  const bodySource = isEncrypted ? decrypted : unlocked ? (meta.body ?? null) : null;
  const html = useMemo(() => {
    if (!hydrated || !bodySource) return "";
    const raw = marked.parse(bodySource, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [hydrated, bodySource]);

  const patch = useCallback((p: Partial<MeterSnapshot>) => setSnap((s) => ({ ...s, ...p })), []);

  const unlockBody = useCallback(
    async (sessionId: string) => {
      if (!isEncrypted || !meta.enc || !address) return;
      setUnlockErr(null);
      try {
        const ts = Math.floor(Date.now() / 60_000);
        const signature = await signMessageAsync({
          message: `attention-press: unlock article ${articleId} for ${address.toLowerCase()} at ${ts}`,
        });
        const res = await fetch(`${COLLECTOR_URL}/articles/${articleId}/key`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, sessionId, signature, timestamp: ts }),
        });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => ({}))).reason ?? `collector ${res.status}`);
        }
        const { key } = (await res.json()) as { key: string };
        const plaintext = await decryptBody(meta.enc, key);
        if (contentHashOf(plaintext) !== contentHash) {
          throw new Error("content failed its on-chain integrity check");
        }
        setDecrypted(plaintext);
      } catch (e) {
        setUnlockErr(e instanceof Error ? e.message : String(e));
      }
    },
    [isEncrypted, meta.enc, address, articleId, contentHash, signMessageAsync],
  );

  const start = useCallback(async () => {
    if (meterRef.current) return;
    const provider = (globalThis as { ethereum?: unknown }).ethereum;
    if (!provider) {
      patch({ error: "No injected wallet found" });
      return;
    }

    const meter = new AttentionMeter({
      contractAddress: ATTENTION_STREAM,
      chainId: CHAIN_ID,
      articleId,
      ratePerSec,
      budget,
      provider: provider as Eip1193Provider,
      target: bodyRef.current ?? undefined,
      voucherIntervalMs: 5000,
      onVoucher: async (v) => {
        const res = await fetch(`${COLLECTOR_URL}/vouchers`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionId: v.sessionId,
            cumulativeAmount: v.cumulativeAmount.toString(),
            signature: v.signature,
          }),
        });
        if (!res.ok) throw new Error(`collector ${res.status}`);
      },
    });
    meterRef.current = meter;

    meter.on("session:started", (e) => {
      setUnlocked(true);
      rememberSession(e.sessionId);
      patch({ state: "reading", sessionId: e.sessionId, txHash: e.txHash, error: null });
      void unlockBody(e.sessionId);
    });
    meter.on("voucher:signed", (e) =>
      patch({ streamed: e.cumulativeAmount, voucherCount: e.index + 1, engagedSeconds: e.engagedSeconds }),
    );
    meter.on("session:paused", (e) => patch({ state: "paused", pauseReason: e.reason, engagedSeconds: e.engagedSeconds }));
    meter.on("session:resumed", (e) => patch({ state: "reading", pauseReason: null, engagedSeconds: e.engagedSeconds }));
    meter.on("session:ended", (e) => {
      setUnlocked(false);
      setDecrypted(null);
      setUnlockErr(null);
      setFinalizeAt(Date.now() + challengeWindowSec * 1000);
      setFinalizeState("idle");
      patch({ state: "ended", streamed: e.finalCumulative, engagedSeconds: e.engagedSeconds });
    });
    meter.on("session:finalized", (e) => {
      setFinalizeState("done");
      setRefunded(e.refunded);
      forgetSession();
    });
    meter.on("error", (e) =>
      patch({ error: `${e.phase}: ${e.error instanceof Error ? e.error.message : String(e.error)}` }),
    );

    setStarting(true);
    try {
      await meter.start();
    } catch (err) {
      meterRef.current = null;
      patch({ state: "idle", error: err instanceof Error ? err.message : String(err) });
    } finally {
      setStarting(false);
    }
  }, [articleId, patch, ratePerSec, budget, unlockBody, challengeWindowSec, rememberSession, forgetSession]);

  const stop = useCallback(async () => {
    try {
      await meterRef.current?.stop("manual");
    } catch {
      /* surfaced via the error event */
    }
  }, []);

  // 1s clock so the "refund unlocks in …" countdown ticks
  useEffect(() => {
    if (snap.state !== "ended" || finalizeState === "done") return;
    const iv = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [snap.state, finalizeState]);

  // Live-update engaged seconds between voucher events while reading.
  useEffect(() => {
    if (snap.state !== "reading") return;
    const iv = setInterval(() => {
      const m = meterRef.current;
      if (m) setSnap((s) => ({ ...s, engagedSeconds: m.getSnapshot().engagedSeconds }));
    }, 1000);
    return () => clearInterval(iv);
  }, [snap.state]);

  // Close the session if the reader navigates away mid-read.
  useEffect(() => {
    return () => {
      void meterRef.current?.stop("manual").catch(() => {});
    };
  }, []);

  // --- WMON balance + native MON, with a "wrap" helper ---
  const wmon = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!tokenAddress && !!address },
  });
  const mon = useBalance({ address, query: { enabled: !!address } });
  const { writeContractAsync } = useWriteContract();
  const [wrapping, setWrapping] = useState(false);

  const finalize = useCallback(async () => {
    setFinalizeErr(null);
    setFinalizeState("pending");
    try {
      if (meterRef.current) {
        await meterRef.current.finalize();
        // success → `session:finalized` sets state to "done"
        return;
      }
      // Resumed session: no meter, send finalizeSession straight from the wallet.
      const id = snap.sessionId;
      if (!id) throw new Error("no session to finalize");
      const hash = await writeContractAsync({
        address: ATTENTION_STREAM,
        abi: attentionStreamAbi,
        functionName: "finalizeSession",
        args: [id as `0x${string}`],
      });
      const receipt = await publicClient?.waitForTransactionReceipt({ hash });
      let amount: bigint | null = null;
      for (const log of receipt?.logs ?? []) {
        if (log.address.toLowerCase() !== ATTENTION_STREAM.toLowerCase()) continue;
        try {
          const d = decodeEventLog({ abi: attentionStreamAbi, data: log.data, topics: log.topics });
          if (d.eventName === "SessionClosed") amount = (d.args as { refunded: bigint }).refunded;
        } catch {
          /* not the event we want */
        }
      }
      setRefunded(amount);
      setFinalizeState("done");
      forgetSession();
      void wmon.refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/SessionNotOpen/i.test(msg)) {
        // the collector (or someone) already finalized it
        setFinalizeState("done");
        forgetSession();
      } else if (/ChallengeWindowOpen/i.test(msg)) {
        setFinalizeState("idle");
        setFinalizeErr("The challenge window is still open — try again shortly.");
      } else {
        setFinalizeState("error");
        setFinalizeErr(msg);
      }
    }
  }, [snap.sessionId, writeContractAsync, publicClient, forgetSession, wmon]);

  // Resumed a session that was never phase-1 closed — send `closeSession` now,
  // which starts the challenge-window countdown.
  const closeNow = useCallback(async () => {
    const id = snap.sessionId;
    if (!id) return;
    setFinalizeErr(null);
    setClosing(true);
    try {
      const hash = await writeContractAsync({
        address: ATTENTION_STREAM,
        abi: attentionStreamAbi,
        functionName: "closeSession",
        args: [id as `0x${string}`],
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      setNeedsClose(false);
      setFinalizeAt(Date.now() + challengeWindowSec * 1000);
      setFinalizeState("idle");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Someone (or a 7-day abandoned-session sweep) may have closed it already.
      if (/AlreadyClosing/i.test(msg)) {
        setNeedsClose(false);
      } else {
        setFinalizeErr(msg);
      }
    } finally {
      setClosing(false);
    }
  }, [snap.sessionId, writeContractAsync, publicClient, challengeWindowSec]);

  // Standing WMON allowance to AttentionStream — approve once, then openSession
  // is a single confirmation (the SDK skips its own approve when allowance ≥ budget).
  const streamAllowance = useReadContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, ATTENTION_STREAM] : undefined,
    query: { enabled: !!tokenAddress && !!address },
  });

  const wmonBal = wmon.data ?? 0n;
  const monBal = mon.data?.value ?? 0n;
  const enoughBalance = wmonBal >= budget;
  const shortfall = budget > wmonBal ? budget - wmonBal : 0n;
  // wrap the shortfall + a little headroom, if there's native MON to cover it
  const wrapAmount = shortfall + shortfall / 10n;
  const canWrap = monBal > wrapAmount;

  const wrap = useCallback(async () => {
    if (!tokenAddress || !address || wrapAmount === 0n) return;
    setWrapping(true);
    try {
      const hash = await writeContractAsync({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: "deposit",
        value: wrapAmount,
      });
      await publicClient?.waitForTransactionReceipt({ hash });
      await Promise.all([wmon.refetch(), mon.refetch()]);
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      setWrapping(false);
    }
  }, [tokenAddress, address, wrapAmount, writeContractAsync, publicClient, wmon, mon, patch]);

  const onChain = hydrated && isConnected && chainId === CHAIN_ID;
  const allowanceForSession = (streamAllowance.data as bigint | undefined) ?? 0n;
  const allowanceOk = allowanceForSession >= budget;
  const canStart = onChain && enoughBalance && allowanceOk;

  // On load, recover a session from a previous visit that was left open (the
  // in-memory meter and its finalize panel don't survive a reload). Restores the
  // two-phase close UI so the refund is still reachable without a raw chain call.
  useEffect(() => {
    if (!onChain || !address || !publicClient || !sessionStoreKey) return;
    if (meterRef.current || snap.state !== "idle") return;

    let stored: string | null = null;
    try {
      stored = localStorage.getItem(sessionStoreKey);
    } catch {
      return;
    }
    if (!stored || !/^0x[0-9a-fA-F]{64}$/.test(stored)) return;
    const id = stored as `0x${string}`;

    let cancelled = false;
    void (async () => {
      try {
        const [raw, cAt] = await Promise.all([
          publicClient.readContract({
            address: ATTENTION_STREAM,
            abi: attentionStreamAbi,
            functionName: "sessions",
            args: [id],
          }),
          publicClient.readContract({
            address: ATTENTION_STREAM,
            abi: attentionStreamAbi,
            functionName: "closeInitiatedAt",
            args: [id],
          }),
        ]);
        if (cancelled) return;
        // viem returns the struct getter as an object keyed by the ABI output names.
        const arr = raw as readonly unknown[];
        const obj = raw as { reader?: string; claimed?: bigint; open?: boolean };
        const reader = String(obj.reader ?? arr[0] ?? "");
        const claimed = (obj.claimed ?? (arr[4] as bigint) ?? 0n) as bigint;
        const open = Boolean(obj.open ?? arr[8]);

        if (!reader || reader === "0x0000000000000000000000000000000000000000") {
          forgetSession();
          return;
        }
        if (reader.toLowerCase() !== address.toLowerCase() || !open) {
          // finalized, or belongs to a different wallet now — nothing to resume.
          forgetSession();
          return;
        }
        const closeAt = cAt as bigint;
        setResumed(true);
        setNeedsClose(closeAt === 0n);
        setFinalizeAt(closeAt > 0n ? Number(closeAt) * 1000 + challengeWindowSec * 1000 : null);
        setFinalizeState("idle");
        setSnap((prev) => ({ ...prev, state: "ended", sessionId: id, streamed: claimed }));
      } catch {
        /* transient RPC error — try again on the next render that satisfies the guard */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onChain, address, publicClient, sessionStoreKey, snap.state, challengeWindowSec, forgetSession]);

  return (
    <article>
      <h1>{meta.title}</h1>
      <p className="lede">
        by{" "}
        <Link href={`/profile/${author}`}>
          {meta.authorName ? `${meta.authorName} · ` : ""}
          <code>{shortAddress(author)}</code>
        </Link>
      </p>

      {hydrated && !isConnected && (
        <p className="notice">Connect your wallet to start a paid reading session.</p>
      )}
      {hydrated && isConnected && chainId !== CHAIN_ID && <p className="notice">Switch to Monad Testnet.</p>}

      {onChain && (
        <p className="notice" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span>
            <b>{formatUnits(wmonBal, tokenDecimals)} {tokenSymbol}</b> +{" "}
            <b>{formatUnits(monBal, 18)} MON</b> native
            {!enoughBalance && (
              <>
                {" "}
                — need {formatUnits(budget, tokenDecimals)} {tokenSymbol} to open a session
              </>
            )}
          </span>
          {!enoughBalance &&
            (canWrap ? (
              <button className="btn" disabled={wrapping || !tokenAddress} onClick={wrap}>
                {wrapping ? "Wrapping…" : `Wrap ${formatUnits(wrapAmount, 18)} MON → ${tokenSymbol}`}
              </button>
            ) : (
              <span className="muted">not enough native MON to wrap — use the Monad faucet</span>
            ))}
        </p>
      )}

      {onChain && enoughBalance && (
        <ApproveOnce
          spender={ATTENTION_STREAM}
          standing={STANDING_ALLOWANCE_STREAM}
          min={MIN_ALLOWANCE_STREAM}
          what="read"
          tokenSymbol={tokenSymbol}
          tokenDecimals={tokenDecimals}
          onApproved={() => void streamAllowance.refetch()}
        />
      )}

      <SpendMeter
        snap={snap}
        tokenSymbol={tokenSymbol}
        tokenDecimals={tokenDecimals}
        explorerUrl={monadTestnet.blockExplorers.default.url}
        onStart={start}
        onStop={stop}
        canStart={canStart}
        starting={starting}
      />

      {snap.state === "ended" &&
        (() => {
          const refundAmt = budget > snap.streamed ? budget - snap.streamed : 0n;
          const secsLeft = finalizeAt ? Math.max(0, Math.ceil((finalizeAt - nowMs) / 1000)) : 0;
          const canFinalize =
            !needsClose && finalizeAt != null && nowMs >= finalizeAt && finalizeState !== "pending";
          return (
            <div className="approve-once">
              {finalizeState === "done" ? (
                <p className="approve-once-head">
                  ✓ Session closed{" "}
                  {refunded != null
                    ? `— ${formatUnits(refunded, tokenDecimals)} ${tokenSymbol} refunded`
                    : "and refunded"}
                  .
                </p>
              ) : needsClose ? (
                <>
                  <p className="approve-once-head">
                    You left a reading session open — {formatUnits(refundAmt, tokenDecimals)} {tokenSymbol} to refund
                  </p>
                  <p className="muted">
                    Close it to start the {Math.round(challengeWindowSec / 60)}-minute challenge window;
                    your unspent budget is refunded after that.
                  </p>
                  <button className="btn btn-primary" disabled={closing} onClick={closeNow}>
                    {closing ? "Closing…" : "Close session"}
                  </button>
                </>
              ) : (
                <>
                  <p className="approve-once-head">
                    {resumed ? "Session left open on a previous visit" : "Session closed"} —{" "}
                    {formatUnits(refundAmt, tokenDecimals)} {tokenSymbol} to refund
                  </p>
                  <p className="muted">
                    Closing is two-phase: the last voucher settles during a{" "}
                    {Math.round(challengeWindowSec / 60)}-minute challenge window, then your unspent
                    budget is refunded. The author&apos;s collector usually claims it for you — or do it
                    yourself below.
                    {secsLeft > 0 && ` Refund unlocks in ${Math.floor(secsLeft / 60)}m ${secsLeft % 60}s.`}
                  </p>
                  <button className="btn btn-primary" disabled={!canFinalize} onClick={finalize}>
                    {finalizeState === "pending" ? "Claiming…" : "Claim refund now"}
                  </button>
                </>
              )}
              {finalizeErr && <p className="notice err">{finalizeErr}</p>}
            </div>
          );
        })()}

      {/* Stable container so the engagement tracker keeps the same scroll target
          before and after unlock; children swap on session start/end. */}
      <div ref={bodyRef} className="article-body">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <div className="article-locked">
            {preview && <p className="preview-text">{preview}</p>}
            {unlocked && isEncrypted && !decrypted && !unlockErr && (
              <p className="lock-note">Unlocking… approve the signature request in your wallet.</p>
            )}
            {unlockErr && (
              <p className="notice err">
                Couldn&apos;t unlock: {unlockErr}. The session is still open — you can stop it above.
              </p>
            )}
            {!unlocked && (
              <p className="lock-note">
                🔒 The rest is locked. Start a reading session above to unlock the full article —
                you pay the author only for the time you spend reading.
              </p>
            )}
          </div>
        )}
      </div>

      <ArticleActions
        articleId={articleId}
        author={author}
        tokenSymbol={tokenSymbol}
        tokenDecimals={tokenDecimals}
      />
    </article>
  );
}
