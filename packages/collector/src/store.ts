import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { ReplyPage, ReplyRecord, StoredVoucher, VoucherInput } from "./types.js";

interface SessionRecord {
  latest: StoredVoucher | null;
  /** Highest cumulativeAmount we have successfully settled on-chain. */
  settledCumulative: bigint;
  author: Address | null;
  reader: Address | null;
  articleId: bigint | null;
  /** Session observed closed on-chain — stop tracking. */
  done: boolean;
}

interface BioRecord {
  text: string;
  updatedAt: number;
}

interface ArticleKeyRecord {
  /** base64 AES-256 key. */
  key: string;
  /** Address that signed the key upload; verified against the on-chain author at release time. */
  claimedAuthor: Address;
  createdAt: number;
}

const bigMax = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const lc = (a: string | null | undefined): string => (a ?? "").toLowerCase();

export interface CollectorMetrics {
  vouchersReceived: number;
  vouchersAccepted: number;
  vouchersRejected: number;
  settleSent: number;
  settleFailed: number;
}

/**
 * In-memory latest-voucher-per-session, settled totals, per-reader aggregates,
 * and profile bios, with a JSON snapshot for crash recovery. Not a database —
 * swap for SQLite/Postgres when one collector serves many authors at volume.
 */
export class VoucherStore {
  private sessions = new Map<string, SessionRecord>();
  private bios = new Map<string, BioRecord>();
  /** keyed by lowercased contentHash */
  private articleKeys = new Map<string, ArticleKeyRecord>();
  /** keyed by decimal articleId; each list kept sorted ascending by `index` */
  private replies = new Map<string, ReplyRecord[]>();
  /** highest block fully scanned by the reply indexer */
  private replyCursor = 0n;
  readonly metrics: CollectorMetrics = {
    vouchersReceived: 0,
    vouchersAccepted: 0,
    vouchersRejected: 0,
    settleSent: 0,
    settleFailed: 0,
  };
  private readonly file: string | null;

  constructor(dataDir?: string) {
    this.file = dataDir ? join(dataDir, "collector-state.json") : null;
    if (dataDir) mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  private rec(id: string): SessionRecord {
    let r = this.sessions.get(id);
    if (!r) {
      r = { latest: null, settledCumulative: 0n, author: null, reader: null, articleId: null, done: false };
      this.sessions.set(id, r);
    }
    return r;
  }

  /** Store a voucher, keeping only the highest cumulativeAmount seen. */
  putVoucher(v: VoucherInput): void {
    const r = this.rec(v.sessionId);
    if (r.latest && v.cumulativeAmount <= r.latest.cumulativeAmount) return;
    r.latest = { ...v, receivedAt: Date.now() };
  }

  /** Attach on-chain session facts (author / reader / articleId) as we learn them. */
  setSessionMeta(
    id: Hex,
    meta: { author?: Address; reader?: Address; articleId?: bigint },
  ): void {
    const r = this.rec(id);
    if (meta.author) r.author = meta.author;
    if (meta.reader) r.reader = meta.reader;
    if (meta.articleId !== undefined) r.articleId = meta.articleId;
  }

  /** @deprecated use setSessionMeta */
  setAuthor(id: Hex, author: Address): void {
    this.rec(id).author = author;
  }

  markSettled(id: Hex, cumulativeAmount: bigint): void {
    const r = this.rec(id);
    if (cumulativeAmount > r.settledCumulative) r.settledCumulative = cumulativeAmount;
  }

  markDone(id: Hex): void {
    this.rec(id).done = true;
  }

  get(id: string): Readonly<SessionRecord> | undefined {
    return this.sessions.get(id);
  }

  /** Sessions with a voucher ahead of what we have settled. */
  pending(): Array<{ sessionId: Hex; voucher: StoredVoucher }> {
    const out: Array<{ sessionId: Hex; voucher: StoredVoucher }> = [];
    for (const [id, r] of this.sessions) {
      if (r.done || !r.latest) continue;
      if (r.latest.cumulativeAmount > r.settledCumulative) {
        out.push({ sessionId: id as Hex, voucher: r.latest });
      }
    }
    return out;
  }

  earningsByAuthor(author: Address): {
    author: Address;
    settledTotal: string;
    pendingTotal: string;
    sessions: Array<{ sessionId: string; settled: string; pending: string }>;
  } {
    const key = lc(author);
    let settled = 0n;
    let pending = 0n;
    const sessions: Array<{ sessionId: string; settled: string; pending: string }> = [];
    for (const [id, r] of this.sessions) {
      if (lc(r.author) !== key) continue;
      const p = r.latest ? bigMax(r.latest.cumulativeAmount - r.settledCumulative, 0n) : 0n;
      settled += r.settledCumulative;
      pending += p;
      sessions.push({ sessionId: id, settled: r.settledCumulative.toString(), pending: p.toString() });
    }
    return { author, settledTotal: settled.toString(), pendingTotal: pending.toString(), sessions };
  }

  /**
   * Reader-side totals. Reflects only sessions whose vouchers reached THIS
   * collector — sessions opened directly on-chain won't be counted.
   */
  readerStats(reader: Address): {
    reader: Address;
    totalPaid: string;
    sessionsOpened: number;
    articlesRead: number;
  } {
    const key = lc(reader);
    let totalPaid = 0n;
    let sessionsOpened = 0;
    const articles = new Set<string>();
    for (const [, r] of this.sessions) {
      if (lc(r.reader) !== key) continue;
      sessionsOpened += 1;
      totalPaid += bigMax(r.settledCumulative, r.latest?.cumulativeAmount ?? 0n);
      if (r.articleId !== null) articles.add(r.articleId.toString());
    }
    return { reader, totalPaid: totalPaid.toString(), sessionsOpened, articlesRead: articles.size };
  }

  setBio(address: Address, text: string): BioRecord {
    const b = { text, updatedAt: Date.now() };
    this.bios.set(lc(address), b);
    return b;
  }

  getBio(address: Address): BioRecord {
    return this.bios.get(lc(address)) ?? { text: "", updatedAt: 0 };
  }

  /** Bios for many addresses at once, keyed by lowercased address (empty for unset). */
  getBios(addresses: Address[]): Record<string, BioRecord> {
    const out: Record<string, BioRecord> = {};
    for (const a of addresses) out[lc(a)] = this.getBio(a);
    return out;
  }

  /** Register (or overwrite) the decryption key for an article, by its plaintext contentHash. */
  setArticleKey(contentHash: Hex, key: string, claimedAuthor: Address): void {
    this.articleKeys.set(lc(contentHash), { key, claimedAuthor, createdAt: Date.now() });
  }

  getArticleKey(contentHash: Hex): ArticleKeyRecord | undefined {
    return this.articleKeys.get(lc(contentHash));
  }

  // ---- reply index -------------------------------------------------------------

  /**
   * Add one indexed reply. Idempotent by `(articleId, index)` — re-scanning an
   * overlapping block range or restarting never double-counts. Returns whether
   * the reply was newly added.
   */
  addReply(r: ReplyRecord): boolean {
    const arr = this.replies.get(r.articleId) ?? [];
    let i = arr.length;
    while (i > 0) {
      const prev = arr[i - 1]!;
      if (prev.index === r.index) return false;
      if (prev.index < r.index) break;
      i--;
    }
    arr.splice(i, 0, r);
    this.replies.set(r.articleId, arr);
    return true;
  }

  replyCount(articleId: string): number {
    return this.replies.get(articleId)?.length ?? 0;
  }

  /** Page of replies for an article. `order` "asc" = chronological (default). */
  repliesFor(
    articleId: string,
    opts: { order?: "asc" | "desc"; cursor?: number; limit?: number } = {},
  ): ReplyPage {
    const all = this.replies.get(articleId) ?? [];
    const ordered = opts.order === "desc" ? [...all].reverse() : all;
    const cursor = Math.max(0, Math.floor(opts.cursor ?? 0));
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    const items = ordered.slice(cursor, cursor + limit);
    const consumed = cursor + items.length;
    return { items, total: ordered.length, nextCursor: consumed < ordered.length ? consumed : null };
  }

  getReplyCursor(): bigint {
    return this.replyCursor;
  }

  setReplyCursor(block: bigint): void {
    if (block > this.replyCursor) this.replyCursor = block;
  }

  snapshot(): void {
    if (!this.file) return;
    const out = {
      version: 4 as const,
      metrics: { ...this.metrics },
      bios: Object.fromEntries(this.bios),
      articleKeys: Object.fromEntries(this.articleKeys),
      replies: Object.fromEntries(this.replies),
      replyCursorBlock: this.replyCursor.toString(),
      sessions: Object.fromEntries(
        [...this.sessions].map(([id, r]) => [
          id,
          {
            latest: r.latest ? { ...r.latest, cumulativeAmount: r.latest.cumulativeAmount.toString() } : null,
            settledCumulative: r.settledCumulative.toString(),
            author: r.author,
            reader: r.reader,
            articleId: r.articleId?.toString() ?? null,
            done: r.done,
          },
        ]),
      ),
    };
    writeFileSync(this.file, JSON.stringify(out, null, 2));
  }

  private load(): void {
    if (!this.file) return;
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return;
    }
    const snap = JSON.parse(raw) as {
      version: number;
      metrics?: Partial<CollectorMetrics>;
      sessions: Record<
        string,
        {
          latest: { sessionId: Hex; cumulativeAmount: string; signature: Hex; receivedAt: number } | null;
          settledCumulative: string;
          author: string | null;
          reader?: string | null;
          articleId?: string | null;
          done: boolean;
        }
      >;
      bios?: Record<string, BioRecord>;
      articleKeys?: Record<string, ArticleKeyRecord>;
      replies?: Record<string, ReplyRecord[]>;
      replyCursorBlock?: string;
    };
    if (![1, 2, 3, 4].includes(snap.version)) return;
    for (const [id, s] of Object.entries(snap.sessions)) {
      this.sessions.set(id, {
        latest: s.latest ? { ...s.latest, cumulativeAmount: BigInt(s.latest.cumulativeAmount) } : null,
        settledCumulative: BigInt(s.settledCumulative),
        author: (s.author as Address | null) ?? null,
        reader: (s.reader as Address | null | undefined) ?? null,
        articleId: s.articleId != null ? BigInt(s.articleId) : null,
        done: s.done,
      });
    }
    for (const [k, v] of Object.entries(snap.bios ?? {})) this.bios.set(k, v);
    for (const [k, v] of Object.entries(snap.articleKeys ?? {})) this.articleKeys.set(k, v);
    for (const [k, v] of Object.entries(snap.replies ?? {})) {
      this.replies.set(k, [...v].sort((a, b) => a.index - b.index));
    }
    if (snap.replyCursorBlock) this.replyCursor = BigInt(snap.replyCursorBlock);
    Object.assign(this.metrics, snap.metrics ?? {});
  }
}
