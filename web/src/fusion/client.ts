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
import { api, errorMessage } from "../api";
import { useCallback, useEffect, useState } from "react";
import { mockDelay, mockRequest } from "./mock";

// Mock in dev/test, live endpoints in production builds, unless overridden.
export const FUSION_DEVELOPMENT =
  import.meta.env.DEV && import.meta.env.VITE_FUSION_LIVE !== "true";

/** Raised when a request was aborted by unmount or a superseded request. */
export class FusionAbortError extends Error {}
/** Raised when the backend (or mock) answers with an error status. */
export class FusionHttpError extends Error {}

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
    if (result.status >= 400)
      throw new FusionHttpError(decodeMockError(result.status, result.data));
    return result.data;
  }
  // Paths are stored with their documented prefix (/admin/..., /healthz); the
  // shared axios instance carries baseURL=/admin, so request with an empty base.
  const response = await api.request<unknown, { data: unknown }>({
    method,
    url: fullPath,
    baseURL: "",
    data: body,
    signal: options.signal,
  });
  return response.data;
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
  useEffect(() => {
    if (!enabled || path === null) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ data: null, loading: true, error: null });
    void fusionGet(path, new URLSearchParams(query), { signal: controller.signal })
      .then((raw) => {
        if (controller.signal.aborted) return;
        try {
          setState({ data: normalize(raw), loading: false, error: null });
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
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, query, revision, enabled]);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { ...state, reload };
}
