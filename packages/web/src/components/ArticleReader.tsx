"use client";

import Link from "next/link";
import { useReadContract } from "wagmi";
import { ReaderClient } from "@/components/ReaderClient";
import { ARTICLE_REGISTRY, ATTENTION_STREAM, articleRegistryAbi, attentionStreamAbi, erc20Abi } from "@/lib/chain";
import { decodeMetadataURI } from "@/lib/metadata";

function parseId(id: string): bigint | null {
  try {
    const v = BigInt(id);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

export function ArticleReader({ id }: { id: string }) {
  const articleId = parseId(id);
  const enabled = articleId !== null;
  const key = articleId ?? 0n;

  const article = useReadContract({
    address: ARTICLE_REGISTRY,
    abi: articleRegistryAbi,
    functionName: "articles",
    args: [key],
    query: { enabled },
  });
  const uri = useReadContract({
    address: ARTICLE_REGISTRY,
    abi: articleRegistryAbi,
    functionName: "metadataURI",
    args: [key],
    query: { enabled },
  });
  const token = useReadContract({ address: ATTENTION_STREAM, abi: attentionStreamAbi, functionName: "token" });
  const symbol = useReadContract({ address: token.data, abi: erc20Abi, functionName: "symbol", query: { enabled: !!token.data } });
  const decimals = useReadContract({ address: token.data, abi: erc20Abi, functionName: "decimals", query: { enabled: !!token.data } });

  if (!enabled) return <p className="notice err">Invalid article id.</p>;
  if (article.isLoading || uri.isLoading) return <p className="muted">Loading article…</p>;

  const art = article.data as readonly [`0x${string}`, `0x${string}`, bigint, boolean] | undefined;
  if (!art || art[0] === "0x0000000000000000000000000000000000000000") {
    return (
      <p className="notice err">
        Article #{id} not found. <Link href="/">Back home</Link>
      </p>
    );
  }

  const meta = decodeMetadataURI(uri.data ?? "");
  if (!meta) {
    return (
      <p className="notice">
        This article&apos;s metadata is stored off-chain (<code>{(uri.data ?? "").slice(0, 40)}…</code>) and this
        v1 UI only renders inline data-URI metadata.
      </p>
    );
  }

  return (
    <ReaderClient
      articleId={articleId}
      meta={meta}
      author={art[0]}
      tokenSymbol={symbol.data ?? "tokens"}
      tokenDecimals={decimals.data ?? 18}
    />
  );
}
