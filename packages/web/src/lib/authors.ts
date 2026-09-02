"use client";

import { useMemo } from "react";
import { useArticles, type ArticleView } from "./articles";

export interface AuthorView {
  address: `0x${string}`;
  /** From the most-recent article that carries an authorName. */
  authorName?: string;
  articleCount: number;
  totalEarned: bigint;
  totalReaderSeconds: bigint;
  latestCreatedAt: number;
}

/** Group live articles by author, aggregate, sort by total earned (desc). Pure — unit-tested. */
export function groupAuthors(articles: ArticleView[]): AuthorView[] {
  const acc = new Map<string, AuthorView & { _nameAt: number }>();
  for (const a of articles) {
    if (a.retired) continue;
    const key = a.author.toLowerCase();
    const cur =
      acc.get(key) ??
      ({
        address: a.author,
        authorName: undefined,
        articleCount: 0,
        totalEarned: 0n,
        totalReaderSeconds: 0n,
        latestCreatedAt: 0,
        _nameAt: -1,
      } as AuthorView & { _nameAt: number });

    cur.articleCount += 1;
    cur.totalEarned += a.earned;
    cur.totalReaderSeconds += a.readerSeconds;
    if (a.createdAt > cur.latestCreatedAt) cur.latestCreatedAt = a.createdAt;
    if (a.metadata?.authorName && a.createdAt >= cur._nameAt) {
      cur.authorName = a.metadata.authorName;
      cur._nameAt = a.createdAt;
    }
    acc.set(key, cur);
  }
  return [...acc.values()]
    .map(({ _nameAt, ...v }) => v)
    .sort((x, y) => (y.totalEarned > x.totalEarned ? 1 : y.totalEarned < x.totalEarned ? -1 : 0));
}

export function useAuthors(): { authors: AuthorView[]; isLoading: boolean } {
  const { articles, isLoading } = useArticles();
  const authors = useMemo(() => groupAuthors(articles), [articles]);
  return { authors, isLoading };
}
