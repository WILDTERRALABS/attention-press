import Link from "next/link";
import type { ArticleView } from "@/lib/articles";
import { formatSeconds, formatUnits, shortAddress } from "@/lib/format";

export function ArticleCard({ a, tokenSymbol, tokenDecimals }: { a: ArticleView; tokenSymbol: string; tokenDecimals: number }) {
  const title = a.metadata?.title ?? `Article #${a.id}`;
  const preview = a.metadata?.body.replace(/[#*_>`]/g, "").slice(0, 160) ?? "(metadata off-chain — open to load)";
  const avgPerReader = a.sessions > 0 ? Number(a.readerSeconds) / a.sessions : 0;

  return (
    <Link href={`/article/${a.id}`} className="card">
      <h3>{title}</h3>
      <p className="preview">{preview}</p>
      <div className="card-meta">
        <span title="Total streamed by readers">
          💰 {formatUnits(a.earned, tokenDecimals)} {tokenSymbol}
        </span>
        <span title="Reading sessions">👁 {a.sessions}</span>
        <span title="Average attention per reader">⏱ {formatSeconds(avgPerReader)}/reader</span>
        <span className="muted">by {shortAddress(a.author)}</span>
      </div>
    </Link>
  );
}
