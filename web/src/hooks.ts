// Shared interaction primitives: debounce, ticking clocks, and optimistic writes.
// Dependency-free; every helper cancels cleanly on unmount so views never apply
// stale results (the same contract useResource gives the legacy pages).
import { useEffect, useState } from "react";

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
 * A wall clock that re-renders on the given cadence. Countdowns and relative times
 * share one interval per component instead of each row owning a timer.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
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
  const view = <T extends Record<string, unknown>>(record: T & { id?: Key }): T =>
    overrides[record.id as Key] ? { ...record, ...overrides[record.id as Key] } : record;
  return { apply, clear, view, overrides };
}
