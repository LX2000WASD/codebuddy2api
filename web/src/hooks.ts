// Shared interaction primitives: debounce, ticking clocks, and optimistic writes.
// Dependency-free; every helper cancels cleanly on unmount so views never apply
// stale results (the same contract useResource gives the legacy pages).
import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Defers a rapidly changing value (search boxes, range pickers) so each keystroke
 * does not fire a request. The pending timer is dropped on unmount or value change.
 */
export function useDebouncedValue<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * One process-wide 1 Hz wall clock, shared by every subscriber.
 *
 * The old useNow() started an interval per calling component: the credentials page
 * and the diagnostics page each ran one at the page root (so the whole page
 * re-rendered once a second), and every <Countdown> instance started another one —
 * a lock table with N rows and 2 countdowns per row ran 2N independent timers.
 *
 * This clock keeps exactly one interval, and only while somebody is subscribed.
 * Subscribers are notified with a monotonically increasing tick count rather than
 * a timestamp, so a consumer can never drop a tick by comparing equal milliseconds.
 */
type ClockListener = () => void;
const clock = {
  listeners: new Set<ClockListener>(),
  timer: null as ReturnType<typeof setInterval> | null,
  /** Bumped on every tick; useSyncExternalStore needs a value that changes. */
  tick: 0,
  /** Wall clock captured at the last tick (refreshed before the first tick too). */
  now: Date.now(),
  intervalMs: 1000,
};

function clockEmit() {
  clock.now = Date.now();
  clock.tick += 1;
  for (const listener of clock.listeners) listener();
}

function clockStop() {
  if (clock.timer !== null) {
    clearInterval(clock.timer);
    clock.timer = null;
  }
}

const noopSubscribe = () => () => {};

function clockSubscribe(listener: ClockListener): () => void {
  clock.listeners.add(listener);
  if (clock.timer === null) {
    // Re-read the wall clock before the first tick so a resumed clock never
    // renders a stale timestamp while it waits up to intervalMs for that tick.
    clock.now = Date.now();
    clock.timer = setInterval(clockEmit, clock.intervalMs);
  }
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0) clockStop();
  };
}

const clockSnapshot = () => clock.tick;

/** Test/teardown seam: stop the interval without waiting for subscribers to unmount. */
export function resetGlobalClock() {
  clockStop();
  clock.listeners.clear();
  clock.tick = 0;
  clock.now = Date.now();
}

/**
 * Subscribes to the shared clock and returns the current epoch milliseconds.
 *
 * `enabled: false` unsubscribes entirely — a page that only renders countdowns
 * inside a drawer must not keep the 1 Hz timer alive while the drawer is closed.
 */
export function useNow(enabled = true): number {
  useSyncExternalStore(enabled ? clockSubscribe : noopSubscribe, clockSnapshot, clockSnapshot);
  return clock.now;
}

/**
 * The same shared clock, quantized: re-renders once every `seconds` ticks.
 *
 * Filter predicates and "N ready" counters only care about a cooldown *expiring*,
 * not about the digits in between. Subscribing them to the 1 Hz snapshot would drag
 * the whole list back into the per-second render path this refactor just removed; a
 * coarse snapshot changes once every `seconds` ticks, so React bails out of the
 * ticks in between while the one shared interval keeps running for leaf countdowns.
 */
export function useCoarseNow(seconds = 10, enabled = true): number {
  const quantize = () => Math.floor(clock.tick / Math.max(1, seconds));
  useSyncExternalStore(enabled ? clockSubscribe : noopSubscribe, quantize, quantize);
  return clock.now;
}

/**
 * Relative time for "updated N seconds ago" hints: 0 -> 刚刚, 42 -> 42 秒前.
 * Deliberately free of i18n keys so a freshness hint can be dropped anywhere.
 */
export function sinceText(fetchedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - fetchedAt) / 1000));
  if (seconds < 2) return "刚刚";
  if (seconds < 60) return seconds + " 秒前";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + " 分钟前";
  return Math.floor(minutes / 60) + " 小时前";
}

/**
 * Formats a remaining countdown compactly: 92 -> "1:32", 3725 -> "1:02:05".
 * Accepts epoch seconds (or milliseconds when ms=true); null/unknown renders fallback.
 */
export function countdownText(
  until: number | null,
  fallback = "—",
  now = Date.now(),
  ms = false,
): string {
  // Unset, unknown and zero deadlines (fail_until=0 means no circuit breaker)
  // all share the fallback instead of rendering a fake 0:00.
  if (typeof until !== "number" || !Number.isFinite(until) || until <= 0) return fallback;
  const seconds = Math.max(0, Math.ceil(until - (ms ? now : now / 1000)));
  if (seconds >= 3600) {
    const parts = [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), seconds % 60];
    return parts
      .map((part) => String(part).padStart(2, "0"))
      .join(":")
      .replace(/^0+(?!$)/, "");
  }
  return `${String(Math.floor(seconds / 60)).padStart(seconds >= 600 ? 2 : 1, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}`;
}

/**
 * Optimistic local state overlay for a keyed record list (credentials, channels...).
 * Write the expected server value immediately, then commit on confirmation or
 * roll back on failure. Callers keep full responsibility for the real request.
 *
 * view() returns the *same object* it was handed when the row has no pending
 * write. That identity is load-bearing: a derived row that is re-created on
 * every render makes every effect depending on it re-run, which turned the
 * credentials detail drawer into a request loop (/admin/logs at ~520 req/s).
 * Callers that need a stable dependency must key effects on scalars, not on the
 * derived row — but the overlay must not manufacture new objects by itself.
 */
export function useOptimisticOverrides<Key extends string | number>() {
  const [overrides, setOverrides] = useState<Partial<Record<Key, Record<string, unknown>>>>({});
  const apply = (key: Key, patch: Record<string, unknown>) =>
    setOverrides((old) => ({ ...old, [key]: { ...old[key], ...patch } }));
  const clear = (key: Key) =>
    setOverrides((old) => {
      if (!Object.hasOwn(old, key)) return old;
      const next = { ...old };
      delete next[key];
      return next;
    });
  const view = <T extends Record<string, unknown>>(record: T & { id?: Key }): T => {
    const patch = overrides[record.id as Key];
    return patch ? { ...record, ...patch } : record;
  };
  return { apply, clear, view };
}
