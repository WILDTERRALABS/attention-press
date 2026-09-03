import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoucherStore } from "../src/store.js";
import type { ReplyRecord } from "../src/types.js";
import { sid } from "./helpers.js";

const AUTHOR = "0x3333333333333333333333333333333333333333" as const;
const READER = "0x4444444444444444444444444444444444444444" as const;
const SIG = `0x${"11".repeat(65)}` as const;

describe("VoucherStore", () => {
  it("keeps only the highest cumulativeAmount per session", () => {
    const s = new VoucherStore();
    s.putVoucher({ sessionId: sid(), cumulativeAmount: 100n, signature: SIG });
    s.putVoucher({ sessionId: sid(), cumulativeAmount: 50n, signature: SIG });
    s.putVoucher({ sessionId: sid(), cumulativeAmount: 300n, signature: SIG });
    expect(s.get(sid())?.latest?.cumulativeAmount).toBe(300n);
  });

  it("reports pending sessions where the voucher is ahead of settled", () => {
    const s = new VoucherStore();
    s.putVoucher({ sessionId: sid("ab"), cumulativeAmount: 100n, signature: SIG });
    s.putVoucher({ sessionId: sid("cd"), cumulativeAmount: 100n, signature: SIG });
    s.markSettled(sid("cd"), 100n);
    const pending = s.pending();
    expect(pending.map((p) => p.sessionId)).toEqual([sid("ab")]);
  });

  it("excludes done sessions from pending", () => {
    const s = new VoucherStore();
    s.putVoucher({ sessionId: sid(), cumulativeAmount: 100n, signature: SIG });
    s.markDone(sid());
    expect(s.pending()).toHaveLength(0);
  });

  it("aggregates earnings by author", () => {
    const s = new VoucherStore();
    s.putVoucher({ sessionId: sid("a1"), cumulativeAmount: 500n, signature: SIG });
    s.setAuthor(sid("a1"), AUTHOR);
    s.markSettled(sid("a1"), 200n);
    s.putVoucher({ sessionId: sid("a2"), cumulativeAmount: 1_000n, signature: SIG });
    s.setAuthor(sid("a2"), AUTHOR);

    const e = s.earningsByAuthor(AUTHOR);
    expect(e.settledTotal).toBe("200");
    expect(e.pendingTotal).toBe("1300"); // (500-200) + (1000-0)
    expect(e.sessions).toHaveLength(2);
  });

  it("aggregates reader stats across sessions (settled or latest voucher)", () => {
    const s = new VoucherStore();
    s.putVoucher({ sessionId: sid("r1"), cumulativeAmount: 600n, signature: SIG });
    s.setSessionMeta(sid("r1"), { reader: READER, articleId: 1n });
    s.markSettled(sid("r1"), 600n);
    s.putVoucher({ sessionId: sid("r2"), cumulativeAmount: 400n, signature: SIG }); // not settled yet
    s.setSessionMeta(sid("r2"), { reader: READER, articleId: 1n }); // same article
    s.putVoucher({ sessionId: sid("r3"), cumulativeAmount: 100n, signature: SIG });
    s.setSessionMeta(sid("r3"), { reader: READER, articleId: 2n });

    const st = s.readerStats(READER);
    expect(st.totalPaid).toBe("1100"); // 600 + 400 + 100
    expect(st.sessionsOpened).toBe(3);
    expect(st.articlesRead).toBe(2); // articles 1 and 2
  });

  it("stores and reads a bio (case-insensitive address)", () => {
    const s = new VoucherStore();
    expect(s.getBio(AUTHOR)).toEqual({ text: "", updatedAt: 0 });
    s.setBio(AUTHOR, "writes about slow reading");
    expect(s.getBio(AUTHOR.toUpperCase() as typeof AUTHOR).text).toBe("writes about slow reading");
  });

  it("stores and reads an article key by contentHash (case-insensitive), last write wins", () => {
    const s = new VoucherStore();
    const ch = ("0x" + "ab".repeat(32)) as `0x${string}`;
    expect(s.getArticleKey(ch)).toBeUndefined();
    s.setArticleKey(ch, "k1", AUTHOR);
    s.setArticleKey(ch, "k2", AUTHOR);
    const rec = s.getArticleKey(ch.toUpperCase() as typeof ch);
    expect(rec?.key).toBe("k2");
    expect(rec?.claimedAuthor).toBe(AUTHOR);
  });

  describe("replies", () => {
    const mkReply = (over: Partial<ReplyRecord> = {}): ReplyRecord => ({
      articleId: "1",
      index: 0,
      actor: "0x5555555555555555555555555555555555555555",
      text: "hi",
      toAuthor: "1950000000000000000",
      fee: "50000000000000000",
      blockNumber: 100,
      blockTime: 1_788_000_000,
      txHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
      ...over,
    });

    it("addReply is idempotent by (articleId, index) and returns whether it was new", () => {
      const s = new VoucherStore();
      expect(s.addReply(mkReply({ index: 0 }))).toBe(true);
      expect(s.addReply(mkReply({ index: 1, text: "second" }))).toBe(true);
      expect(s.addReply(mkReply({ index: 0, text: "dup" }))).toBe(false);
      expect(s.replyCount("1")).toBe(2);
      expect(s.repliesFor("1").items.map((r) => r.text)).toEqual(["hi", "second"]);
    });

    it("keeps replies sorted by index even if added out of order", () => {
      const s = new VoucherStore();
      s.addReply(mkReply({ index: 2, text: "c" }));
      s.addReply(mkReply({ index: 0, text: "a" }));
      s.addReply(mkReply({ index: 1, text: "b" }));
      expect(s.repliesFor("1").items.map((r) => r.text)).toEqual(["a", "b", "c"]);
    });

    it("paginates asc and desc with a next cursor", () => {
      const s = new VoucherStore();
      for (let i = 0; i < 5; i++) s.addReply(mkReply({ index: i, text: `r${i}` }));

      const p1 = s.repliesFor("1", { order: "asc", cursor: 0, limit: 2 });
      expect(p1.items.map((r) => r.text)).toEqual(["r0", "r1"]);
      expect(p1.total).toBe(5);
      expect(p1.nextCursor).toBe(2);

      const p2 = s.repliesFor("1", { order: "asc", cursor: p1.nextCursor!, limit: 2 });
      expect(p2.items.map((r) => r.text)).toEqual(["r2", "r3"]);
      expect(p2.nextCursor).toBe(4);

      const p3 = s.repliesFor("1", { order: "asc", cursor: p2.nextCursor!, limit: 2 });
      expect(p3.items.map((r) => r.text)).toEqual(["r4"]);
      expect(p3.nextCursor).toBeNull();

      const d = s.repliesFor("1", { order: "desc", cursor: 0, limit: 2 });
      expect(d.items.map((r) => r.text)).toEqual(["r4", "r3"]);
    });

    it("clamps limit to 1..200 and cursor to >= 0", () => {
      const s = new VoucherStore();
      for (let i = 0; i < 3; i++) s.addReply(mkReply({ index: i }));
      expect(s.repliesFor("1", { limit: 0 }).items).toHaveLength(1);
      expect(s.repliesFor("1", { limit: 9999 }).items).toHaveLength(3);
      expect(s.repliesFor("1", { cursor: -5, limit: 1 }).items).toHaveLength(1);
    });

    it("returns an empty page for an article with no replies", () => {
      const s = new VoucherStore();
      expect(s.repliesFor("42")).toEqual({ items: [], total: 0, nextCursor: null });
      expect(s.replyCount("42")).toBe(0);
    });

    it("reply cursor only advances forward", () => {
      const s = new VoucherStore();
      s.setReplyCursor(100n);
      s.setReplyCursor(50n);
      expect(s.getReplyCursor()).toBe(100n);
      s.setReplyCursor(200n);
      expect(s.getReplyCursor()).toBe(200n);
    });
  });

  describe("with a data dir", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "collector-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("survives a restart via the snapshot file (sessions, reader, bios)", () => {
      const a = new VoucherStore(dir);
      a.putVoucher({ sessionId: sid(), cumulativeAmount: 777n, signature: SIG });
      a.setSessionMeta(sid(), { author: AUTHOR, reader: READER, articleId: 9n });
      a.markSettled(sid(), 200n);
      a.metrics.vouchersAccepted = 3;
      a.setBio(AUTHOR, "hello");
      a.setArticleKey(("0x" + "ab".repeat(32)) as `0x${string}`, "k64", AUTHOR);
      a.snapshot();

      const b = new VoucherStore(dir);
      expect(b.get(sid())?.latest?.cumulativeAmount).toBe(777n);
      expect(b.get(sid())?.settledCumulative).toBe(200n);
      expect(b.get(sid())?.articleId).toBe(9n);
      expect(b.metrics.vouchersAccepted).toBe(3);
      expect(b.earningsByAuthor(AUTHOR).pendingTotal).toBe("577");
      expect(b.readerStats(READER).sessionsOpened).toBe(1);
      expect(b.getBio(AUTHOR).text).toBe("hello");
      expect(b.getArticleKey(("0x" + "ab".repeat(32)) as `0x${string}`)?.key).toBe("k64");
    });

    it("round-trips the reply index and cursor through a v4 snapshot", () => {
      const a = new VoucherStore(dir);
      a.addReply({
        articleId: "7",
        index: 0,
        actor: "0x5555555555555555555555555555555555555555",
        text: "persisted reply",
        toAuthor: "1950000000000000000",
        fee: "50000000000000000",
        blockNumber: 123,
        blockTime: 1_788_111_111,
        txHash: ("0x" + "cd".repeat(32)) as `0x${string}`,
      });
      a.setReplyCursor(59_100_000n);
      a.snapshot();

      const b = new VoucherStore(dir);
      expect(b.getReplyCursor()).toBe(59_100_000n);
      expect(b.replyCount("7")).toBe(1);
      const first = b.repliesFor("7").items[0]!;
      expect(first.text).toBe("persisted reply");
      expect(b.addReply({ ...first })).toBe(false); // dedupe survives reload
    });
  });
});
