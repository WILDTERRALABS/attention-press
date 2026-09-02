import { keccak256, toBytes, type Hex } from "viem";

/**
 * v1 storage: no external IPFS pin. Article metadata (title + markdown body) is
 * encoded as a `data:` URI and stored in `ArticleRegistry.metadataURI`, and
 * `contentHash` is `keccak256(body)`. Swap `encodeMetadataURI` for a real IPFS
 * pin + `ipfs://CID` when a pinning key is available (see README).
 */
export interface ArticleMetadata {
  title: string;
  body: string;
  authorName?: string;
  createdAt: number;
}

const PREFIX = "data:application/json;base64,";

export function encodeMetadataURI(meta: ArticleMetadata): string {
  const json = JSON.stringify(meta);
  const b64 = typeof window === "undefined" ? Buffer.from(json, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(json)));
  return PREFIX + b64;
}

export function decodeMetadataURI(uri: string): ArticleMetadata | null {
  try {
    if (uri.startsWith(PREFIX)) {
      const b64 = uri.slice(PREFIX.length);
      const json =
        typeof window === "undefined"
          ? Buffer.from(b64, "base64").toString("utf8")
          : decodeURIComponent(escape(atob(b64)));
      const m = JSON.parse(json) as Partial<ArticleMetadata>;
      if (typeof m.title !== "string" || typeof m.body !== "string") return null;
      return { title: m.title, body: m.body, authorName: m.authorName, createdAt: Number(m.createdAt ?? 0) };
    }
    // Unknown scheme (e.g. a real ipfs:// URI) — caller should fetch it.
    return null;
  } catch {
    return null;
  }
}

export function contentHashOf(body: string): Hex {
  return keccak256(toBytes(body));
}

/** Rough guard so publish() calldata stays sane on testnet. */
export const MAX_BODY_CHARS = 20_000;
