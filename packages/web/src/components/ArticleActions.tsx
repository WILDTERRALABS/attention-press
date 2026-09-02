"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseUnits } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { ACTION_PRICES, ARTICLE_ACTIONS, articleActionsAbi, CHAIN_ID, MAX_REPLY_BYTES } from "@/lib/chain";
import { useArticleActions, useSendAction } from "@/lib/actions";
import { formatUnits, shortAddress } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";

interface ReplyRow {
  index: bigint;
  actor: `0x${string}`;
  text: string;
  block: bigint;
}

const LOG_CHUNK = 100n; // Monad caps eth_getLogs at 100 blocks
const LOG_LOOKBACK = 500n;

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
  const publicClient = usePublicClient();
  const state = useArticleActions(articleId, address);
  const send = useSendAction();

  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [tipAmount, setTipAmount] = useState("1");
  const [replies, setReplies] = useState<ReplyRow[] | null>(null);

  const onChain = hydrated && isConnected && chainId === CHAIN_ID;
  const isAuthor = !!address && address.toLowerCase() === author.toLowerCase();
  const canAct = onChain && !isAuthor && !busy;

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
          setReplyText("");
          void loadReplies();
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [send, state.allowance, state.refetch],
  );

  const loadReplies = useCallback(async () => {
    if (!publicClient || !ARTICLE_ACTIONS) return;
    try {
      const latest = await publicClient.getBlockNumber();
      const start = latest > LOG_LOOKBACK ? latest - LOG_LOOKBACK : 0n;
      const abiEvent = articleActionsAbi.find((x) => x.type === "event" && x.name === "Replied");
      const out: ReplyRow[] = [];
      for (let from = start; from <= latest; from += LOG_CHUNK) {
        const to = from + LOG_CHUNK - 1n > latest ? latest : from + LOG_CHUNK - 1n;
        const logs = await publicClient.getLogs({
          address: ARTICLE_ACTIONS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          event: abiEvent as any,
          args: { articleId },
          fromBlock: from,
          toBlock: to,
        });
        for (const l of logs) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const a = (l as any).args as { index: bigint; actor: `0x${string}`; text: string };
          out.push({ index: a.index, actor: a.actor, text: a.text, block: l.blockNumber ?? 0n });
        }
      }
      out.sort((x, y) => (y.index > x.index ? 1 : y.index < x.index ? -1 : 0));
      setReplies(out);
    } catch {
      setReplies(null); // best-effort; the counter above is still authoritative
    }
  }, [publicClient, articleId]);

  useEffect(() => {
    void loadReplies();
  }, [loadReplies]);

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

      <div className="action-row">
        <button
          className={`btn${state.mine.like ? " on" : ""}`}
          disabled={!canAct || state.mine.like}
          onClick={() => run("like", { functionName: "like", args: [articleId] }, ACTION_PRICES.like)}
          title={`${fmt(ACTION_PRICES.like)} to the author`}
        >
          {busy === "like" ? "…" : "👍"} Like · {state.counts.like.toString()}
        </button>
        <button
          className={`btn${state.mine.dislike ? " on" : ""}`}
          disabled={!canAct || state.mine.dislike}
          onClick={() => run("dislike", { functionName: "dislike", args: [articleId] }, ACTION_PRICES.dislike)}
          title={`${fmt(ACTION_PRICES.dislike)} to the treasury (not the author)`}
        >
          {busy === "dislike" ? "…" : "👎"} Dislike · {state.counts.dislike.toString()}
        </button>
        <button
          className={`btn${state.mine.favorite ? " on" : ""}`}
          disabled={!canAct || state.mine.favorite}
          onClick={() =>
            run("favorite", { functionName: "favorite", args: [articleId] }, ACTION_PRICES.favorite)
          }
          title={`${fmt(ACTION_PRICES.favorite)} to the author`}
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
            disabled={!canAct || tipCost === 0n}
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
          disabled={!canAct || replyBytes === 0 || replyBytes > MAX_REPLY_BYTES}
          onClick={() =>
            run("reply", { functionName: "reply", args: [articleId, replyText] }, ACTION_PRICES.reply)
          }
        >
          {busy === "reply" ? "Posting…" : "Post reply"}
        </button>
      </div>

      {err && <p className="notice err">{err}</p>}

      <div className="replies">
        <h3>Replies · {state.counts.reply.toString()}</h3>
        {replies === null ? (
          <p className="muted">Couldn&apos;t load recent replies from the public RPC — the count above is on-chain truth.</p>
        ) : replies.length === 0 ? (
          <p className="muted">No replies in the last {LOG_LOOKBACK.toString()} blocks.</p>
        ) : (
          <ul>
            {replies.map((r) => (
              <li key={r.index.toString()}>
                <code>{shortAddress(r.actor)}</code> <span className="muted">#{r.index.toString()}</span>
                <p>{r.text}</p>
              </li>
            ))}
          </ul>
        )}
        {state.counts.reply > BigInt(replies?.length ?? 0) && replies !== null && (
          <p className="muted" style={{ fontSize: 13 }}>
            Older replies aren&apos;t shown — full history needs the collector index.
          </p>
        )}
      </div>
    </section>
  );
}
