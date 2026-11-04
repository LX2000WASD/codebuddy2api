import { useMemo, useSyncExternalStore } from "react";

/**
 * View state in the address bar.
 *
 * Sorting and filters belong to the URL: they are the two things a user wants to keep across
 * a refresh and paste into a chat ("look at this filter"). It lives in the query string rather
 * than in react-router because these hooks are also used by pages rendered without a router
 * (every unit test mounts a page bare), and a hook that throws outside a Router is not an
 * option.
 *
 * `replaceState`, not `pushState`: a filter change is not a navigation, and one history entry
 * per keystroke-delimited change is hostile to the back button.
 */
const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  // Back/forward still has to refresh the derived state even though we never push.
  window.addEventListener("popstate", emit);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", emit);
  };
}
const snapshot = () => (typeof window === "undefined" ? "" : window.location.search);
const serverSnapshot = () => "";

export type UrlParams = {
  /** The raw query string this snapshot was built from (identity for memo deps). */
  search: string;
  get: (key: string) => string | null;
  getAll: (key: string) => string[];
};

function makeParams(search: string): UrlParams {
  const params = new URLSearchParams(search);
  return {
    search,
    get: (key) => params.get(key),
    getAll: (key) => params.getAll(key),
  };
}

/**
 * Writes view state into the query string. An empty string (or null) removes the key, so a
 * reset leaves a clean, shareable URL instead of "?q=&region=".
 */
export function writeUrlParams(patch: Record<string, string | string[] | null>) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    params.delete(key);
    if (value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item) params.append(key, item);
    } else params.set(key, value);
  }
  const search = params.toString();
  if (search === window.location.search.replace(/^\?/, "")) return;
  const { pathname, hash } = window.location;
  window.history.replaceState(
    window.history.state,
    "",
    `${pathname}${search ? `?${search}` : ""}${hash}`,
  );
  emit();
}

/** Drops every query parameter. Test seam: module state must not leak between cases. */
export function resetUrlState() {
  if (typeof window === "undefined") return;
  const { pathname, hash } = window.location;
  if (!window.location.search) return;
  window.history.replaceState(window.history.state, "", `${pathname}${hash}`);
  emit();
}

/** Current query string as a stable snapshot; re-renders on write and on popstate. */
export function useUrlParams(): UrlParams {
  const search = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  return useMemo(() => makeParams(search), [search]);
}
