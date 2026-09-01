export type IdleListener = (idle: boolean) => void;

const ACTIVITY_EVENTS = [
  "pointermove",
  "pointerdown",
  "keydown",
  "wheel",
  "scroll",
  "touchstart",
] as const;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Fires `listener(true)` after `timeoutMs` with no user activity, and
 * `listener(false)` on the next activity once idle. Monotonic clock.
 */
export class IdleDetector {
  private readonly timeoutMs: number;
  private readonly listener: IdleListener;
  private readonly target: EventTarget;
  private readonly boundActivity: () => void;

  private lastActivity = now();
  private idle = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(opts: { timeoutMs: number; listener: IdleListener; target?: EventTarget }) {
    this.timeoutMs = opts.timeoutMs;
    this.listener = opts.listener;
    this.target = opts.target ?? (typeof window !== "undefined" ? window : new EventTarget());
    this.boundActivity = () => this.onActivity();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastActivity = now();
    this.idle = false;
    for (const ev of ACTIVITY_EVENTS) {
      this.target.addEventListener(ev, this.boundActivity, { passive: true } as AddEventListenerOptions);
    }
    this.arm();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const ev of ACTIVITY_EVENTS) {
      this.target.removeEventListener(ev, this.boundActivity);
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get isIdle(): boolean {
    return this.idle;
  }

  /** Register activity without a DOM event (e.g. when the tab becomes visible). */
  poke(): void {
    this.onActivity();
  }

  private onActivity(): void {
    this.lastActivity = now();
    if (this.idle) {
      this.idle = false;
      this.listener(false);
    }
    if (this.running) this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.running || this.idle) return;
      if (now() - this.lastActivity >= this.timeoutMs) {
        this.idle = true;
        this.listener(true);
      } else {
        this.arm();
      }
    }, this.timeoutMs);
  }
}
