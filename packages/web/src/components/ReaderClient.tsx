"use client";

import DOMPurify from "dompurify";
import Link from "next/link";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useBalance, usePublicClient, useReadContract, useSignMessage, useWriteContract } from "wagmi";
import { AttentionMeter, type Eip1193Provider } from "@attention-press/reader-sdk";
import { SpendMeter, type MeterSnapshot } from "@/components/SpendMeter";
import { ATTENTION_STREAM, CHAIN_ID, COLLECTOR_URL, erc20Abi, monadTestnet } from "@/lib/chain";
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
      patch({ state: "ended", streamed: e.finalCumulative, engagedSeconds: e.engagedSeconds });
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
  }, [articleId, patch, ratePerSec, budget, unlockBody]);

  const stop = useCallback(async () => {
    try {
      await meterRef.current?.stop("manual");
    } catch {
      /* surfaced via the error event */
    }
  }, []);

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
  const canStart = onChain && enoughBalance;

  return (
    <article>
      <h1>{meta.title}</h1>
      <p className="lede">
        by {meta.authorName ? `${meta.authorName} · ` : ""}
        <Link href={`/profile/${author}`}>
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
    </article>
  );
}
