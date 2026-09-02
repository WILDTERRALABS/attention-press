import { keccak256, toBytes, type Hex } from "viem";
import type { EncryptedBody } from "./crypto";

/**
 * Article metadata is a `data:` URI in `ArticleRegistry.metadataURI`. New
 * articles carry an AES-GCM-encrypted body (`enc`) plus a plaintext `preview`;
 * `contentHash` on-chain is still `keccak256(plaintext body)`. Older articles
 * carry a plaintext `body` and are handled unchanged.
 */
export interface ArticleMetadata {
  title: string;
  authorName?: string;
  createdAt: number;
  /** WMON/min pay rate the author chose (string, e.g. "0.025"). Absent on pre-tier articles. */
  ratePerMinute?: string;
  /** Encrypted body — present on gated articles. */
  enc?: EncryptedBody;
  /** Public teaser (first sentences of the plaintext). Present on gated articles. */
  preview?: string;
  /** Legacy plaintext body — present on pre-encryption articles only. */
  body?: string;
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
      const hasBody = typeof m.body === "string";
      const hasEnc =
        !!m.enc && typeof m.enc === "object" && typeof m.enc.ct === "string" && typeof m.enc.iv === "string";
      if (typeof m.title !== "string" || (!hasBody && !hasEnc)) return null;
      return {
        title: m.title,
        authorName: m.authorName,
        createdAt: Number(m.createdAt ?? 0),
        ratePerMinute: typeof m.ratePerMinute === "string" ? m.ratePerMinute : undefined,
        enc: hasEnc ? m.enc : undefined,
        preview: typeof m.preview === "string" ? m.preview : undefined,
        body: hasBody ? m.body : undefined,
      };
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

/**
 * Public teaser: strip Markdown, keep the first few sentences. Shown before a
 * reading session is open; the rest is gated in the UI.
 */
export function previewOf(body: string, maxSentences = 3, maxChars = 320): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  const sentences = plain.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((s) => s.trim()) ?? [plain];
  let out = sentences.slice(0, maxSentences).join(" ").trim();
  const truncatedByChars = out.length > maxChars;
  if (truncatedByChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, "");
  if (truncatedByChars || sentences.length > maxSentences || out.length < plain.length) out += " …";
  return out;
}

/** Public teaser for a card / locked view: stored `preview`, else derived from a legacy `body`. */
export function previewText(meta: ArticleMetadata): string {
  if (meta.preview) return meta.preview;
  if (meta.body) return previewOf(meta.body);
  return "";
}

/** Rough guard so publish() calldata stays sane on testnet. */
export const MAX_BODY_CHARS = 20_000;
