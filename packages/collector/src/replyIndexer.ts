import type { ChainAdapter } from "./types.js";
import type { VoucherStore } from "./store.js";

export interface ReplyIndexerOptions {
  /** Poll interval for the forward tail. */
  intervalMs: number;
  /** Block to start the first backfill from (≈ ArticleActions deploy block). */
  fromBlock: bigint;
  /** Starting block span per getLogs call; shrinks adaptively on provider error. */
  rangeSize: number;
  /** Re-scan this many blocks below the cursor each pass, to absorb small reorgs. */
  reorgBuffer?: bigint;
  /** Floor the adaptive range will not shrink below (public-RPC safe). */
  minRange?: bigint;
  log?: (msg: string, extra?: unknown) => void;
}

/**
 * Indexes `ArticleActions.Replied` logs into the store. Mirrors SettleLoop:
 * `start()` runs one backfill then polls; each pass walks blocks in windows,
 * halving the window on a provider range error down to `minRange`. Idempotent —
 * the store dedupes by `(articleId, index)`, so overlapping ranges and restarts
 * never double-count.
 */
export class ReplyIndexer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private readonly reorgBuffer: bigint;
  private readonly minRange: bigint;
  private readonly blockTime = new Map<bigint, number>();

  constructor(
    private readonly chain: ChainAdapter,
    private readonly store: VoucherStore,
    private readonly opts: ReplyIndexerOptions,
  ) {
    this.reorgBuffer = opts.reorgBuffer ?? 10n;
    this.minRange = opts.minRange ?? 100n;
  }

  async start(): Promise<void> {
    await this.runOnce();
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan from the resume point to chain head. Safe to call directly (tests). */
  async runOnce(): Promise<{ scannedTo: bigint; added: number }> {
    if (this.inFlight) return { scannedTo: this.store.getReplyCursor(), added: 0 };
    this.inFlight = true;
    let added = 0;
    let scannedTo = this.store.getReplyCursor();
    try {
      const head = await this.chain.latestBlockNumber();
      const cursor = this.store.getReplyCursor();
      const resume = cursor > 0n ? cursor + 1n - this.reorgBuffer : this.opts.fromBlock;
      let lo = resume < this.opts.fromBlock ? this.opts.fromBlock : resume;
      if (lo < 0n) lo = 0n;
      if (lo > head) return { scannedTo: cursor, added: 0 };

      let range = BigInt(Math.max(1, Math.floor(this.opts.rangeSize)));
      while (lo <= head) {
        const hi = lo + range - 1n > head ? head : lo + range - 1n;
        let logs;
        try {
          logs = await this.chain.getRepliedLogs(lo, hi);
        } catch (err) {
          if (range > this.minRange) {
            const next = range / 2n;
            range = next < this.minRange ? this.minRange : next;
            this.opts.log?.("range too wide, shrinking", { range: range.toString(), err: String(err) });
            continue;
          }
          this.opts.log?.("getLogs failed at floor range, pausing scan", {
            lo: lo.toString(),
            hi: hi.toString(),
            err: String(err),
          });
          break;
        }

        for (const l of logs) {
          const blockTime = await this.timestampFor(l.blockNumber);
          const isNew = this.store.addReply({
            articleId: l.articleId.toString(),
            index: Number(l.index),
            actor: l.actor,
            text: l.text,
            toAuthor: l.toAuthor.toString(),
            fee: l.fee.toString(),
            blockNumber: Number(l.blockNumber),
            blockTime,
            txHash: l.txHash,
          });
          if (isNew) added++;
        }

        this.store.setReplyCursor(hi);
        scannedTo = hi;
        if (logs.length) this.opts.log?.("indexed", { window: `${lo}-${hi}`, logs: logs.length });
        lo = hi + 1n;
      }
    } catch (err) {
      this.opts.log?.("indexer pass failed", { err: String(err) });
    } finally {
      this.inFlight = false;
      this.store.snapshot();
    }
    return { scannedTo, added };
  }

  private async timestampFor(blockNumber: bigint): Promise<number> {
    const cached = this.blockTime.get(blockNumber);
    if (cached !== undefined) return cached;
    try {
      const ts = Number(await this.chain.getBlockTimestamp(blockNumber));
      this.blockTime.set(blockNumber, ts);
      return ts;
    } catch {
      return 0;
    }
  }
}
