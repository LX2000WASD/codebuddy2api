// Fusion management API contracts — mirrors docs/fusion-api.md (owned by Fusion-B).
// Types live here so the mock fixtures and the live client cannot drift from the
// documented response shapes. New backend fields stay optional (backward compatible).
import type { RecordValue } from "../api";

export type EpochSeconds = number;

/**
 * 4.2 bucket: one time bucket of a stats series. Quantiles and derived rates are
 * nullable per the contract (fewer than 5 samples => null); the index signature
 * keeps metric lookups honest without weakening the known field types.
 */
export type StatBucket = {
  [key: string]: unknown;
  bucket: EpochSeconds;
  date: string;
  requests: number;
  success: number;
  error: number;
  cancelled: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  credit: number;
  duration_avg_ms: number | null;
  first_token_avg_ms: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_p99_ms: number | null;
  latency_known: number;
  tokens_per_s: number | null;
  tokens_per_s_known: number;
};

export type StatsRange = {
  days: number;
  start: EpochSeconds;
  end: EpochSeconds;
  granularity: "hour" | "day";
  partial?: boolean;
};

export type StatsSeriesResponse = {
  generated_at: EpochSeconds;
  range: StatsRange & { dimension: string; key?: string };
  series: StatBucket[];
  summary: StatsSummary;
  degraded: boolean;
};

/** 4.1 summary: window aggregate with latency quantiles and tokens/s. */
export type StatsSummary = {
  requests: number;
  success: number;
  error: number;
  cancelled: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  credit: number;
  duration_avg_ms: number | null;
  first_token_avg_ms: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_p99_ms: number | null;
  latency_known: number;
  tokens_per_s: number | null;
  tokens_per_s_known: number;
};

export type StatsSummaryResponse = {
  generated_at: EpochSeconds;
  range: StatsRange;
  summary: StatsSummary;
  degraded: boolean;
};

/** 4.3 dimension item: one account / model / profile aggregate for the splitter. */
export type DimensionItem = {
  key: string;
  label: string | null;
  profile: string | null;
  requests: number;
  success: number;
  error: number;
  cancelled: number;
  output_tokens: number;
  total_tokens: number;
  credit: number;
  duration_avg_ms: number | null;
  first_token_avg_ms: number | null;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_p99_ms: number | null;
  latency_known: number;
  tokens_per_s: number | null;
  tokens_per_s_known: number;
};

export type StatsDimensionsResponse = {
  generated_at: EpochSeconds;
  dimension: "model" | "profile" | "credential";
  days: number;
  items: DimensionItem[];
  degraded: boolean;
};

/** 2. service status: /admin/status */
export type ServiceStatus = {
  service: string;
  version: string;
  uptime_seconds: number;
  generated_at: EpochSeconds;
  pool: {
    total: number;
    healthy: number;
    cooling: number;
    disabled: number;
    expired: number;
    error: number;
    servable: boolean;
  };
  by_profile: Record<string, { total: number; healthy: number; servable: boolean }>;
  audit: RecordValue;
  cooldown_storage: RecordValue;
  alerts: RecordValue;
};

/** 3. diagnostic aggregation: /admin/diagnostic */
export type DiagnosticAccount = {
  id: string;
  name: string;
  profile: string;
  health: string;
  enabled: boolean;
  paused: boolean;
  disabled_reason: string | null;
  cooldown: {
    fail_until: EpochSeconds;
    remaining_seconds: number;
    reason: string;
  } | null;
  model_cooldowns: { model: string; until: EpochSeconds; remaining_seconds: number }[];
  last_error_code: string | null;
  last_failure_at: EpochSeconds | null;
  sync_error: string | null;
  catalog_ready: boolean;
};

export type ModelLock = {
  profile: string;
  model: string;
  locked_accounts: number;
  account_ids: string[];
  earliest_unlock_at: EpochSeconds | null;
  latest_unlock_at: EpochSeconds | null;
  all_unlock_in_seconds: number | null;
  kind: "rate_limit" | "model_block";
  reason: string;
};

export type DiagnosticResponse = {
  generated_at: EpochSeconds;
  pool: { total: number; healthy: number; servable: boolean };
  accounts: DiagnosticAccount[];
  model_locks: ModelLock[];
  cooldown_storage: RecordValue;
};

/** 5. credential paused toggle: PATCH /admin/credentials/{id} */
export type PausedPatchResponse = {
  id: string;
  field: "paused";
  paused: boolean;
  enabled: boolean;
  revision: number;
};

/** 6.1 alert event history: /admin/alerts/events */
export type AlertEvent = {
  id: string;
  kind: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  account_id: string | null;
  context: RecordValue;
  fired_at: EpochSeconds;
  delivered: { channel: string; ok: boolean; at: EpochSeconds; error: string | null }[];
};

export type AlertEventsResponse = {
  generated_at: EpochSeconds;
  enabled: boolean;
  items: AlertEvent[];
  has_more: boolean;
};

/** 6.3/6.4 alert channels (read shape is masked; write shape carries secrets). */
export type ChannelConfig = {
  webhook?: {
    enabled: boolean;
    url_masked?: string;
    has_secret?: boolean;
    headers_template?: RecordValue;
    url?: string;
  };
  bark?: {
    enabled: boolean;
    server?: string;
    key_masked?: string;
    key?: string;
    sound?: string;
    group?: string;
  };
  email?: {
    enabled: boolean;
    smtp_host?: string;
    smtp_port?: number;
    username?: string;
    password_masked?: string | null;
    password?: string;
    from?: string;
    to?: string[];
    use_tls?: boolean;
  };
};

export type ChannelsResponse = {
  generated_at: EpochSeconds;
  alert_enabled: boolean;
  channels: ChannelConfig;
  persisted: boolean;
};

/** 6.5 channel test: POST /admin/alerts/test?channel=... */
export type ChannelTestResult = {
  channel: string;
  ok: boolean;
  attempts: number;
  duration_ms: number;
  error: string | null;
};

/** 7. credit expiry reminder: /admin/credits/expiry */
export type CreditSegment = {
  remaining: number;
  total: number;
  expires_at: EpochSeconds;
  source: string;
  package_code: string | null;
  in_window: boolean;
};

export type CreditExpiryItem = {
  account_id: string;
  name: string;
  profile: string;
  remaining_credits: number | null;
  daily_burn: number | null;
  soonest_expiry: EpochSeconds | null;
  days_remaining: number | null;
  projected_exhaustion_days: number | null;
  urgent: boolean;
  segments: CreditSegment[];
};

export type CreditExpiryResponse = {
  generated_at: EpochSeconds;
  threshold_days: number;
  burn_window_days: number;
  summary: {
    expiring_accounts: number;
    expiring_credits: number;
    urgent_accounts: number;
    total_credits: number;
    daily_burn: number | null;
    daily_burn_known: boolean;
  };
  items: CreditExpiryItem[];
};

export const ALERT_KINDS = [
  "balance_exhausted",
  "credits_expiring",
  "token_circuit",
  "catalog_sync_failed",
  "audit_degraded",
  "pool_exhausted",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  balance_exhausted: "余额耗尽",
  credits_expiring: "积分将到期",
  token_circuit: "认证熔断",
  catalog_sync_failed: "目录同步失败",
  audit_degraded: "审计降级",
  pool_exhausted: "全池触底",
};

export const CHANNEL_KINDS = ["webhook", "bark", "email"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
