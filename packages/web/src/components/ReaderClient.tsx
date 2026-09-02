"use client";

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { AttentionMeter, type Eip1193Provider } from "@attention-press/reader-sdk";
import { SpendMeter, type MeterSnapshot } from "@/components/SpendMeter";
import {
  ATTENTION_STREAM,
  CHAIN_ID,
  COLLECTOR_URL,
  DEFAULT_BUDGET,
  DEFAULT_RATE_PER_SEC,
  monadTestnet,
} from "@/lib/chain";
import { shortAddress } from "@/lib/format";
import type { ArticleMetadata } from "@/lib/metadata";

const initialSnap = (): MeterSnapshot => ({
  state: "idle",
  pauseReason: null,
  engagedSeconds: 0,
  streamed: 0n,
  budget: DEFAULT_BUDGET,
  ratePerSec: DEFAULT_RATE_PER_SEC,
  voucherCount: 0,
  sessionId: null,
  txHash: null,
  error: null,
});

export function ReaderClient({
  articleId,
  meta,
  author,
  tokenSymbol,
  tokenDecimals,
}: {
  articleId: bigint;
  meta: ArticleMetadata;
  author: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
}) {
  const { isConnected, chainId } = useAccount();
  const bodyRef = useRef<HTMLDivElement>(null);
  const meterRef = useRef<AttentionMeter | null>(null);
  const [snap, setSnap] = useState<MeterSnapshot>(initialSnap);
  const [starting, setStarting] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const html = useMemo(() => {
    if (!mounted) return "";
    const raw = marked.parse(meta.body, { async: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [mounted, meta.body]);

  const patch = useCallback((p: Partial<MeterSnapshot>) => setSnap((s) => ({ ...s, ...p })), []);

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
      ratePerSec: DEFAULT_RATE_PER_SEC,
      budget: DEFAULT_BUDGET,
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

    meter.on("session:started", (e) => patch({ state: "reading", sessionId: e.sessionId, txHash: e.txHash, error: null }));
    meter.on("voucher:signed", (e) =>
      patch({ streamed: e.cumulativeAmount, voucherCount: e.index + 1, engagedSeconds: e.engagedSeconds }),
    );
    meter.on("session:paused", (e) => patch({ state: "paused", pauseReason: e.reason, engagedSeconds: e.engagedSeconds }));
    meter.on("session:resumed", (e) => patch({ state: "reading", pauseReason: null, engagedSeconds: e.engagedSeconds }));
    meter.on("session:ended", (e) => patch({ state: "ended", streamed: e.finalCumulative, engagedSeconds: e.engagedSeconds }));
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
  }, [articleId, patch]);

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

  const canStart = isConnected && chainId === CHAIN_ID;

  return (
    <article>
      <h1>{meta.title}</h1>
      <p className="lede">
        by {meta.authorName ? `${meta.authorName} · ` : ""}
        <code>{shortAddress(author)}</code>
      </p>

      {!isConnected && <p className="notice">Connect your wallet to start a paid reading session.</p>}
      {isConnected && chainId !== CHAIN_ID && <p className="notice">Switch to Monad Testnet.</p>}

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

      <div ref={bodyRef} className="article-body" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
