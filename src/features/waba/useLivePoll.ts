import { useEffect, useRef } from "react";

type LivePollOptions = {
  /** Whether background polling is active for the current view. */
  enabled: boolean;
  /** Async refresh callback returning true when the poll succeeded, false on error. */
  poll: () => Promise<boolean>;
  /** Steady-state delay after a poll settles while visible (ms). */
  intervalMs?: number;
  /** Maximum backoff delay after repeated failures (ms). */
  maxBackoffMs?: number;
  /** Minimum gap between visibility/focus catch-up triggers and recent polls (ms). */
  minFocusGapMs?: number;
};

/**
 * Visibility-aware, non-overlapping background poll using chained setTimeout.
 * Pauses while the tab is hidden and coalesces focus/visibility wakes without bursts.
 */
export function useLivePoll({
  enabled,
  poll,
  intervalMs = 5_000,
  maxBackoffMs = 30_000,
  minFocusGapMs = 1_000,
}: LivePollOptions): void {
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let inFlight = false;
    let queuedSoon = false;
    let failures = 0;
    let lastRunStartedAt = 0;
    let lastSettledAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const isVisible = () =>
      typeof document === "undefined" || document.visibilityState !== "hidden";

    const nextDelay = () =>
      failures === 0 ? intervalMs : Math.min(intervalMs * Math.pow(2, failures), maxBackoffMs);

    const schedule = (delayMs: number) => {
      clearTimer();
      if (disposed || !isVisible()) return;
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, Math.max(0, delayMs));
    };

    const run = async () => {
      if (disposed || !isVisible()) return;
      if (inFlight) {
        if (Date.now() - lastRunStartedAt >= minFocusGapMs) {
          queuedSoon = true;
        }
        return;
      }
      clearTimer();
      lastRunStartedAt = Date.now();
      inFlight = true;
      let ok = false;
      try {
        ok = await pollRef.current();
      } catch {
        ok = false;
      } finally {
        inFlight = false;
        lastSettledAt = Date.now();
        failures = ok ? 0 : Math.min(failures + 1, 6);
      }
      if (disposed || !isVisible()) return;
      if (queuedSoon) {
        queuedSoon = false;
        schedule(minFocusGapMs);
        return;
      }
      schedule(nextDelay());
    };

    const onWake = () => {
      if (disposed || !isVisible()) {
        if (!isVisible()) clearTimer();
        return;
      }
      if (inFlight) {
        if (Date.now() - lastRunStartedAt >= minFocusGapMs) {
          queuedSoon = true;
        }
        return;
      }
      const elapsed = Date.now() - lastSettledAt;
      if (elapsed >= minFocusGapMs) {
        void run();
      } else {
        schedule(minFocusGapMs - elapsed);
      }
    };

    if (isVisible()) {
      schedule(intervalMs);
    }

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onWake);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onWake);
    }

    return () => {
      disposed = true;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onWake);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onWake);
      }
    };
  }, [enabled, intervalMs, maxBackoffMs, minFocusGapMs]);
}
