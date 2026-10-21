import axios from "axios";
import { create } from "zustand";
import { useCallback, useEffect, useState } from "react";

export type RecordValue = Record<string, unknown>;
export type Session = { authenticated: true; csrf_token: string };
type AuthState = {
  status: "checking" | "authenticated" | "anonymous" | "error";
  csrf: string | null;
  error: string | null;
};
export const useSession = create<AuthState>(() => ({
  status: "checking",
  csrf: null,
  error: null,
}));
export const api = axios.create({ baseURL: "/admin", withCredentials: true, timeout: 20000 });
api.interceptors.request.use((config) => {
  const csrf = useSession.getState().csrf;
  if (csrf) config.headers.set("X-CSRF-Token", csrf);
  return config;
});
api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      useSession.setState({ status: "anonymous", csrf: null, error: null });
    }
    return Promise.reject(error);
  },
);
export function object(value: unknown, context = "响应"): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${context}格式不符合接口契约`);
  return value as RecordValue;
}
export function list(value: unknown, context = "列表"): RecordValue[] {
  if (!Array.isArray(value)) throw new Error(`${context}缺失或格式错误`);
  return value.map((item) => object(item, context));
}
export function text(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return `${value}`;
  return "—";
}
export function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function metric(value: unknown): string {
  const n = number(value);
  return n === null ? "—" : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(n);
}
// Axis-scale abbreviation: 1234 → 1.2K, 429669080 → 429.7M; exact values stay in tooltips.
export function compact(value: unknown): string {
  const n = number(value);
  if (n === null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(n);
}
/** HTTP status of a failed request, or null when the failure never reached the server. */
export function statusOf(error: unknown): number | null {
  return axios.isAxiosError(error) ? (error.response?.status ?? null) : null;
}
export function errorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const bodyData: unknown = error.response?.data;
    const serverMessage =
      bodyData &&
      typeof bodyData === "object" &&
      "error" in bodyData &&
      bodyData.error &&
      typeof bodyData.error === "object" &&
      "message" in bodyData.error &&
      typeof bodyData.error.message === "string"
        ? bodyData.error.message
        : null;
    if (error.response?.status === 409) {
      if (serverMessage?.includes("凭证")) return serverMessage;
      const body: unknown = error.response.data;
      if (
        body &&
        typeof body === "object" &&
        "detail" in body &&
        body.detail &&
        typeof body.detail === "object" &&
        "models" in body.detail
      ) {
        const models = body.detail.models;
        return `凭证仍被模型规则引用，请先解除绑定：${Array.isArray(models) ? models.map(text).join("、") : text(models)}`;
      }
      return "保存冲突：配置已被其他操作更新。请关闭编辑并刷新后重新修改。";
    }
    if (error.response?.status === 401) return "会话已失效，请重新登录。";
    if (error.response?.status === 403)
      return serverMessage ?? "操作被拒绝：请检查当前 key、管理锁定或重新登录刷新 CSRF。";
    if (serverMessage) return serverMessage;
    const data: unknown = error.response?.data;
    if (data && typeof data === "object" && "detail" in data) {
      const detail: unknown = data.detail;
      if (typeof detail === "string") return detail;
      if (
        detail &&
        typeof detail === "object" &&
        "message" in detail &&
        typeof detail.message === "string"
      )
        return detail.message;
      if (detail && typeof detail === "object" && "error" in detail) {
        const nested: unknown = detail.error;
        if (
          nested &&
          typeof nested === "object" &&
          "message" in nested &&
          typeof nested.message === "string"
        )
          return nested.message;
      }
    }
    return error.response
      ? `请求失败（HTTP ${error.response.status}），请检查服务状态。`
      : "无法连接管理 API，请检查网络或服务状态后重试。";
  }
  return error instanceof Error ? error.message : "操作失败，请重试。";
}
export async function establishSession(apiKey?: string) {
  try {
    const response =
      apiKey === undefined
        ? await api.get<unknown>("/session")
        : await api.post<unknown>("/session", { api_key: apiKey });
    const data = object(response.data, "会话");
    if (data.authenticated === false) {
      useSession.setState({ status: "anonymous", csrf: null, error: null });
      return;
    }
    if (data.authenticated !== true || typeof data.csrf_token !== "string" || !data.csrf_token)
      throw new Error("会话响应缺少认证状态或 CSRF token");
    useSession.setState({ status: "authenticated", csrf: data.csrf_token, error: null });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      useSession.setState({ status: "anonymous", csrf: null, error: null });
      if (apiKey !== undefined) throw new Error("API key 无效或管理界面未启用。");
      return;
    }
    useSession.setState({ status: "error", csrf: null, error: errorMessage(error) });
    if (apiKey !== undefined) throw error;
  }
}
// Session-level response cache for heavy pages (model routing): reopening the
// page renders the last snapshot instantly while a fresh fetch replaces it.
const resourceCache = new Map<string, unknown>();
useSession.subscribe((state, prev) => {
  if (state.status !== "authenticated" || state.csrf !== prev.csrf) resourceCache.clear();
});
export function useResource<T>(
  path: string,
  normalize: (value: unknown) => T,
  options?: { cache?: boolean },
) {
  const cached = options?.cache ? resourceCache.get(path) : undefined;
  const [state, setState] = useState<{
    path: string;
    data: T | null;
    loading: boolean;
    error: string | null;
  }>({
    path,
    data: cached === undefined ? null : normalize(cached),
    loading: cached === undefined,
    error: null,
  });
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    const cachedForPath = options?.cache ? resourceCache.get(path) : undefined;
    // Keep same-path data (or a cached snapshot) on screen during refresh;
    // clear stale data when switching to a different path without a cache hit.
    setState((prev) => {
      const data =
        prev.path === path
          ? prev.data
          : cachedForPath === undefined
            ? null
            : normalize(cachedForPath);
      return { path, data, loading: data === null, error: null };
    });
    void api
      .get<unknown>(path, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        if (options?.cache) resourceCache.set(path, response.data);
        setState({ path, data: normalize(response.data), loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({
          path,
          data: prev.path === path ? prev.data : null,
          loading: false,
          error: errorMessage(error),
        }));
      });
    return () => controller.abort();
  }, [path, revision, normalize, options?.cache]);
  const currentData =
    state.path === path ? state.data : cached === undefined ? null : normalize(cached);
  return {
    data: currentData,
    loading: state.path === path ? state.loading : cached === undefined,
    error: state.path === path ? state.error : null,
    reload,
  };
}
export type ModelRule = {
  id: string;
  public_id: string;
  upstream_id?: string;
  custom?: boolean;
  available?: boolean;
  /** Live candidate accounts the backend would route to right now (preview.candidates). */
  available_credentials?: number;
  enabled: boolean;
  keep_original: boolean;
  region: string;
  profile: string;
  credential_ids: string[];
  credits?: unknown;
  credits_by_profile?: unknown;
  capabilities?: unknown;
  limits?: unknown;
  metadata_by_profile?: unknown;
};
export function modelResponse(value: unknown): {
  revision: number;
  models: ModelRule[];
  model_guard?: boolean;
  model_guard_locked?: boolean;
  model_capability_guard?: boolean;
  model_capability_guard_locked?: boolean;
} {
  const data = object(value);
  if (typeof data.revision !== "number") throw new Error("模型响应缺少 revision");
  const models = list(data.models).map((m) => {
    if (
      typeof m.id !== "string" ||
      typeof m.enabled !== "boolean" ||
      typeof m.keep_original !== "boolean" ||
      (m.upstream_id !== undefined && typeof m.upstream_id !== "string") ||
      (m.custom !== undefined && typeof m.custom !== "boolean") ||
      !Array.isArray(m.credential_ids) ||
      !m.credential_ids.every((id) => typeof id === "string")
    )
      throw new Error("模型规则字段不完整");
    return {
      ...m,
      id: m.id,
      public_id: typeof m.public_id === "string" ? m.public_id : m.id,
      upstream_id: typeof m.upstream_id === "string" ? m.upstream_id : m.id,
      custom: m.custom === true,
      available: typeof m.available === "boolean" ? m.available : undefined,
      available_credentials:
        typeof m.available_credentials === "number" && Number.isFinite(m.available_credentials)
          ? m.available_credentials
          : undefined,
      enabled: m.enabled,
      keep_original: m.keep_original,
      region: typeof m.region === "string" ? m.region : "",
      profile: typeof m.profile === "string" ? m.profile : "",
      credential_ids: m.credential_ids as string[],
    };
  });
  return {
    revision: data.revision,
    models,
    model_guard: typeof data.model_guard === "boolean" ? data.model_guard : undefined,
    model_guard_locked:
      typeof data.model_guard_locked === "boolean" ? data.model_guard_locked : undefined,
    model_capability_guard:
      typeof data.model_capability_guard === "boolean" ? data.model_capability_guard : undefined,
    model_capability_guard_locked:
      typeof data.model_capability_guard_locked === "boolean"
        ? data.model_capability_guard_locked
        : undefined,
  };
}
/**
 * Model lock aggregation from /admin/diagnostic (app/diagnostic.py:93-150). Locks are
 * grouped by (profile, model), so one model can appear several times — the model page
 * ranks them instead of assuming a single entry.
 */
export type ModelLock = {
  profile: string;
  model: string;
  locked_accounts: number;
  account_ids: string[];
  earliest_unlock_at: number | null;
  latest_unlock_at: number | null;
  all_unlock_in_seconds: number | null;
  kind: "rate_limit" | "model_block";
  reason: string;
  /** Backend model blocks are advisory: they describe an upstream outage, not a quota. */
  advisory?: boolean;
};
export type ModelLocks = {
  generated_at: number;
  model_locks: ModelLock[];
};
export function normalizeModelLocks(value: unknown): ModelLocks {
  const data = object(value, "诊断");
  if (!Array.isArray(data.model_locks)) throw new Error("诊断响应缺少 model_locks");
  const locks: ModelLock[] = [];
  for (const raw of data.model_locks) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as RecordValue;
    if (typeof row.model !== "string") continue;
    const kind = row.kind === "model_block" ? "model_block" : "rate_limit";
    const ids = Array.isArray(row.account_ids)
      ? row.account_ids.filter((id): id is string => typeof id === "string")
      : [];
    const seconds = number(row.all_unlock_in_seconds);
    locks.push({
      profile: typeof row.profile === "string" ? row.profile : "unknown",
      model: row.model,
      locked_accounts: number(row.locked_accounts) ?? ids.length,
      account_ids: ids,
      earliest_unlock_at: number(row.earliest_unlock_at),
      latest_unlock_at: number(row.latest_unlock_at),
      all_unlock_in_seconds: seconds,
      kind,
      reason: typeof row.reason === "string" ? row.reason : "",
      advisory: row.advisory === true ? true : undefined,
    });
  }
  return { generated_at: number(data.generated_at) ?? 0, model_locks: locks };
}
export type Credential = RecordValue & {
  id: string;
  name: string | null;
  /** Orthogonal to enabled: paused leaves the account in the pool for check-in/travel. */
  paused?: boolean;
};
export function credentialResponse(value: unknown): Credential[] {
  return list(object(value).credentials, "凭证").map((c) => {
    const id = c.account_key ?? c.id;
    if (typeof id !== "string" || !id) throw new Error("凭证缺少公开 account_key");
    const name = c.name ?? c.filename;
    for (const field of [
      "auto_checkin",
      "auto_travel",
      "auto_daily_chat",
      "travel_supported",
      "trial_supported",
      "daily_chat_supported",
      "paused",
    ])
      if (c[field] !== undefined && typeof c[field] !== "boolean")
        throw new Error("自动任务状态必须为布尔值");
    for (const field of ["checkin", "travel", "trial", "daily_chat"])
      if (c[field] !== undefined && c[field] !== null) object(c[field], "自动任务结果");
    return { ...c, id, name: typeof name === "string" && !/[\\/]/.test(name) ? name : null };
  });
}
