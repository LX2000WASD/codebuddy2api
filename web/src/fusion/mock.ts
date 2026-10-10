// Local fixture implementation of docs/fusion-api.md for frontend development while
// the Fusion-B backend is being wired. Responses mirror the documented shapes so
// switching to the live client (fusion/client.ts) is only a flag change.
// Nothing here touches the network, so opening these views never hits upstream.
import type {
  AlertEvent,
  AlertEventsResponse,
  ChannelConfig,
  ChannelsResponse,
  ChannelTestResult,
  CreditExpiryResponse,
  DiagnosticResponse,
  StatsDimensionsResponse,
  StatsSeriesResponse,
  StatsSummaryResponse,
  ServiceStatus,
} from "./types";

/** Deterministic 32-bit hash so a given (path,params) always renders the same chart. */
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
function rng(seed: number) {
  let state = seed || 1;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export type MockAccount = {
  id: string;
  name: string;
  profile: string;
  health: string;
  enabled: boolean;
  paused: boolean;
  disabled_reason: string | null;
  fail_until: number;
  cooldown_reason: string | null;
  model_cooldowns: { model: string; until: number }[];
  last_error_code: string | null;
  last_failure_at: number | null;
  sync_error: string | null;
  catalog_ready: boolean;
  share: number;
};

const MODEL_CATALOG = [
  "deepseek-chat",
  "deepseek-reasoner",
  "gpt-5-codex",
  "claude-sonnet-4",
  "gemini-2-pro",
  "qwen-max-latest",
];
const PROFILES = ["cn-cli", "cn-work", "intl-cli", "intl-work"];

const NOW = () => Date.now() / 1000;
const DAY = 86400;

function accountsFixture(): MockAccount[] {
  const now = NOW();
  return [
    {
      id: "cn-mainland-a",
      name: "mainland-a.info",
      profile: "cn-cli",
      health: "ready",
      enabled: true,
      paused: false,
      disabled_reason: null,
      fail_until: 0,
      cooldown_reason: null,
      model_cooldowns: [{ model: "deepseek-chat", until: now + 1800 }],
      last_error_code: null,
      last_failure_at: now - 86400 * 2,
      sync_error: null,
      catalog_ready: true,
      share: 0.34,
    },
    {
      id: "cn-mainland-b",
      name: "mainland-b.info",
      profile: "cn-cli",
      health: "circuit_open",
      enabled: true,
      paused: false,
      disabled_reason: "认证熔断",
      fail_until: now + 820,
      cooldown_reason: "backend HTTP 401",
      model_cooldowns: [],
      last_error_code: "http_401",
      last_failure_at: now - 240,
      sync_error: null,
      catalog_ready: true,
      share: 0.18,
    },
    {
      id: "cn-work-buddy",
      name: "work-buddy.info",
      profile: "cn-work",
      health: "ready",
      enabled: true,
      paused: false,
      disabled_reason: null,
      fail_until: 0,
      cooldown_reason: null,
      model_cooldowns: [],
      last_error_code: null,
      last_failure_at: null,
      sync_error: null,
      catalog_ready: true,
      share: 0.16,
    },
    {
      id: "intl-cb-pro",
      name: "intl-pro.info",
      profile: "intl-cli",
      health: "disabled",
      enabled: false,
      paused: true,
      disabled_reason: "人工停用",
      fail_until: 0,
      cooldown_reason: null,
      model_cooldowns: [],
      last_error_code: null,
      last_failure_at: null,
      sync_error: null,
      catalog_ready: false,
      share: 0.2,
    },
    {
      id: "intl-work-1",
      name: "intl-work-1.info",
      profile: "intl-work",
      health: "expired",
      enabled: true,
      paused: false,
      disabled_reason: "登录身份过期",
      fail_until: 0,
      cooldown_reason: null,
      model_cooldowns: [{ model: "gpt-5-codex", until: now + 3600 * 5 }],
      last_error_code: "credential_error",
      last_failure_at: now - 86400,
      sync_error: "余额同步被上游拒绝",
      catalog_ready: false,
      share: 0.12,
    },
  ];
}

export type FusionMockState = {
  accounts: MockAccount[];
  revisions: number;
  channels: {
    webhook?: Record<string, unknown>;
    bark?: Record<string, unknown>;
    email?: Record<string, unknown>;
  };
  events: AlertEvent[];
  // Paused writes for accounts that exist only in the real credential list keep
  // the demo functional while the live endpoint is not deployed.
  extraPaused: Record<string, boolean>;
};

function channelsFixture() {
  return {
    webhook: {
      enabled: true,
      url: "https://hook.example.com/ingest?token=demo-secret",
      headers_template: { "X-Service": "codebuddy2api" },
    },
    bark: { enabled: false, server: "", key: "demo-bark-key", sound: "bell", group: "cb2api" },
    email: {
      enabled: false,
      smtp_host: "smtp.example.com",
      smtp_port: 465,
      username: "alert@example.com",
      password: "",
      from: "alert@example.com",
      to: ["ops@example.com"],
      use_tls: true,
    },
  };
}

function eventsFixture(): AlertEvent[] {
  const now = NOW();
  const base: Array<Partial<AlertEvent> & { kind: string; title: string; detail: string }> = [
    {
      kind: "credits_expiring",
      severity: "warning",
      title: "积分即将到期",
      detail: "账号 mainland-a.info 剩余 120 积分将在 2.1 天后到期",
      account_id: "cn-mainland-a",
      context: { remaining_credits: 120, days_remaining: 2.1, soonest_expiry: now + 2.1 * DAY },
    },
    {
      kind: "token_circuit",
      severity: "warning",
      title: "认证熔断已激活",
      detail: "账号 mainland-b.info 连续认证失败，熔断 820 秒",
      account_id: "cn-mainland-b",
      context: { fail_until: now + 820 },
    },
    {
      kind: "balance_exhausted",
      severity: "critical",
      title: "账号余额耗尽",
      detail: "账号 intl-work-1.info 余额已确认为 0",
      account_id: "intl-work-1",
      context: { remaining_credits: 0 },
    },
    {
      kind: "catalog_sync_failed",
      severity: "warning",
      title: "目录同步失败",
      detail: "账号 intl-work-1.info 余额/目录同步被上游拒绝",
      account_id: "intl-work-1",
      context: { sync_error: "余额同步被上游拒绝" },
    },
    {
      kind: "audit_degraded",
      severity: "critical",
      title: "审计存储降级",
      detail: "审计库写入失败 3 次，统计可能不完整",
      account_id: null,
      context: { failure_count: 3 },
    },
    {
      kind: "pool_exhausted",
      severity: "critical",
      title: "全池无可服务账号",
      detail: "全部账号熔断或停用，网关拒绝服务",
      account_id: null,
      context: {},
    },
  ];
  const offsets = [900, 2400, 5400, 12600, 43200, 90000];
  return base.map(
    (event, index) =>
      ({
        id: `evt-${index.toString(16).padStart(2, "0")}-f${(index * 7).toString(16)}a`,
        severity: event.severity ?? "info",
        fired_at: now - offsets[index]!,
        delivered:
          index % 3 === 2
            ? []
            : [
                {
                  channel: "webhook",
                  ok: index !== 5,
                  at: now - offsets[index]! + 1.4,
                  error: index === 5 ? "connect timeout" : null,
                },
              ],
        ...event,
      }) as AlertEvent,
  );
}

let state: FusionMockState | null = null;
let latencyMs = 260;
export function __resetFusionMock() {
  state = null;
}
export function __setFusionLatency(ms: number) {
  latencyMs = ms;
}
function store() {
  if (!state)
    state = {
      accounts: accountsFixture(),
      revisions: 7,
      channels: channelsFixture(),
      events: eventsFixture(),
      extraPaused: {},
    };
  return state;
}

function statusResponse(): ServiceStatus {
  const accounts = store().accounts;
  const healthy = accounts.filter((a) => a.health === "ready").length;
  return {
    service: "codebuddy2api",
    version: "1.3.2-local",
    uptime_seconds: 92400 + Math.floor(NOW() % 86400),
    generated_at: NOW(),
    pool: {
      total: accounts.length,
      healthy,
      cooling: accounts.filter((a) => a.health === "circuit_open").length,
      disabled: accounts.filter((a) => !a.enabled).length,
      expired: accounts.filter((a) => a.health === "expired").length,
      error: accounts.filter((a) => a.health === "error").length,
      servable: healthy > 0,
    },
    by_profile: PROFILES.reduce(
      (acc, profile) => {
        const rows = accounts.filter((a) => a.profile === profile);
        acc[profile] = {
          total: rows.length,
          healthy: rows.filter((a) => a.health === "ready").length,
          servable: rows.some((a) => a.health === "ready"),
        };
        return acc;
      },
      {} as ServiceStatus["by_profile"],
    ),
    audit: { degraded: false, failure_count: 0, dropped_records: 0, last_error: null },
    cooldown_storage: { available: true, degraded: false, rows: 3, last_error: null },
    alerts: {
      enabled: true,
      evaluator_running: true,
      pending_deliveries: 0,
      last_event_at: NOW() - 900,
    },
  };
}

function diagnosticResponse(): DiagnosticResponse {
  const accounts = store().accounts;
  const now = NOW();
  return {
    generated_at: now,
    pool: {
      total: accounts.length,
      healthy: accounts.filter((a) => a.health === "ready").length,
      servable: accounts.some((a) => a.health === "ready"),
    },
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      profile: a.profile,
      health: a.health,
      enabled: a.enabled,
      paused: a.paused,
      disabled_reason: a.disabled_reason,
      cooldown:
        a.fail_until > 0
          ? {
              fail_until: a.fail_until,
              remaining_seconds: Math.max(0, a.fail_until - now),
              reason: a.cooldown_reason ?? "认证熔断",
            }
          : null,
      model_cooldowns: a.model_cooldowns.map((c) => ({
        model: c.model,
        until: c.until,
        remaining_seconds: Math.max(0, c.until - now),
      })),
      last_error_code: a.last_error_code,
      last_failure_at: a.last_failure_at,
      sync_error: a.sync_error,
      catalog_ready: a.catalog_ready,
    })),
    model_locks: [
      {
        profile: "cn-cli",
        model: "deepseek-chat",
        locked_accounts: 1,
        account_ids: ["cn-mainland-a"],
        earliest_unlock_at: now + 1800,
        latest_unlock_at: now + 1800,
        all_unlock_in_seconds: 1800,
        kind: "rate_limit",
        reason: "模型额度冷却",
      },
      {
        profile: "intl-work",
        model: "gpt-5-codex",
        locked_accounts: 1,
        account_ids: ["intl-work-1"],
        earliest_unlock_at: now + 3600 * 5,
        latest_unlock_at: now + 3600 * 5,
        all_unlock_in_seconds: 3600 * 5,
        kind: "model_block",
        reason: "后端模型不可用",
      },
    ],
    cooldown_storage: { available: true, degraded: false, rows: 3, last_error: null },
  };
}
// ── statistics fixtures ─────────────────────────────────────────────────────
type BucketSeed = {
  requests: number;
  success: number;
  error: number;
  cancelled: number;
  input_tokens: number;
  output_tokens: number;
  credit: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  tokens_per_s: number | null;
};

function seriesSeed(days: number, granularity: "hour" | "day", dimension: string, key: string) {
  const random = rng(hash(`${days}|${granularity}|${dimension}|${key}`));
  const step = granularity === "hour" ? 3600 : 86400;
  const count = days * (granularity === "hour" ? 24 : 1);
  const end = Math.floor(NOW() / step) * step;
  const weight =
    dimension === "global"
      ? 1
      : dimension === "model"
        ? 0.12 + rng(hash("model|" + key))() * 0.5
        : dimension === "profile"
          ? 0.1 + rng(hash("profile|" + key))() * 0.4
          : (store().accounts.find((a) => a.id === key)?.share ?? 0.15);
  const buckets: BucketSeed[] = [];
  for (let i = 0; i < count; i++) {
    const bucket = end - (count - 1 - i) * step;
    const hour = (bucket % 86400) / 3600;
    const daily =
      granularity === "hour"
        ? 0.25 + 0.75 * Math.exp(-((hour - 15) ** 2) / 40)
        : 0.6 + 0.4 * Math.sin(i / 3.1);
    let requests = Math.round(38 * weight * daily * (0.55 + random() * 0.9));
    if (random() < (dimension === "global" ? 0.06 : 0.16)) requests = 0;
    const error = Math.round(requests * (0.01 + random() * 0.05));
    const cancelled = Math.round(requests * random() * 0.03);
    const success = Math.max(0, requests - error - cancelled);
    const input_tokens = success * Math.round(320 + random() * 900);
    const output_tokens = success * Math.round(180 + random() * 640);
    const known = success + Math.round(random() * (requests - success));
    const quantiles = known < 5 ? null : { p50: 900 + random() * 2600, p95: 0, p99: 0 };
    const p95 = quantiles ? quantiles.p50 * (2.6 + random() * 1.4) : null;
    const p99 = quantiles && p95 !== null ? p95 * (1.5 + random() * 0.8) : null;
    const first_token = 240 + random() * 360;
    const effective = success ? (success * 3200 - first_token * success) / 1000 : 0;
    buckets.push({
      requests,
      success,
      error,
      cancelled,
      input_tokens,
      output_tokens,
      credit: Math.round((output_tokens / 1000) * (0.8 + random() * 0.6) * 10) / 10,
      p50: quantiles ? Math.round(quantiles.p50) : null,
      p95: p95 === null ? null : Math.round(p95),
      p99: p99 === null ? null : Math.round(p99),
      tokens_per_s:
        effective > 0 && known >= 5 ? Math.round((output_tokens / effective) * 10) / 10 : null,
    });
  }
  return { buckets, step, end, count };
}

function summarize(buckets: BucketSeed[]) {
  const reduce = (pick: (b: BucketSeed) => number) => buckets.reduce((sum, b) => sum + pick(b), 0);
  const known = buckets.reduce((sum, b) => sum + (b.p50 === null ? 0 : 1), 0);
  const latencyKnownSamples = Math.max(1, Math.round(reduce((b) => b.requests) / buckets.length));
  const tokensKnownSamples = Math.max(1, Math.round(reduce((b) => b.requests) * 0.94));
  const weighed = (pick: (b: BucketSeed) => number | null) => {
    const rows = buckets.filter((b) => pick(b) !== null);
    return rows.length ? rows.reduce((sum, b) => sum + (pick(b) as number), 0) / rows.length : null;
  };
  const tokensPerS = (() => {
    const rows = buckets.filter((b) => b.tokens_per_s !== null);
    const totalTokens = rows.reduce((sum, b) => sum + b.output_tokens, 0);
    return rows.length ? totalTokens / Math.max(1, rows.length * 3.1) : null;
  })();
  return {
    requests: reduce((b) => b.requests),
    success: reduce((b) => b.success),
    error: reduce((b) => b.error),
    cancelled: reduce((b) => b.cancelled),
    input_tokens: reduce((b) => b.input_tokens),
    output_tokens: reduce((b) => b.output_tokens),
    total_tokens: reduce((b) => b.input_tokens + b.output_tokens),
    credit: Math.round(reduce((b) => b.credit) * 10) / 10,
    duration_avg_ms: weighed((b) => (b.p50 === null ? null : b.p50 * 1.35)),
    first_token_avg_ms: 240,
    latency_p50_ms: weighed((b) => b.p50),
    latency_p95_ms: weighed((b) => b.p95),
    latency_p99_ms: weighed((b) => b.p99),
    latency_known: known * latencyKnownSamples,
    tokens_per_s: tokensPerS === null ? null : Math.round(tokensPerS * 10) / 10,
    tokens_per_s_known: tokensPerS === null ? 0 : tokensKnownSamples,
  };
}

function statsSummary(days: number): StatsSummaryResponse {
  const { buckets } = seriesSeed(days, days === 1 ? "hour" : "day", "global", "");
  const step = days === 1 ? 3600 : 86400;
  const end = Math.floor(NOW() / step) * step;
  return {
    generated_at: NOW(),
    range: { days, start: end - days * step + step, end, granularity: days === 1 ? "hour" : "day" },
    summary: summarize(buckets),
    degraded: false,
  };
}

function statsSeries(params: URLSearchParams): StatsSeriesResponse {
  const days = Number(params.get("days") ?? 7);
  const granularityParam = params.get("granularity") ?? "auto";
  const dimension = params.get("dimension") ?? "global";
  const key = params.get("key") ?? "";
  if (dimension === "global" && key) throw badRequest("dimension=global 时不能传 key");
  if (dimension !== "global" && !key) throw badRequest(`dimension=${dimension} 时必须传 key`);
  if (key.length > 160 || (key && !/^[A-Za-z0-9_.:/@-]{1,160}$/.test(key)))
    throw badRequest("key 必须为安全标识符（≤160 字符）");
  const granularity: "hour" | "day" =
    granularityParam === "hour"
      ? "hour"
      : granularityParam === "day"
        ? "day"
        : days === 1
          ? "hour"
          : "day";
  if (granularity === "hour" && days > 90) throw badRequest("小时粒度最多 90 天");
  const { buckets, step, end, count } = seriesSeed(days, granularity, dimension, key);
  const series = buckets.map((b, i) => {
    const bucket = end - (count - 1 - i) * step;
    return {
      bucket,
      date: new Date(bucket * 1000)
        .toISOString()
        .slice(0, granularity === "hour" ? 16 : 10)
        .replace("T", " "),
      requests: b.requests,
      success: b.success,
      error: b.error,
      cancelled: b.cancelled,
      input_tokens: b.input_tokens,
      output_tokens: b.output_tokens,
      total_tokens: b.input_tokens + b.output_tokens,
      credit: b.credit,
      latency_p50_ms: b.p50,
      latency_p95_ms: b.p95,
      latency_p99_ms: b.p99,
      duration_avg_ms: b.p50 === null ? null : Math.round(b.p50 * 1.35),
      first_token_avg_ms: 240,
      latency_known: b.p50 === null ? 0 : Math.max(5, b.requests),
      tokens_per_s: b.tokens_per_s,
      tokens_per_s_known: b.tokens_per_s === null ? 0 : Math.max(1, b.requests - b.cancelled),
    };
  });
  return {
    generated_at: NOW(),
    range: {
      days,
      start: end - (count - 1) * step,
      end,
      granularity,
      dimension,
      ...(key ? { key } : {}),
      partial: false,
    },
    series,
    summary: summarize(buckets),
    degraded: false,
  };
}

function statsDimensions(params: URLSearchParams): StatsDimensionsResponse {
  const dimension = (params.get("dimension") ?? "") as StatsDimensionsResponse["dimension"];
  if (!["model", "profile", "credential"].includes(dimension)) throw badRequest("dimension 必填");
  const days = Number(params.get("days") ?? 30);
  const accounts = store().accounts;
  const keys =
    dimension === "model"
      ? MODEL_CATALOG.map((model) => ({ key: model, label: null, profile: null }))
      : dimension === "profile"
        ? PROFILES.map((profile) => ({ key: profile, label: null, profile: null }))
        : accounts.map((a) => ({ key: a.id, label: a.name, profile: a.profile }));
  const items = keys
    .map((meta) => {
      const { buckets } = seriesSeed(days, days === 1 ? "hour" : "day", dimension, meta.key);
      return { ...meta, ...summarize(buckets) };
    })
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 200);
  return { generated_at: NOW(), dimension, days, items, degraded: false };
}

// ── alerts / credits fixtures ───────────────────────────────────────────────
class BadRequest extends Error {}
function badRequest(message: string) {
  return new BadRequest(message);
}

function maskUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function channelsResponse(): ChannelsResponse {
  const raw = store().channels;
  const masked: ChannelConfig = {};
  const webhook = raw.webhook as Extract<ChannelConfig["webhook"], object> | undefined;
  if (webhook) {
    const url = String(webhook.url ?? "");
    masked.webhook = {
      enabled: Boolean(webhook.enabled),
      url_masked: url ? maskUrl(url) : undefined,
      has_secret: url ? /[?#]/.test(url) : false,
      headers_template: webhook.headers_template,
    };
  }
  const bark = raw.bark as Extract<ChannelConfig["bark"], object> | undefined;
  if (bark) {
    const key = String(bark.key ?? "");
    masked.bark = {
      enabled: Boolean(bark.enabled),
      server: (bark.server as string) || "https://api.day.app",
      key_masked: key ? key.slice(0, 4) + "****" : undefined,
    };
  }
  const email = raw.email as Extract<ChannelConfig["email"], object> | undefined;
  if (email) {
    masked.email = {
      enabled: Boolean(email.enabled),
      smtp_host: email.smtp_host as string,
      smtp_port: email.smtp_port as number,
      username: email.username as string,
      password_masked: email.password ? "********" : null,
      from: email.from as string,
      to: email.to as string[],
      use_tls: email.use_tls as boolean,
    };
  }
  return {
    generated_at: NOW(),
    alert_enabled: true,
    channels: masked,
    persisted: true,
  };
}

function alertsEvents(params: URLSearchParams): AlertEventsResponse {
  const kinds = (params.get("kind") ?? "").split(",").filter(Boolean);
  const severity = params.get("severity");
  const since = Number(params.get("since") ?? 0);
  const limit = Math.min(200, Math.max(1, Number(params.get("limit") ?? 50)));
  const items = store()
    .events.filter(
      (event) =>
        (!kinds.length || kinds.includes(event.kind)) &&
        (!severity || event.severity === severity) &&
        (!since || event.fired_at >= since),
    )
    .sort((a, b) => b.fired_at - a.fired_at)
    .slice(0, limit);
  return {
    generated_at: NOW(),
    enabled: true,
    items,
    has_more: store().events.length > items.length + limit,
  };
}

function creditsExpiry(params: URLSearchParams): CreditExpiryResponse {
  const days = Math.min(90, Math.max(1, Number(params.get("days") ?? 30)));
  const burnDays = Math.min(30, Math.max(1, Number(params.get("burn_days") ?? 7)));
  const now = NOW();
  const burnOf = (share: number) => Math.round(share * 90 * 10) / 10;
  const segments: Array<{
    account: string;
    name: string;
    profile: string;
    remaining: number;
    total: number;
    expires: number;
    source: string;
    code: string | null;
  }> = [
    {
      account: "cn-mainland-a",
      name: "mainland-a.info",
      profile: "cn-cli",
      remaining: 120,
      total: 500,
      expires: now + 2.1 * DAY,
      source: "旗舰版连续包月",
      code: "p_tcaca_m_x",
    },
    {
      account: "cn-mainland-a",
      name: "mainland-a.info",
      profile: "cn-cli",
      remaining: 400,
      total: 400,
      expires: now + 44 * DAY,
      source: "团队版年付",
      code: "p_team_y",
    },
    {
      account: "cn-work-buddy",
      name: "work-buddy.info",
      profile: "cn-work",
      remaining: 260,
      total: 300,
      expires: now + 5.6 * DAY,
      source: "WorkBuddy 月度包",
      code: "p_wb_m",
    },
    {
      account: "intl-cb-pro",
      name: "intl-pro.info",
      profile: "intl-cli",
      remaining: 180,
      total: 200,
      expires: now + 12 * DAY,
      source: "Pro 月订阅",
      code: null,
    },
  ];
  const items = segments
    .filter((segment) => segment.expires - now < days * DAY)
    .reduce(
      (acc, segment) => {
        const existing = acc.find((item) => item.account_id === segment.account);
        const daily = burnOf(store().accounts.find((a) => a.id === segment.account)?.share ?? 0.1);
        const daysRemaining = Math.round(((segment.expires - now) / DAY) * 10) / 10;
        const remaining = existing
          ? existing.remaining_credits! + segment.remaining
          : segment.remaining;
        const projected = daily > 0 ? Math.round((remaining / daily) * 10) / 10 : null;
        if (existing) {
          existing.remaining_credits = remaining;
          existing.segments.push({
            remaining: segment.remaining,
            total: segment.total,
            expires_at: segment.expires,
            source: segment.source,
            package_code: segment.code,
            in_window: true,
          });
          existing.soonest_expiry = Math.min(existing.soonest_expiry!, segment.expires);
          existing.days_remaining = Math.round(((existing.soonest_expiry! - now) / DAY) * 10) / 10;
          existing.projected_exhaustion_days = projected;
          existing.urgent = existing.days_remaining! < 3;
        } else {
          acc.push({
            account_id: segment.account,
            name: segment.name,
            profile: segment.profile,
            remaining_credits: remaining,
            daily_burn: daily,
            soonest_expiry: segment.expires,
            days_remaining: daysRemaining,
            projected_exhaustion_days: projected,
            urgent: daysRemaining < 3,
            segments: [
              {
                remaining: segment.remaining,
                total: segment.total,
                expires_at: segment.expires,
                source: segment.source,
                package_code: segment.code,
                in_window: true,
              },
            ],
          });
        }
        return acc;
      },
      [] as CreditExpiryResponse["items"],
    )
    .sort((a, b) => (a.days_remaining ?? 1e9) - (b.days_remaining ?? 1e9));
  return {
    generated_at: now,
    threshold_days: 3,
    burn_window_days: burnDays,
    summary: {
      expiring_accounts: items.length,
      expiring_credits: items.reduce((sum, item) => sum + (item.remaining_credits ?? 0), 0),
      urgent_accounts: items.filter((item) => item.urgent).length,
      total_credits: 5200,
      daily_burn: burnOf(1),
      daily_burn_known: true,
    },
    items,
  };
}

// ── dispatcher ──────────────────────────────────────────────────────────────
export type MockResult = { status: number; data: unknown };

function pauseCredential(id: string, paused: boolean) {
  const account = store().accounts.find((a) => a.id === id);
  if (account) {
    account.paused = paused;
    account.enabled = !paused;
    account.disabled_reason = paused ? "人工停用" : null;
    account.health = paused ? "disabled" : "ready";
  } else {
    store().extraPaused[id] = paused;
  }
  store().revisions++;
  return { id, field: "paused" as const, paused, enabled: !paused, revision: store().revisions };
}

function testChannel(channel: string): ChannelTestResult {
  const config = store().channels[channel as "webhook" | "bark" | "email"] as
    | { enabled?: boolean }
    | undefined;
  if (!config || !config.enabled) throw badRequest("通道未启用或未配置");
  const start = Date.now();
  const ok = channel !== "email" || Math.random() > 0.4;
  return {
    channel,
    ok,
    attempts: 1,
    duration_ms: Math.round((Date.now() - start + 120 + Math.random() * 500) * 10) / 10,
    error: ok ? null : "smtp connect timeout",
  };
}

/**
 * Serves one contract-shaped response. Throws BadRequest for malformed input
 * (mirrors the documented 400s); unknown paths resolve to a 404 envelope.
 */
export function mockRequest(
  method: string,
  path: string,
  params = new URLSearchParams(),
  body?: unknown,
): MockResult {
  const get = <T>(build: () => T): MockResult => ({ status: 200, data: build() });
  if (path === "/admin/status" && method === "GET") return get(statusResponse);
  if (path === "/admin/diagnostic" && method === "GET") return get(diagnosticResponse);
  if (path === "/admin/stats/summary" && method === "GET")
    return get(() => statsSummary(Number(params.get("days") ?? 7)));
  if (path === "/admin/stats/series" && method === "GET") return get(() => statsSeries(params));
  if (path === "/admin/stats/dimensions" && method === "GET")
    return get(() => statsDimensions(params));
  if (path === "/admin/alerts/events" && method === "GET") return get(() => alertsEvents(params));
  if (path === "/admin/credits/expiry" && method === "GET") return get(() => creditsExpiry(params));
  if (path === "/admin/alerts/channels" && method === "GET") return get(channelsResponse);
  if (path === "/admin/alerts/test" && method === "POST") {
    const channel = params.get("channel");
    if (!channel) throw badRequest("channel 必填");
    return get(() => testChannel(channel));
  }
  if (path === "/admin/alerts/channels" && method === "PUT") {
    const payload = body as { channels?: Record<string, Record<string, unknown>> };
    if (!payload?.channels || typeof payload.channels !== "object")
      throw badRequest("channels 必填");
    store().channels = payload.channels;
    return { status: 200, data: channelsResponse() };
  }
  if (method === "PATCH" && path.startsWith("/admin/credentials/")) {
    const id = path.split("/").at(-1)!;
    const field = body as Record<string, unknown>;
    if (typeof field?.paused === "boolean")
      return get(() => pauseCredential(id, field.paused as boolean));
  }
  if (path === "/healthz" && method === "GET") {
    const status = statusResponse();
    return { status: status.pool.servable ? 200 : 503, data: status };
  }
  return {
    status: 404,
    data: { error: { message: `mock 未实现：${method} ${path}`, type: "admin_error" } },
  };
}

/** Latency simulation so skeleton/transition states are exercised in development. */
export function mockDelay() {
  return latencyMs + Math.random() * 180;
}
