import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoucherStore } from "../src/store.js";
import { sid } from "./helpers.js";

const AUTHOR = "0x3333333333333333333333333333333333333333" as const;
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

  describe("with a data dir", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "collector-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("survives a restart via the snapshot file", () => {
      const a = new VoucherStore(dir);
      a.putVoucher({ sessionId: sid(), cumulativeAmount: 777n, signature: SIG });
      a.setAuthor(sid(), AUTHOR);
      a.markSettled(sid(), 200n);
      a.metrics.vouchersAccepted = 3;
      a.snapshot();

      const b = new VoucherStore(dir);
      expect(b.get(sid())?.latest?.cumulativeAmount).toBe(777n);
      expect(b.get(sid())?.settledCumulative).toBe(200n);
      expect(b.metrics.vouchersAccepted).toBe(3);
      expect(b.earningsByAuthor(AUTHOR).pendingTotal).toBe("577");
    });
  });
});
