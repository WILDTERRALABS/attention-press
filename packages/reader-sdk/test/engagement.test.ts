import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EngagementTracker, type EngagementTrackerOptions } from "../src/engagement/EngagementTracker.js";

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

function makeTracker(overrides: Partial<EngagementTrackerOptions> = {}) {
  const changes: Array<{ engaged: boolean; reason: string | null }> = [];
  const tracker = new EngagementTracker({
    idleTimeoutMs: 30_000,
    scrollStallTimeoutMs: 0,
    onChange: (c) => changes.push({ engaged: c.engaged, reason: c.reason }),
    ...overrides,
  });
  return { tracker, changes };
}

describe("EngagementTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.hasFocus = () => true;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is engaged from the start when visible and focused", () => {
    const { tracker } = makeTracker();
    tracker.start();
    expect(tracker.isEngaged).toBe(true);
    expect(tracker.pauseReason).toBeNull();
    tracker.stop();
  });

  it("is engaged from the start when visible even if document.hasFocus() is false", () => {
    // The real-world case: a session starts right after a wallet popup closes and
    // the browser has not restored the page's focus flag yet. Normal reading must
    // still accrue — no click required.
    document.hasFocus = () => false;
    const { tracker, changes } = makeTracker();
    tracker.start();
    expect(tracker.isEngaged).toBe(true);
    expect(tracker.pauseReason).toBeNull();
    expect(changes).toEqual([]); // no spurious pause on start

    vi.advanceTimersByTime(4_000);
    expect(Math.round(tracker.engagedSeconds)).toBe(4); // accruing without interaction

    // a genuine blur still demotes
    window.dispatchEvent(new Event("blur"));
    expect(tracker.isEngaged).toBe(false);
    expect(tracker.pauseReason).toBe("blur");
    tracker.stop();
  });

  it("pauses on hidden, resumes on visible, with the right reasons", () => {
    const { tracker, changes } = makeTracker();
    tracker.start();
    setVisibility("hidden");
    expect(tracker.isEngaged).toBe(false);
    expect(tracker.pauseReason).toBe("hidden");
    setVisibility("visible");
    expect(tracker.isEngaged).toBe(true);
    expect(changes).toEqual([
      { engaged: false, reason: "hidden" },
      { engaged: true, reason: null },
    ]);
    tracker.stop();
  });

  it("pauses on window blur", () => {
    const { tracker } = makeTracker();
    tracker.start();
    window.dispatchEvent(new Event("blur"));
    expect(tracker.isEngaged).toBe(false);
    expect(tracker.pauseReason).toBe("blur");
    window.dispatchEvent(new Event("focus"));
    expect(tracker.isEngaged).toBe(true);
    tracker.stop();
  });

  it("accumulates engaged time only while engaged", () => {
    const { tracker } = makeTracker();
    tracker.start();
    vi.advanceTimersByTime(10_000);
    expect(Math.round(tracker.engagedSeconds)).toBe(10);

    setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    expect(Math.round(tracker.engagedSeconds)).toBe(10); // frozen while hidden

    setVisibility("visible");
    vi.advanceTimersByTime(5_000);
    expect(Math.round(tracker.engagedSeconds)).toBe(15);
    tracker.stop();
  });

  it("goes idle after the timeout and recovers on activity", () => {
    const { tracker } = makeTracker({ idleTimeoutMs: 30_000 });
    tracker.start();
    vi.advanceTimersByTime(30_001);
    expect(tracker.isEngaged).toBe(false);
    expect(tracker.pauseReason).toBe("idle");

    window.dispatchEvent(new Event("pointermove"));
    expect(tracker.isEngaged).toBe(true);
    tracker.stop();
  });

  it("honours manual pause independent of DOM state", () => {
    const { tracker } = makeTracker();
    tracker.start();
    tracker.setManualPaused(true);
    expect(tracker.isEngaged).toBe(false);
    expect(tracker.pauseReason).toBe("manual");
    tracker.setManualPaused(false);
    expect(tracker.isEngaged).toBe(true);
    tracker.stop();
  });

  it("stops accruing and detaches listeners after stop()", () => {
    const { tracker } = makeTracker();
    tracker.start();
    vi.advanceTimersByTime(5_000);
    tracker.stop();
    const frozen = tracker.engagedSeconds;
    vi.advanceTimersByTime(5_000);
    expect(tracker.engagedSeconds).toBe(frozen);
  });
});
