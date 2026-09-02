"use client";

import { useReadContract } from "wagmi";
import { ArticleCard } from "@/components/ArticleCard";
import { useArticles } from "@/lib/articles";
import { ATTENTION_STREAM, attentionStreamAbi, erc20Abi } from "@/lib/chain";

export default function HomePage() {
  const { articles, isLoading } = useArticles();

  const token = useReadContract({ address: ATTENTION_STREAM, abi: attentionStreamAbi, functionName: "token" });
  const symbol = useReadContract({
    address: token.data,
    abi: erc20Abi,
    functionName: "symbol",
    query: { enabled: !!token.data },
  });
  const decimals = useReadContract({
    address: token.data,
    abi: erc20Abi,
    functionName: "decimals",
    query: { enabled: !!token.data },
  });

  const tokenSymbol = symbol.data ?? "tokens";
  const tokenDecimals = decimals.data ?? 18;
  const visible = articles.filter((a) => !a.retired);

  return (
    <>
      <h1>Read-worthy, ranked by attention paid</h1>
      <p className="lede">
        Every article below is ordered by how much readers actually streamed to its author — real money for
        real reading time, not clicks.
      </p>

      {isLoading && <p className="muted">Loading articles from chain…</p>}
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
  );
}
