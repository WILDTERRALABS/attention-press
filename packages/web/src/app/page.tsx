"use client";

import { useEffect, useMemo, useState } from "react";
import { useReadContract } from "wagmi";
import { ArticleCard } from "@/components/ArticleCard";
import { AuthorCard } from "@/components/AuthorCard";
import { useArticles } from "@/lib/articles";
import { useAuthors } from "@/lib/authors";
import { ATTENTION_STREAM, COLLECTOR_URL, attentionStreamAbi, erc20Abi } from "@/lib/chain";

const TOP_AUTHORS = 15;

export default function HomePage() {
  const [tab, setTab] = useState<"articles" | "authors">("articles");
  const { articles, isLoading } = useArticles();
  const { authors } = useAuthors();

  const token = useReadContract({ address: ATTENTION_STREAM, abi: attentionStreamAbi, functionName: "token" });
  const symbol = useReadContract({ address: token.data, abi: erc20Abi, functionName: "symbol", query: { enabled: !!token.data } });
  const decimals = useReadContract({ address: token.data, abi: erc20Abi, functionName: "decimals", query: { enabled: !!token.data } });
  const tokenSymbol = symbol.data ?? "tokens";
  const tokenDecimals = decimals.data ?? 18;

  const visible = articles.filter((a) => !a.retired);
  const topAuthors = useMemo(() => authors.slice(0, TOP_AUTHORS), [authors]);

  const [bios, setBios] = useState<Record<string, string>>({});
  useEffect(() => {
    if (tab !== "authors" || topAuthors.length === 0) return;
    const list = topAuthors.map((a) => a.address).join(",");
    let live = true;
    fetch(`${COLLECTOR_URL}/profiles?addresses=${list}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((rec: Record<string, { text?: string }>) => {
        if (!live) return;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(rec)) if (v?.text) out[k] = v.text;
        setBios(out);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tab, topAuthors]);

  return (
    <>
      <h1>{tab === "articles" ? "Read-worthy, ranked by attention paid" : "Authors, ranked by earnings"}</h1>
      <p className="lede">
        {tab === "articles"
          ? "Every article below is ordered by how much readers actually streamed to its author — real money for real reading time, not clicks."
          : "Who readers pay the most to read. Each links to their page."}
      </p>

      <div className="tabs">
        <button className={`tab${tab === "articles" ? " tab-on" : ""}`} onClick={() => setTab("articles")}>
          Articles
        </button>
        <button className={`tab${tab === "authors" ? " tab-on" : ""}`} onClick={() => setTab("authors")}>
          Authors
        </button>
      </div>

      {isLoading && <p className="muted">Loading from chain…</p>}

      {tab === "articles" ? (
        <>
          {!isLoading && visible.length === 0 && (
            <p className="muted">
              No articles yet. <a href="/publish">Publish the first one →</a>
            </p>
          )}
          <div className="grid">
            {visible.map((a) => (
              <ArticleCard key={a.id.toString()} a={a} tokenSymbol={tokenSymbol} tokenDecimals={tokenDecimals} />
            ))}
          </div>
        </>
      ) : (
        <>
          {!isLoading && topAuthors.length === 0 && <p className="muted">No authors yet.</p>}
          <div className="grid">
            {topAuthors.map((a) => (
              <AuthorCard
                key={a.address}
                a={a}
                bio={bios[a.address.toLowerCase()]}
                tokenSymbol={tokenSymbol}
                tokenDecimals={tokenDecimals}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}
