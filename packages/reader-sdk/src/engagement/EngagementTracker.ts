import { IdleDetector } from "./idle.js";
import type { PauseReason } from "../types.js";

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export interface EngagementChange {
  engaged: boolean;
  /** Why disengaged (only meaningful when `engaged === false`). */
  reason: PauseReason | null;
}

export interface EngagementTrackerOptions {
  target?: HTMLElement;
  idleTimeoutMs: number;
  /** `0` disables the scroll-stall check. */
  scrollStallTimeoutMs: number;
  onChange: (change: EngagementChange) => void;
}

/**
 * Collapses tab visibility, window focus, user-idle and (optionally) scroll-stall
 * into a single `engaged` boolean, and accumulates engaged wall-clock time with a
 * monotonic clock. Emits only on transitions.
 */
export class EngagementTracker {
  private readonly opts: EngagementTrackerOptions;
  private readonly idleDetector: IdleDetector;
  private readonly handlers: Array<[EventTarget, string, EventListener]> = [];

  private visible = true;
  private focused = true;
  private idle = false;
  private scrollStalled = false;
  private manualPaused = false;

  private engaged = false;
  private engagedMs = 0;
  private lastEngagedAt: number | null = null;

  private lastScrollTop = 0;
  private lastScrollProgressAt = 0;
  private scrollStallTimer: ReturnType<typeof setInterval> | null = null;

  private running = false;

  constructor(opts: EngagementTrackerOptions) {
    this.opts = opts;
    this.idleDetector = new IdleDetector({
      timeoutMs: opts.idleTimeoutMs,
      listener: (idle) => {
        this.idle = idle;
        this.recompute();
      },
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    this.visible = typeof document !== "undefined" ? document.visibilityState === "visible" : true;
    // Optimistic focus. A session almost always starts right after a wallet
    // popup closes, and `document.hasFocus()` is an unreliable false-negative in
    // that moment: the tab stayed *visible* the whole time, but the browser has
    // not handed the focus flag back to the page yet, and no `focus` event fires
    // to fix it (the window itself never lost focus — only the extension popup
    // did). Seeding `false` there means normal reading accrues nothing until the
    // reader clicks the page. A genuine blur still demotes us via the `blur`
    // listener bound below.
    this.focused = true;
    this.idle = false;
    this.scrollStalled = false;

    // Seed the initial engaged state without emitting — starting is not a
    // transition from the caller's point of view; they can read isEngaged.
    this.engaged =
      this.visible && this.focused && !this.idle && !this.scrollStalled && !this.manualPaused;
    this.lastEngagedAt = this.engaged ? now() : null;

    this.bind(document, "visibilitychange", () => {
      this.visible = document.visibilityState === "visible";
      if (this.visible) this.idleDetector.poke();
      this.recompute();
    });
    this.bind(window, "focus", () => {
      this.focused = true;
      this.idleDetector.poke();
      this.recompute();
    });
    this.bind(window, "blur", () => {
      this.focused = false;
      this.recompute();
    });
    this.bind(window, "pagehide", () => {
      this.visible = false;
      this.recompute();
    });
    this.bind(window, "pageshow", () => {
      this.visible = typeof document !== "undefined" ? document.visibilityState === "visible" : true;
      this.idleDetector.poke();
      this.recompute();
    });

    this.idleDetector.start();

    if (this.opts.scrollStallTimeoutMs > 0) {
      const scrollTarget: EventTarget = this.opts.target ?? window;
      this.lastScrollTop = this.readScrollTop();
      this.lastScrollProgressAt = now();
      this.bind(scrollTarget, "scroll", () => {
        const top = this.readScrollTop();
        if (Math.abs(top - this.lastScrollTop) > 2) {
          this.lastScrollTop = top;
          this.lastScrollProgressAt = now();
          if (this.scrollStalled) {
            this.scrollStalled = false;
            this.recompute();
          }
        }
      });
      this.scrollStallTimer = setInterval(
        () => {
          const stalled = now() - this.lastScrollProgressAt >= this.opts.scrollStallTimeoutMs;
          if (stalled !== this.scrollStalled) {
            this.scrollStalled = stalled;
            this.recompute();
          }
        },
        Math.min(1000, this.opts.scrollStallTimeoutMs),
      );
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.settleEngagedTime();
    for (const [t, ev, fn] of this.handlers) t.removeEventListener(ev, fn);
    this.handlers.length = 0;
    this.idleDetector.stop();
    if (this.scrollStallTimer) clearInterval(this.scrollStallTimer);
    this.scrollStallTimer = null;
  }

  get isEngaged(): boolean {
    return this.engaged;
  }

  /** Current disengagement reason, or `null` when engaged. */
  get pauseReason(): PauseReason | null {
    return this.engaged ? null : this.currentReason();
  }

  /** Total engaged time in seconds, including any interval in progress. */
  get engagedSeconds(): number {
    let ms = this.engagedMs;
    if (this.engaged && this.lastEngagedAt !== null) ms += now() - this.lastEngagedAt;
    return ms / 1000;
  }

  setManualPaused(paused: boolean): void {
    if (this.manualPaused === paused) return;
    this.manualPaused = paused;
    this.recompute();
  }

  private currentReason(): PauseReason | null {
    if (this.manualPaused) return "manual";
    if (!this.visible) return "hidden";
    if (!this.focused) return "blur";
    if (this.idle) return "idle";
    if (this.scrollStalled) return "scroll-stall";
    return null;
  }

  private recompute(): void {
    const next = this.visible && this.focused && !this.idle && !this.scrollStalled && !this.manualPaused;
    if (next === this.engaged) return;

    if (next) {
      this.engaged = true;
      this.lastEngagedAt = now();
      this.opts.onChange({ engaged: true, reason: null });
    } else {
      this.settleEngagedTime();
      this.engaged = false;
      this.opts.onChange({ engaged: false, reason: this.currentReason() });
    }
  }

  private settleEngagedTime(): void {
    if (this.engaged && this.lastEngagedAt !== null) {
      this.engagedMs += now() - this.lastEngagedAt;
    }
    this.lastEngagedAt = null;
  }

  private readScrollTop(): number {
    if (this.opts.target) return this.opts.target.scrollTop;
    if (typeof window === "undefined") return 0;
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  private bind(target: EventTarget, ev: string, fn: EventListener): void {
    target.addEventListener(ev, fn, { passive: true } as AddEventListenerOptions);
    this.handlers.push([target, ev, fn]);
  }
}
