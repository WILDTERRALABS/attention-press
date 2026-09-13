"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import { ARTICLE_REGISTRY, ATTENTION_STREAM, HIDDEN_ARTICLE_IDS, articleRegistryAbi, attentionStreamAbi } from "./chain";
import { decodeMetadataURI, type ArticleMetadata } from "./metadata";

export interface ArticleView {
  id: bigint;
  author: `0x${string}`;
  contentHash: `0x${string}`;
  createdAt: number;
  retired: boolean;
  metadata: ArticleMetadata | null;
  rawMetadataURI: string;
  earned: bigint;
  readerSeconds: bigint;
  sessions: number;
}

/** Reads every article id 1..nextId-1 via multicall. Fine for tens of articles; add an indexer later. */
export function useArticles(): { articles: ArticleView[]; isLoading: boolean; refetch: () => void } {
  const nextId = useReadContract({
    address: ARTICLE_REGISTRY,
    abi: articleRegistryAbi,
    functionName: "nextId",
  });

  const count = nextId.data ? Number(nextId.data) - 1 : 0;
  const ids = useMemo(() => Array.from({ length: Math.max(0, count) }, (_, i) => BigInt(i + 1)), [count]);

  const contracts = useMemo(
    () =>
      ids.flatMap((id) => [
        { address: ARTICLE_REGISTRY, abi: articleRegistryAbi, functionName: "articles", args: [id] } as const,
        { address: ARTICLE_REGISTRY, abi: articleRegistryAbi, functionName: "metadataURI", args: [id] } as const,
        { address: ATTENTION_STREAM, abi: attentionStreamAbi, functionName: "articleEarned", args: [id] } as const,
        { address: ATTENTION_STREAM, abi: attentionStreamAbi, functionName: "articleReaderSeconds", args: [id] } as const,
        { address: ATTENTION_STREAM, abi: attentionStreamAbi, functionName: "articleSessions", args: [id] } as const,
      ]),
    [ids],
  );

  const batch = useReadContracts({ contracts, query: { enabled: contracts.length > 0 } });

  const articles = useMemo<ArticleView[]>(() => {
    if (!batch.data) return [];
    const out: ArticleView[] = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      if (HIDDEN_ARTICLE_IDS.has(id)) continue;
      const base = i * 5;
      const art = batch.data[base]?.result as
        | readonly [`0x${string}`, `0x${string}`, bigint, boolean]
        | undefined;
      if (!art) continue;
      const uri = (batch.data[base + 1]?.result as string) ?? "";
      out.push({
        id,
        author: art[0],
        contentHash: art[1],
        createdAt: Number(art[2]),
        retired: art[3],
        rawMetadataURI: uri,
        metadata: decodeMetadataURI(uri),
        earned: (batch.data[base + 2]?.result as bigint) ?? 0n,
        readerSeconds: (batch.data[base + 3]?.result as bigint) ?? 0n,
        sessions: Number((batch.data[base + 4]?.result as number | bigint) ?? 0),
      });
    }
    out.sort((a, b) => (b.earned > a.earned ? 1 : b.earned < a.earned ? -1 : 0));
    return out;
  }, [batch.data, ids]);

  return {
    articles,
    isLoading: nextId.isLoading || batch.isLoading,
    refetch: () => {
      void nextId.refetch();
      void batch.refetch();
    },
  };
}
