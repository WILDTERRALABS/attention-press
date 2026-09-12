"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUnits } from "viem";
import { useAccount } from "wagmi";
import {
  ACTION_PRICES,
  ARTICLE_ACTIONS,
  CHAIN_ID,
  COLLECTOR_URL,
  MAX_REPLY_BYTES,
  MIN_ALLOWANCE_ACTIONS,
  STANDING_ALLOWANCE_ACTIONS,
} from "@/lib/chain";
import { useArticleActions, useSendAction } from "@/lib/actions";
import { ApproveOnce } from "@/components/ApproveOnce";
import { formatUnits, shortAddress } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";

interface ReplyRow {
  index: number;
  actor: `0x${string}`;
  text: string;
  blockNumber: number;
  blockTime: number;
}

const REPLY_PAGE = 50;
const REPLY_POLL_MS = 20_000; // ~matches the collector's reply-index interval

export function ArticleActions({
  articleId,
  author,
  tokenSymbol,
  tokenDecimals,
}: {
  articleId: bigint;
  author: `0x${string}`;
  tokenSymbol: string;
  tokenDecimals: number;
}) {
  const hydrated = useHydrated();
  const { address, isConnected, chainId } = useAccount();
  const state = useArticleActions(articleId, address);
  const send = useSendAction();

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [tipAmount, setTipAmount] = useState("1");
  // Replies come from the collector's reply index (GET /articles/:id/replies),
  // chronological, paginated. `null` = the collector was unreachable.
  const [replies, setReplies] = useState<ReplyRow[] | null>(null);
  const [replyTotal, setReplyTotal] = useState(0);
  const [replyCursor, setReplyCursor] = useState<number | null>(null);
  const [loadingReplies, setLoadingReplies] = useState(false);
  // Just-posted replies shown until the indexer catches up (dedup by index).
  const optimistic = useRef<ReplyRow[]>([]);

  const onChain = hydrated && isConnected && chainId === CHAIN_ID;
  const isAuthor = !!address && address.toLowerCase() === author.toLowerCase();
  const canAct = onChain && !isAuthor && !busy;
  // Gate each button on its own price so the visible `<ApproveOnce>` panel above
  // is the one place a WMON approve tx happens — clicking a button the current
  // allowance can't cover surfaces the approve panel instead of silently
  // sending a second (approve + action) popup pair.
  const canAfford = useCallback((cost: bigint) => state.allowance >= cost, [state.allowance]);

  const fmt = useCallback(
    (v: bigint) => `${formatUnits(v, tokenDecimals)} ${tokenSymbol}`,
    [tokenDecimals, tokenSymbol],
  );

  const run = useCallback(
    async (
      label: string,
      call: { functionName: "like" | "dislike" | "favorite" | "reply" | "tip"; args: unknown[] },
      cost: bigint,
    ) => {
      setErr(null);
      setBusy(label);
      try {
        await send(call, cost, state.allowance);
        state.refetch();
        if (call.functionName === "reply") {
          const text = replyText;
          setReplyText("");
          if (address) {
            optimistic.current = [
              ...optimistic.current,
              {
                index: Number(state.counts.reply),
                actor: address,
                text,
                blockNumber: 0,
                blockTime: Math.floor(Date.now() / 1000),
              },
            ];
          }
          setTimeout(() => void fetchReplies(0), 4000);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send, state.allowance, state.refetch, state.counts.reply, replyText, address],
  );

  const fetchReplies = useCallback(
    async (cursor = 0, append = false) => {
      if (!ARTICLE_ACTIONS) return;
      setLoadingReplies(true);
      try {
        const res = await fetch(
          `${COLLECTOR_URL}/articles/${articleId}/replies?order=asc&limit=${REPLY_PAGE}&cursor=${cursor}`,
        );
        if (!res.ok) throw new Error(`collector ${res.status}`);
        const body = (await res.json()) as {
          total: number;
          nextCursor: number | null;
          replies: ReplyRow[];
        };
        setReplyTotal(body.total);
        setReplyCursor(body.nextCursor);
        setReplies((prev) => (append && prev ? [...prev, ...body.replies] : body.replies));
        // drop any optimistic entries the indexer has now picked up
        const seen = new Set(body.replies.map((r) => r.index));
        optimistic.current = optimistic.current.filter(
          (o) => !seen.has(o.index) && Date.now() / 1000 - o.blockTime < 120,
        );
      } catch {
        if (!append) setReplies((prev) => prev ?? null); // unreachable; count above is authoritative
      } finally {
        setLoadingReplies(false);
      }
    },
    [articleId],
  );

  useEffect(() => {
    void fetchReplies(0);
    const iv = setInterval(() => void fetchReplies(0), REPLY_POLL_MS);
    return () => clearInterval(iv);
  }, [fetchReplies]);

  const shownReplies = useMemo(() => {
    const base = replies ?? [];
    const have = new Set(base.map((r) => r.index));
    return [...base, ...optimistic.current.filter((o) => !have.has(o.index))];
  }, [replies]);

  const tipCost = useMemo(() => {
    try {
      const v = parseUnits(tipAmount || "0", tokenDecimals);
      return v > 0n ? v : 0n;
    } catch {
      return 0n;
    }
  }, [tipAmount, tokenDecimals]);

  const replyBytes = useMemo(() => new TextEncoder().encode(replyText).length, [replyText]);

  if (!state.configured) {
    return (
      <section className="actions">
        <h2>Reactions &amp; replies</h2>
        <p className="muted">
          Paid actions aren&apos;t configured yet — deploy <code>ArticleActions</code> and set{" "}
          <code>NEXT_PUBLIC_ARTICLE_ACTIONS</code>.
        </p>
      </section>
    );
  }

  return (
    <section className="actions">
      <h2>Reactions &amp; replies</h2>

      {hydrated && !isConnected && <p className="muted">Connect your wallet to react, reply, or tip.</p>}
      {hydrated && isConnected && chainId !== CHAIN_ID && <p className="muted">Switch to Monad Testnet.</p>}
      {isAuthor && <p className="muted">You&apos;re the author — you can&apos;t react to or tip your own article.</p>}

      {onChain && !isAuthor && (
        <ApproveOnce
          spender={ARTICLE_ACTIONS as `0x${string}`}
          standing={STANDING_ALLOWANCE_ACTIONS}
          min={MIN_ALLOWANCE_ACTIONS}
          what="react and tip"
          tokenSymbol={tokenSymbol}
          tokenDecimals={tokenDecimals}
          onApproved={() => state.refetch()}
        />
      )}

      <div className="action-row">
        <button
          className={`btn${state.mine.like ? " on" : ""}`}
          disabled={!canAct || state.mine.like || !canAfford(ACTION_PRICES.like)}
          onClick={() => run("like", { functionName: "like", args: [articleId] }, ACTION_PRICES.like)}
          title={
            canAfford(ACTION_PRICES.like)
              ? `${fmt(ACTION_PRICES.like)} to the author`
              : `Approve above first — ${fmt(ACTION_PRICES.like)} needed`
          }
        >
          {busy === "like" ? "…" : "👍"} Like · {state.counts.like.toString()}
        </button>
        <button
          className={`btn${state.mine.dislike ? " on" : ""}`}
          disabled={!canAct || state.mine.dislike || !canAfford(ACTION_PRICES.dislike)}
          onClick={() => run("dislike", { functionName: "dislike", args: [articleId] }, ACTION_PRICES.dislike)}
          title={
            canAfford(ACTION_PRICES.dislike)
              ? `${fmt(ACTION_PRICES.dislike)} to the treasury (not the author)`
              : `Approve above first — ${fmt(ACTION_PRICES.dislike)} needed`
          }
        >
          {busy === "dislike" ? "…" : "👎"} Dislike · {state.counts.dislike.toString()}
        </button>
        <button
          className={`btn${state.mine.favorite ? " on" : ""}`}
          disabled={!canAct || state.mine.favorite || !canAfford(ACTION_PRICES.favorite)}
          onClick={() =>
            run("favorite", { functionName: "favorite", args: [articleId] }, ACTION_PRICES.favorite)
          }
          title={
            canAfford(ACTION_PRICES.favorite)
              ? `${fmt(ACTION_PRICES.favorite)} to the author`
              : `Approve above first — ${fmt(ACTION_PRICES.favorite)} needed`
          }
        >
          {busy === "favorite" ? "…" : "⭐"} Favorite · {state.counts.favorite.toString()}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Like / favorite / reply pay the author (minus a small protocol fee). Dislike pays the treasury only.
        One like, one dislike, one favorite per wallet. {onChain && <>Your WMON: {fmt(state.balance)}.</>}
      </p>

      <div className="action-block">
        <label htmlFor="tip">Tip the author</label>
        <div className="action-inline">
          <input
            id="tip"
            type="number"
            min="0"
            step="0.1"
            value={tipAmount}
            onChange={(e) => setTipAmount(e.target.value)}
          />
          <span className="muted">{tokenSymbol}</span>
          <button
            className="btn"
            disabled={!canAct || tipCost === 0n || !canAfford(tipCost)}
            title={canAfford(tipCost) ? undefined : `Approve above first — ${fmt(tipCost)} needed`}
            onClick={() => run("tip", { functionName: "tip", args: [articleId, tipCost] }, tipCost)}
          >
            {busy === "tip" ? "Tipping…" : "Send tip"}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Tipped so far: {fmt(state.counts.tipped)}</p>
      </div>

      <div className="action-block">
        <label htmlFor="reply">
          Reply — {fmt(ACTION_PRICES.reply)} · {replyBytes}/{MAX_REPLY_BYTES} bytes
        </label>
        <textarea
          id="reply"
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          placeholder="Say something worth 2 WMON…"
          rows={3}
        />
        <button
          className="btn"
          disabled={
            !canAct || replyBytes === 0 || replyBytes > MAX_REPLY_BYTES || !canAfford(ACTION_PRICES.reply)
          }
          title={canAfford(ACTION_PRICES.reply) ? undefined : `Approve above first — ${fmt(ACTION_PRICES.reply)} needed`}
          onClick={() =>
            run("reply", { functionName: "reply", args: [articleId, replyText] }, ACTION_PRICES.reply)
          }
        >
          {busy === "reply" ? "Posting…" : "Post reply"}
        </button>
      </div>

      {err && <p className="notice err">{err}</p>}

      <div className="replies">
        <h3>Replies · {replies === null ? state.counts.reply.toString() : replyTotal}</h3>
        {replies === null ? (
          <p className="muted">
            Couldn&apos;t reach the reply index — {state.counts.reply.toString()} on-chain, shown when the
            collector is back.
          </p>
        ) : shownReplies.length === 0 ? (
          <p className="muted">No replies yet. Be the first — 2 {tokenSymbol}.</p>
        ) : (
          <>
            <ul>
              {shownReplies.map((r) => (
                <li key={r.index}>
                  <code>{shortAddress(r.actor)}</code> <span className="muted">#{r.index}</span>
                  {r.blockNumber === 0 && <span className="muted"> · posting…</span>}
                  <p>{r.text}</p>
                </li>
              ))}
            </ul>
            {replyCursor !== null && (
              <button
                className="btn"
                disabled={loadingReplies}
                onClick={() => void fetchReplies(replyCursor, true)}
              >
                {loadingReplies ? "Loading…" : `Show ${replyTotal - shownReplies.length} more`}
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
