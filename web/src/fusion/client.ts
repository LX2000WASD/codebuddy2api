// Fusion management API client.
//
// FUSION_DEVELOPMENT picks the data source for every fusion endpoint:
//   - vitest + vite dev server (e2e/serve.mjs): DEV=true, mock fixtures keep the
//     unit assertions and the "new views send no /admin request" e2e checks green;
//   - production vp build output: DEV=false folds the mock branch out (the
//     fixture module is tree-shaken) so requests hit the live /admin/* endpoints,
//     whose paths/params/bodies already match docs/fusion-api.md;
//   - VITE_FUSION_LIVE=true overrides dev mode to force live endpoints, e.g.
//     pointing the vite dev proxy at a real backend while keeping DEV=true.
// No page code reads this flag; only the request seam below does.
import axios from "axios";
import {
  acquireShared,
  api,
  errorMessage,
  rememberSnapshot,
  releaseShared,
  sharedSnapshot,
} from "../api";
import { useCallback, useEffect, useRef, useState } from "react";
import { mockDelay, mockRequest } from "./mock";

// Mock in dev/test, live endpoints in production builds, unless overridden.
export const FUSION_DEVELOPMENT =
  import.meta.env.DEV && import.meta.env.VITE_FUSION_LIVE !== "true";

/** Raised when a request was aborted by unmount or a superseded request. */
export class FusionAbortError extends Error {}

function decodeMockError(status: number, data: unknown): string {
  const message =
    data && typeof data === "object" && "error" in data
      ? (data as Record<string, { message?: unknown }>).error?.message
      : undefined;
  if (status === 503)
    return typeof message === "string" ? message : "融合接口暂时不可用（存储降级）。";
  if (status === 404)
    return typeof message === "string" ? message : "融合接口尚未部署，请确认后端版本后再试。";
  if (status === 400)
    return typeof message === "string" ? message : "融合接口参数无效，请检查筛选条件。";
  return typeof message === "string" ? message : `融合请求失败（HTTP ${status}）。`;
}

type RequestOptions = { signal?: AbortSignal };

async function perform(
  method: string,
  path: string,
  params: URLSearchParams,
  body: unknown,
  options: RequestOptions = {},
): Promise<unknown> {
  const query = params.toString();
  const fullPath = query ? `${path}?${query}` : path;
  if (FUSION_DEVELOPMENT) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, mockDelay());
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new FusionAbortError("aborted"));
      });
    });
    const result = (() => {
      try {
        return mockRequest(method, path, params, body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "请求参数无效";
        return { status: 400, data: { error: { message, type: "admin_error" } } };
      }
    })();
    if (result.status >= 400) throw new Error(decodeMockError(result.status, result.data));
    return result.data;
  }
  // Paths are stored with their documented prefix (/admin/..., /healthz); the
  // shared axios instance carries baseURL=/admin, so request with an empty base.
  try {
    const response = await api.request<unknown, { data: unknown }>({
      method,
      url: fullPath,
      baseURL: "",
      data: body,
      signal: options.signal,
    });
    return response.data;
  } catch (error) {
    // axios rejects an aborted request with its own CanceledError (code
    // ERR_CANCELED), which no caller recognises as an abort — it would render as a
    // red "cannot reach the admin API" banner whenever a filter change or unmount
    // supersedes a request. Normalise it to the same abort signal the mock branch
    // throws; every other error keeps propagating untouched.
    if (isAbort(error)) throw new FusionAbortError("aborted");
    throw error;
  }
}

/**
 * True for an aborted axios request. axios normalises every abort into its own
 * CanceledError, which sets both `__CANCEL__` (axios.isCancel) and
 * `code === "ERR_CANCELED"`; the code check keeps working even if the error is
 * re-wrapped or cloned by an interceptor.
 */
function isAbort(error: unknown): boolean {
  return axios.isCancel(error) || (axios.isAxiosError(error) && error.code === "ERR_CANCELED");
}

export function fusionGet(path: string, params = new URLSearchParams(), options?: RequestOptions) {
  return perform("GET", path, params, undefined, options);
}
export function fusionMutate(
  method: "PUT" | "PATCH" | "POST",
  path: string,
  body?: unknown,
  params = new URLSearchParams(),
  options?: RequestOptions,
) {
  return perform(method, path, params, body, options);
}

/**
 * Resource hook for the fusion endpoints: fetches on mount and whenever path/params
 * change, aborts (or discards) the superseded request, and never renders stale data
 * after unmount. Pass enabled=false to defer the fetch entirely.
 */
export type FusionResource<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
};

export function useFusionResource<T>(
  path: string | null,
  params: URLSearchParams | null,
  normalize: (value: unknown) => T,
  enabled = true,
): FusionResource<T> {
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [revision, setRevision] = useState(0);
  const query = params?.toString() ?? "";
  // The parser is pinned in a ref: callers pass an inline function, so depending on
  // it directly would refetch on every render. The ref keeps the effect deps exact
  // (path/query/revision/enabled) without an eslint suppression.
  const normalizeRef = useRef(normalize);
  normalizeRef.current = normalize;
  // The snapshot key is the full request URL, so /admin/diagnostic and
  // /admin/diagnostic?profile=cn never collide.
  const key = path === null ? null : fusionSnapshotKey(path, params);
  useEffect(() => {
    if (!enabled || path === null || key === null) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ data: null, loading: true, error: null });
    // Same snapshot layer as useResource, so Diagnostics and Models share one
    // /admin/diagnostic fetch instead of each pulling it on mount. A reload
    // (revision > 0) is a forced fetch and bypasses the TTL.
    const snapshot = revision === 0 ? sharedSnapshot(key) : null;
    let held = false;
    const request = snapshot
      ? Promise.resolve(snapshot.data)
      : (() => {
          held = true;
          // The shared request owns its own AbortController (see acquireShared): the
          // caller's controller only decides whether this component still wants the
          // result, so a StrictMode remount re-joins instead of cancelling.
          return acquireShared(key, (signal) =>
            fusionGet(path, new URLSearchParams(query), { signal }).then((raw) => {
              rememberSnapshot(key, raw);
              return raw;
            }),
          );
        })();
    void request
      .then((raw) => {
        if (controller.signal.aborted) return;
        try {
          setState({ data: normalizeRef.current(raw), loading: false, error: null });
        } catch (error) {
          setState({
            data: null,
            loading: false,
            error: error instanceof Error ? error.message : "响应格式不符合融合接口契约",
          });
        }
      })
      .catch((error: unknown) => {
        // Only aborts are swallowed; real HTTP/network errors must surface.
        if (controller.signal.aborted || error instanceof FusionAbortError) return;
        setState({ data: null, loading: false, error: errorMessage(error) });
      });
    return () => {
      controller.abort();
      if (held) releaseShared(key);
    };
  }, [path, key, query, revision, enabled]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { ...state, reload };
}

/**
 * Snapshot key for a fusion GET.
 *
 * The key is the full request URL, so two calls that differ only in params
 * (/admin/logs?days=1 vs ?days=7, or /admin/diagnostic?profile=cn vs intl) never
 * share a snapshot or an in-flight promise. The TTL decision sits outside
 * perform(), so it applies identically to the mock branch (vitest, e2e serve.mjs)
 * and the live branch — an e2e test that counts requests sees exactly what the
 * live UI would send.
 */
export function fusionSnapshotKey(path: string, params: URLSearchParams | null): string {
  const query = params?.toString() ?? "";
  return query ? path + "?" + query : path;
}
