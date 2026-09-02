import Link from "next/link";
import type { AuthorView } from "@/lib/authors";
import { formatDuration, formatUnits, shortAddress } from "@/lib/format";

export function AuthorCard({
  a,
  bio,
  tokenSymbol,
  tokenDecimals,
}: {
  a: AuthorView;
  bio?: string;
  tokenSymbol: string;
  tokenDecimals: number;
}) {
  return (
    <Link href={`/profile/${a.address}`} className="card author-card">
      <div className="author-card-top">
        <h3>{a.authorName || shortAddress(a.address)}</h3>
        <span className="author-earned">
          {formatUnits(a.totalEarned, tokenDecimals)} {tokenSymbol}
        </span>
      </div>
      {bio && <p className="preview">{bio}</p>}
      <div className="card-meta">
        <span>
          {a.articleCount} article{a.articleCount === 1 ? "" : "s"}
        </span>
        <span>{formatDuration(Number(a.totalReaderSeconds))} read</span>
        {a.authorName && <span className="muted">{shortAddress(a.address)}</span>}
      </div>
    </Link>
  );
}
