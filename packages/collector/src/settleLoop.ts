import type { ChainAdapter } from "./types.js";
import type { VoucherStore } from "./store.js";

export interface SettleLoopOptions {
  intervalMs: number;
  minDelta: bigint;
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * Periodically walks pending sessions and calls `settle` for any whose latest
 * voucher is ahead of the on-chain `claimed`. Re-reads each session first, so a
 * session that closed or was settled elsewhere is dropped, not retried.
 */
export class SettleLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(
    private readonly chain: ChainAdapter,
    private readonly store: VoucherStore,
    private readonly opts: SettleLoopOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<{ settled: number; failed: number; skipped: number }> {
    if (this.inFlight) return { settled: 0, failed: 0, skipped: 0 };
    this.inFlight = true;
    let settled = 0;
    let failed = 0;
    let skipped = 0;
    try {
      for (const { sessionId, voucher } of this.store.pending()) {
        const session = await this.chain.getSession(sessionId);
        if (!session) {
          this.store.markDone(sessionId);
          continue;
        }
        this.store.setSessionMeta(sessionId, {
          author: session.author,
          reader: session.reader,
          articleId: session.articleId,
        });

        if (!session.open) {
          this.store.markSettled(sessionId, session.claimed);
          this.store.markDone(sessionId);
          continue;
        }
        if (voucher.cumulativeAmount <= session.claimed) {
          this.store.markSettled(sessionId, session.claimed);
          continue;
        }
        if (voucher.cumulativeAmount - session.claimed < this.opts.minDelta) {
          skipped++;
          continue;
        }

        try {
          const tx = await this.chain.settle(sessionId, voucher.cumulativeAmount, voucher.signature);
          this.store.markSettled(sessionId, voucher.cumulativeAmount);
          this.store.metrics.settleSent++;
          settled++;
          this.opts.log?.("settled", {
            sessionId,
            cumulativeAmount: voucher.cumulativeAmount.toString(),
            tx,
          });
        } catch (err) {
          this.store.metrics.settleFailed++;
          failed++;
          this.opts.log?.("settle failed", { sessionId, err: String(err) });
        }
      }
    } finally {
      this.inFlight = false;
      this.store.snapshot();
    }
    return { settled, failed, skipped };
  }
}
