import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import type { StoredVoucher, VoucherInput } from "./types.js";

interface SessionRecord {
  latest: StoredVoucher | null;
  /** Highest cumulativeAmount we have successfully settled on-chain. */
  settledCumulative: bigint;
  author: Address | null;
  /** Session observed closed on-chain — stop tracking. */
  done: boolean;
}

const bigMax = (a: bigint, b: bigint): bigint => (a > b ? a : b);

export interface CollectorMetrics {
  vouchersReceived: number;
  vouchersAccepted: number;
  vouchersRejected: number;
  settleSent: number;
  settleFailed: number;
}

/**
 * In-memory latest-voucher-per-session plus settled totals, with a JSON
 * snapshot for crash recovery. Not a database — swap for SQLite/Postgres when
 * one collector serves many authors at volume.
 */
export class VoucherStore {
  private sessions = new Map<string, SessionRecord>();
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
      r = { latest: null, settledCumulative: 0n, author: null, done: false };
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
    const key = author.toLowerCase();
    let settled = 0n;
    let pending = 0n;
    const sessions: Array<{ sessionId: string; settled: string; pending: string }> = [];
    for (const [id, r] of this.sessions) {
      if ((r.author ?? "").toLowerCase() !== key) continue;
      const p = r.latest ? bigMax(r.latest.cumulativeAmount - r.settledCumulative, 0n) : 0n;
      settled += r.settledCumulative;
      pending += p;
      sessions.push({ sessionId: id, settled: r.settledCumulative.toString(), pending: p.toString() });
    }
    return { author, settledTotal: settled.toString(), pendingTotal: pending.toString(), sessions };
  }

  snapshot(): void {
    if (!this.file) return;
    const out = {
      version: 1 as const,
      metrics: { ...this.metrics },
      sessions: Object.fromEntries(
        [...this.sessions].map(([id, r]) => [
          id,
          {
            latest: r.latest
              ? { ...r.latest, cumulativeAmount: r.latest.cumulativeAmount.toString() }
              : null,
            settledCumulative: r.settledCumulative.toString(),
            author: r.author,
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
          done: boolean;
        }
      >;
    };
    if (snap.version !== 1) return;
    for (const [id, s] of Object.entries(snap.sessions)) {
      this.sessions.set(id, {
        latest: s.latest
          ? { ...s.latest, cumulativeAmount: BigInt(s.latest.cumulativeAmount) }
          : null,
        settledCumulative: BigInt(s.settledCumulative),
        author: (s.author as Address | null) ?? null,
        done: s.done,
      });
    }
    Object.assign(this.metrics, snap.metrics ?? {});
  }
}
