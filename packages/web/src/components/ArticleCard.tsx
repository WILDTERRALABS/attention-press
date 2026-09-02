import Link from "next/link";
import type { ArticleView } from "@/lib/articles";
import { formatSeconds, formatUnits, shortAddress } from "@/lib/format";
import { previewText } from "@/lib/metadata";
import { tierByPerMinute } from "@/lib/rate";

export function ArticleCard({
  a,
  tokenSymbol,
  tokenDecimals,
  pinned = false,
}: {
  a: ArticleView;
  tokenSymbol: string;
  tokenDecimals: number;
  pinned?: boolean;
}) {
  const title = a.metadata?.title ?? `Article #${a.id}`;
  const preview = a.metadata
    ? previewText(a.metadata).slice(0, 180) || "🔒 Locked — open to read"
    : "(metadata off-chain — open to load)";
  const avgPerReader = a.sessions > 0 ? Number(a.readerSeconds) / a.sessions : 0;
  const tier = tierByPerMinute(a.metadata?.ratePerMinute);

  return (
    <div className={`card${pinned ? " card-pinned" : ""}`}>
      <Link href={`/article/${a.id}`}>
        <h3>{pinned && <span className="pin-badge">📌 Start here</span>}{title}</h3>
        <p className="preview">{preview}</p>
      </Link>
      <div className="card-meta">
        <span title="Total streamed by readers">
          💰 {formatUnits(a.earned, tokenDecimals)} {tokenSymbol}
        </span>
        <span title="Reading sessions">👁 {a.sessions}</span>
        <span title="Average attention per reader">⏱ {formatSeconds(avgPerReader)}/reader</span>
        <span title="Author's pay tier">🏷 {tier.label}</span>
        <Link href={`/profile/${a.author}`} className="muted" title="Author profile">
          by {a.metadata?.authorName || shortAddress(a.author)}
        </Link>
      </div>
    </div>
  );
}
