import { useSyncExternalStore } from "react";

/**
 * Settings metadata layer.
 *
 * The backend ships a flat SCHEMA (app/settings.py) whose order is "the order someone
 * typed the keys in", not a domain order. This file adds the missing presentation layer:
 * group / section / risk / unit / one-line impact / search aliases.
 *
 * Deliberate design rules:
 *  - Every key is optional here. An unknown key falls back to GROUP "other" so a new
 *    backend knob can never break the page (the schema grew from 68 to 69 keys during
 *    the analysis round alone).
 *  - Nothing here changes the PATCH contract. It is pure presentation metadata.
 *  - `retired` hides a key that is stored but has no consumer anywhere in the codebase.
 *    Selling a switch that does nothing is worse than not showing it.
 */

export type GroupKey =
  | "access"
  | "accounts"
  | "request"
  | "limits"
  | "models"
  | "storage"
  | "alerts"
  | "other";

export type Risk = "p0" | "p1" | "p2";
export type Unit = "bytes" | "seconds" | "days";

export type SettingMeta = {
  group: GroupKey;
  section?: string;
  risk: Risk;
  unit?: Unit;
  /** One sentence: what actually changes when you save this. */
  help?: string;
  /** Extra search terms (Chinese + English) beyond key/label/help. */
  aliases?: string[];
  /** Stored and validated, but nothing reads it. Hidden from the UI. */
  retired?: boolean;
};

export const GROUPS: { key: GroupKey; title: string; description: string }[] = [
  {
    key: "access",
    title: "服务与接入",
    description: "网关怎么被访问、从哪里信任来源。改动多需重启进程。",
  },
  {
    key: "accounts",
    title: "账号与调度",
    description: "账号池怎么选号、怎么冷却、怎么保号。",
  },
  {
    key: "request",
    title: "请求与协议",
    description: "请求进来到上行之间做了什么：脱敏、投影、流式与重放。",
  },
  {
    key: "limits",
    title: "并发与超时",
    description: "能同时跑多少、每一步等多久。",
  },
  {
    key: "models",
    title: "模型与计费",
    description: "模型守卫与积分换算口径。守卫开关在模型页，这里只显示状态。",
  },
  {
    key: "storage",
    title: "存储与审计",
    description: "记什么、留多久、占多大。保留期改小会立刻删历史数据。",
  },
  {
    key: "alerts",
    title: "告警",
    description: "什么时候通知你。投递渠道在告警页配置。",
  },
  { key: "other", title: "未分组", description: "后端新增、本页还没有归类的配置项。" },
];

export const RISK_LABEL: Record<Risk, string> = {
  p0: "高风险",
  p1: "影响调度",
  p2: "常规",
};

export const RISK_TONE: Record<Risk, "bad" | "warn" | "neutral"> = {
  p0: "bad",
  p1: "warn",
  p2: "neutral",
};

/** Typed confirmation required before a high-risk batch is written. */
export const CONFIRM_PHRASE = "修改线上配置";

/** Restart command to copy. The deployment form was never verified from the repo. */
export const RESTART_COMMAND = "docker compose restart";
export const RESTART_HINT =
  "这些项已写入配置库但尚未生效：重启进程后才会读取。重启会中断当前在途的请求。";

/**
 * Keys whose value is owned by another page. Rendering an editor here would create two
 * writers for one switch, so the settings page shows the state and links out instead.
 */
export const MANAGED_ELSEWHERE: Record<string, { href: string; label: string }> = {
  model_guard: { href: "/dashboard/models", label: "在模型页管理" },
  model_capability_guard: { href: "/dashboard/models", label: "在模型页管理" },
};

const meta = (
  group: GroupKey,
  risk: Risk,
  help: string,
  extra: Partial<SettingMeta> = {},
): SettingMeta => ({ group, risk, help, ...extra });

export const SETTINGS_META: Record<string, SettingMeta> = {
  // -- 1 服务与接入 -------------------------------------------------------
  host: meta("access", "p1", "网关监听地址；保存后需重启进程才会生效。", {
    section: "监听",
    aliases: ["bind", "监听", "地址"],
  }),
  port: meta("access", "p0", "管理页与推理端点都会换到新端口，重启后旧地址失效。", {
    section: "监听",
    aliases: ["端口", "listen"],
  }),
  api_key: meta("access", "p2", "由启动来源锁定，不能在管理界面修改。", {
    section: "凭证与路径",
    aliases: ["密钥", "key", "token"],
  }),
  auth_file: meta("access", "p2", "显式凭证文件路径，启动来源锁定。", {
    section: "凭证与路径",
    aliases: ["凭证", "凭据", "credential"],
  }),
  auth_dir: meta("access", "p2", "凭证目录，启动来源锁定。", {
    section: "凭证与路径",
    aliases: ["凭证", "凭据", "credential"],
  }),
  import_dir: meta("access", "p2", "导入目录，启动来源锁定。", {
    section: "凭证与路径",
    aliases: ["导入", "import"],
  }),
  admin_allowed_origins: meta(
    "access",
    "p2",
    "额外信任的管理页来源，逗号分隔；留空表示只接受同源。",
    { section: "信任与标识", aliases: ["cors", "跨域", "来源"] },
  ),
  trusted_proxies: meta(
    "access",
    "p0",
    "决定是否采信 X-Forwarded-For。配错会让审计里的来源 IP 失真或被伪造。",
    { section: "信任与标识", aliases: ["代理", "proxy", "xff", "ip"] },
  ),
  health_service_name: meta("access", "p2", "写进 /healthz 与告警头，只影响标识展示。", {
    section: "信任与标识",
    aliases: ["健康检查", "health"],
  }),
  skip_check: meta("access", "p2", "跳过启动预检，会少一次启动期的凭证可用性自检。", {
    section: "信任与标识",
    aliases: ["预检", "check"],
  }),

  // -- 2 账号与调度 -------------------------------------------------------
  model_soft_cooldown: meta("accounts", "p1", "按 账号×模型 隔离 429，命中后只冷却这一组合。", {
    section: "冷却与熔断",
    aliases: ["冷却", "cooldown", "429"],
  }),
  model_cooldown_s: meta("accounts", "p1", "上游 429 没给重置时间时，该模型冷却多久。", {
    section: "冷却与熔断",
    unit: "seconds",
    aliases: ["冷却", "cooldown"],
  }),
  model_cooldown_max_s: meta("accounts", "p1", "软冷却封顶；上游给的重置时间超过它会被截断。", {
    section: "冷却与熔断",
    unit: "seconds",
    aliases: ["冷却", "cooldown"],
  }),
  model_cooldown_no_stack: meta(
    "accounts",
    "p1",
    "冷却期内重复 429 不再延长冷却，避免一次抖动把账号锁很久。",
    { section: "冷却与熔断", aliases: ["冷却", "cooldown"] },
  ),
  auth_fail_threshold: meta("accounts", "p1", "连续 401/403 达到该次数即禁用账号。", {
    section: "冷却与熔断",
    aliases: ["熔断", "401", "403", "认证失败"],
  }),
  auth_disable_seconds: meta("accounts", "p1", "达到认证失败阈值后禁用多久。", {
    section: "冷却与熔断",
    unit: "seconds",
    aliases: ["熔断", "禁用"],
  }),
  transport_fail_threshold: meta(
    "accounts",
    "p1",
    "连接失败 / 写超时 / 首字节超时连续达到该次数即临时出池。",
    { section: "冷却与熔断", aliases: ["传输", "transport", "出池"] },
  ),
  transport_penalty_seconds: meta("accounts", "p1", "传输连败出池多久后自动回池。", {
    section: "冷却与熔断",
    unit: "seconds",
    aliases: ["传输", "transport", "出池"],
  }),
  account_pause: meta("accounts", "p1", "暂停的账号只退出选号，签到 / 旅行 / 保号任务照常执行。", {
    section: "账号调度",
    aliases: ["暂停", "pause"],
  }),
  maintenance_account_gap_s: meta("accounts", "p2", "保号任务在账号之间休眠，避免请求过密。", {
    section: "账号调度",
    unit: "seconds",
    aliases: ["保号", "维护", "maintenance"],
  }),
  credit_floor: meta("accounts", "p1", "低于保底余额的账号不再派发收费模型；0 表示关闭。", {
    section: "账号调度",
    aliases: ["积分", "余额", "保底", "credit"],
  }),
  credit_floor_cost_alpha: meta("accounts", "p2", "扣费台账 EMA 平滑系数，越小越保守。", {
    section: "账号调度",
    aliases: ["积分", "扣费", "ema"],
  }),
  credit_floor_cost_ttl_s: meta("accounts", "p2", "扣费观测多久失效，避免跨时段用旧数据判断。", {
    section: "账号调度",
    unit: "seconds",
    aliases: ["积分", "扣费"],
  }),
  expiring_credit_window_s: meta("accounts", "p2", "快过期积分判定窗口；0 表示不做加权。", {
    section: "账号调度",
    unit: "seconds",
    aliases: ["积分", "过期", "expiring"],
  }),
  expiring_credit_weight: meta("accounts", "p1", "窗口内快过期账号的选号权重倍数。", {
    section: "账号调度",
    aliases: ["积分", "权重", "weight"],
  }),
  cred_cooldown: meta("accounts", "p2", "运行时快照，随熔断状态变化，不可修改。", {
    section: "运行时快照",
    unit: "seconds",
    aliases: ["熔断", "运行时"],
  }),
  model_cooldown: meta("accounts", "p2", "运行时快照，模型冷却兜底秒数。", {
    section: "运行时快照",
    unit: "seconds",
    aliases: ["冷却", "运行时"],
  }),
  model_cooldown_max: meta("accounts", "p2", "运行时快照，模型冷却最大秒数。", {
    section: "运行时快照",
    unit: "seconds",
    aliases: ["冷却", "运行时"],
  }),
  sticky_ttl: meta("accounts", "p2", "运行时快照，黏绑空闲期限。", {
    section: "运行时快照",
    unit: "seconds",
    aliases: ["黏绑", "sticky", "运行时"],
  }),
  auto_accept_buddy: meta("accounts", "p2", "启动期读取的开关，运行期无法修改。", {
    section: "运行时快照",
    aliases: ["领猫", "buddy", "启动"],
  }),

  // -- 3 请求与协议 -------------------------------------------------------
  desensitize: meta("request", "p0", "关闭后原始提示词原样上行到上游，隐私面发生变化。", {
    section: "内容处理",
    aliases: ["脱敏", "隐私", "desensitize", "prompt"],
  }),
  identity_normalize: meta("request", "p2", "只改写客户端身份句前缀，其余提示词保持不变。", {
    section: "内容处理",
    aliases: ["身份", "identity", "11128", "渠道"],
  }),
  no_compact: meta("request", "p0", "开启后保留提示词全文，token 与费用上升。", {
    section: "内容处理",
    aliases: ["压缩", "compact", "token", "费用"],
  }),
  keep_tool_metadata: meta("request", "p2", "保留工具描述原文；关闭时按脱敏规则精简。", {
    section: "内容处理",
    aliases: ["工具", "tool"],
  }),
  max_images: meta("request", "p2", "单个请求携带的图片上限，超出部分按策略处理。", {
    section: "内容处理",
    aliases: ["图片", "image"],
  }),
  image_policy: meta("request", "p0", "truncate=超限截断，error=超限直接报错。", {
    section: "内容处理",
    aliases: ["图片", "image"],
  }),
  max_request_bytes: meta("request", "p0", "请求体字节上限；调小会让大请求直接 4xx。", {
    section: "内容处理",
    unit: "bytes",
    aliases: ["请求体", "大小", "bytes"],
  }),
  stream_tools: meta("request", "p2", "带 tools 的请求也逐字节流式返回。", {
    section: "流式与投影",
    aliases: ["流式", "stream", "tools"],
  }),
  coalesce_reasoning: meta("request", "p2", "思考链合并成单块；关闭则逐帧实时流式。", {
    section: "流式与投影",
    aliases: ["思考", "reasoning", "流式"],
  }),
  thinking_pin_models: meta(
    "request",
    "p2",
    "命中这些模型子串时注入思考开关，逗号分隔；留空关闭。",
    { section: "流式与投影", aliases: ["思考", "thinking", "模型"] },
  ),
  request_context_mode: meta(
    "request",
    "p0",
    "改变请求上下文的注入方式，客户端兼容性可能受影响。",
    {
      section: "流式与投影",
      aliases: ["上下文", "context"],
    },
  ),
  responses_projection_mode: meta("request", "p0", "Responses 投影模式，改变上行 wire 结构。", {
    section: "流式与投影",
    aliases: ["投影", "responses"],
  }),
  responses_projection_max_bytes: meta("request", "p2", "Responses 单项字节上限；0 或 ≥256。", {
    section: "流式与投影",
    unit: "bytes",
    aliases: ["投影", "responses", "bytes"],
  }),
  stream_mode: meta("request", "p0", "realtime 不重生成工具参数，会改变线上流式行为。", {
    section: "流式与投影",
    aliases: ["流式", "stream"],
  }),
  prompt_cache_key_enabled: meta(
    "request",
    "p0",
    "关闭后不再自动生成前缀缓存 key，前缀缓存失效、费用上升。",
    { section: "重试与费用", aliases: ["缓存", "cache", "费用"] },
  ),
  failover_max: meta("request", "p0", "换凭证重放次数；调大会增加重复计费风险。", {
    section: "重试与费用",
    aliases: ["重放", "重试", "failover"],
  }),
  retry_write_timeout: meta(
    "request",
    "p0",
    "写超时也参与换号重放。此时请求体尚未被上游处理，重复计费风险较低。",
    { section: "重试与费用", aliases: ["重放", "超时", "retry"] },
  ),

  // -- 4 并发与超时 -------------------------------------------------------
  max_concurrent: meta(
    "limits",
    "p0",
    "0=不限制。进程内计数，多 worker 时实际并发 = worker×本值；超限直接 503。",
    { section: "并发", aliases: ["并发", "concurrency", "inflight", "限流"] },
  ),
  max_inflight_per_account: meta("limits", "p1", "单个账号同时在途的上限；0 不限制。", {
    section: "并发",
    aliases: ["并发", "账号", "inflight"],
  }),
  read_timeout: meta("limits", "p1", "上游流式读取的总超时。", {
    section: "超时",
    unit: "seconds",
    aliases: ["超时", "timeout", "读取"],
  }),
  ttfb_timeout: meta(
    "limits",
    "p1",
    "上游首字节超时；0 关闭。默认 30s 给 Cloudflare 120s 代理窗口留缓冲。",
    { section: "超时", unit: "seconds", aliases: ["超时", "首字节", "ttfb"] },
  ),
  stream_idle_timeout: meta("limits", "p1", "流中两帧之间的最大间隔；0 关闭。", {
    section: "超时",
    unit: "seconds",
    aliases: ["超时", "空闲", "idle"],
  }),
  write_timeout: meta("limits", "p1", "写请求体超时，写不进即放弃本次尝试。", {
    section: "超时",
    unit: "seconds",
    aliases: ["超时", "写入", "write"],
  }),
  upstream_keepalive: meta(
    "limits",
    "p2",
    "上游连接复用。每个上游请求都会读该开关决定是否复用连接池，所以重启后立即生效。",
    { section: "连接", aliases: ["连接", "keepalive", "复用"] },
  ),

  // -- 5 模型与计费 -------------------------------------------------------
  model_guard: meta("models", "p0", "表外模型拦截。改这里会同时影响所有模型的选路。", {
    section: "守卫",
    aliases: ["守卫", "拦截", "guard", "模型"],
  }),
  model_capability_guard: meta(
    "models",
    "p0",
    "仅关闭新增能力预检；元数据展示、国际图片归并及其他安全限制不变。",
    { section: "守卫", aliases: ["守卫", "能力", "guard", "capability"] },
  ),
  model_catalog_ttl: meta("models", "p2", "模型目录缓存秒数；改小会更频繁回源拉目录。", {
    section: "守卫",
    unit: "seconds",
    aliases: ["目录", "缓存", "catalog"],
  }),
  credit_price_cny: meta("models", "p2", "只影响积分换算与估算展示，不改变上游实际扣费。", {
    section: "积分与汇率",
    aliases: ["积分", "单价", "人民币", "cny"],
  }),
  credit_price_usd: meta("models", "p2", "只影响积分换算与估算展示，不改变上游实际扣费。", {
    section: "积分与汇率",
    aliases: ["积分", "单价", "美元", "usd"],
  }),
  usd_rate: meta("models", "p2", "美元兑人民币折算率，仅用于估算展示。", {
    section: "积分与汇率",
    aliases: ["汇率", "美元", "rate"],
  }),

  // -- 6 存储与审计 -------------------------------------------------------
  audit_max_bytes: meta("storage", "p2", "审计明细预算；超出后按最早的数据修剪。", {
    section: "审计明细",
    unit: "bytes",
    aliases: ["审计", "预算", "磁盘", "bytes"],
  }),
  audit_retention_days: meta(
    "storage",
    "p0",
    "保留天数。改小会立刻按新窗口删除早于该天数的历史审计明细，且不可恢复。",
    { section: "审计明细", unit: "days", aliases: ["审计", "保留", "过期", "删除"] },
  ),
  audit_diagnostic_bytes: meta("storage", "p2", "失败诊断保留的最大字节数。", {
    section: "审计明细",
    unit: "bytes",
    aliases: ["诊断", "diagnostic", "bytes"],
  }),

  // -- 7 告警 -------------------------------------------------------------
  alert_enabled: meta("alerts", "p2", "总开关；关闭后所有告警评估与投递停止。", {
    section: "通知",
    aliases: ["告警", "alert", "通知"],
  }),
  alert_credits_expiry_days: meta("alerts", "p2", "积分将在多少天内到期时提醒。", {
    section: "通知",
    unit: "days",
    aliases: ["积分", "到期", "提醒"],
  }),
  // No consumer anywhere in app/ or web/: stored, validated, and read by nothing.
  alert_credits_burn_days: {
    group: "alerts",
    section: "通知",
    risk: "p2",
    unit: "days",
    retired: true,
    help: "死开关：全仓无消费者，改动不会影响任何行为。",
    aliases: ["积分", "燃烧", "burn"],
  },
  alert_throttle_seconds: meta("alerts", "p2", "同一事件在该窗口内只投递一次。", {
    section: "通知",
    unit: "seconds",
    aliases: ["去重", "节流", "throttle"],
  }),
  alert_history_limit: meta("alerts", "p2", "告警事件最多保留多少条。", {
    section: "通知",
    aliases: ["历史", "history"],
  }),
  alert_evaluator_interval_seconds: meta("alerts", "p2", "周期评估间隔；0 关闭周期评估。", {
    section: "通知",
    unit: "seconds",
    aliases: ["评估", "周期", "interval"],
  }),
  alert_timeout_seconds: meta("alerts", "p2", "单次投递超时。", {
    section: "通知",
    unit: "seconds",
    aliases: ["超时", "投递"],
  }),
  alert_retry_count: meta("alerts", "p2", "投递失败重试次数。", {
    section: "通知",
    aliases: ["重试", "retry"],
  }),
  // Reserved key: the aggregation path hardcodes 200ms; the value is never read.
  stats_tokens_rate_ttfb_ms: {
    group: "alerts",
    section: "通知",
    risk: "p2",
    retired: true,
    help: "死开关：预留键，聚合路径固定按 200ms 扣除 TTFB，改动不会生效。",
    aliases: ["ttfb", "速率"],
  },
};

export function metaFor(key: string): SettingMeta {
  return SETTINGS_META[key] ?? { group: "other", risk: "p2" };
}

export function isRetired(key: string): boolean {
  return SETTINGS_META[key]?.retired === true;
}

/** Human-readable value for values that are unreadable as raw numbers. */
export function humanValue(unit: Unit | undefined, value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (unit === "bytes") {
    if (value <= 0) return null;
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let size = value;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${index === 0 ? size : Number(size.toFixed(size >= 100 ? 0 : 1))} ${units[index]}`;
  }
  if (unit === "seconds") {
    if (value <= 0) return null;
    if (value >= 86400 && value % 86400 === 0) return `${value / 86400} 天`;
    if (value >= 3600 && value % 3600 === 0) return `${value / 3600} 小时`;
    if (value >= 60 && value % 60 === 0) return `${value / 60} 分钟`;
    if (value < 1) return `${value} 秒`;
    return null;
  }
  if (unit === "days") {
    if (value <= 0) return null;
    return `${value} 天`;
  }
  return null;
}

/** A restart-mode key that has been saved but is not live yet. */
export function pendingRestart(
  items: { key: string; mode: string; value: unknown; stored: unknown }[],
): string[] {
  return items
    .filter((item) => item.mode !== "hot" && item.stored !== null && item.stored !== item.value)
    .map((item) => item.key);
}

/**
 * Cross-page "a restart is pending" signal.
 *
 * Derived state only: a restart-mode key whose stored value differs from the live one.
 * The settings page publishes the derived set; the sidebar renders a dot from it.
 * No extra request — the page that already owns the schema snapshot publishes it.
 */
let pendingKeys: string[] = [];
const pendingListeners = new Set<() => void>();

function subscribePending(listener: () => void) {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

function readPending() {
  return pendingKeys;
}

/** Called by the settings page whenever the derived set changes. */
export function publishPendingRestart(keys: string[]) {
  if (keys.length === pendingKeys.length && keys.every((key, i) => key === pendingKeys[i])) return;
  pendingKeys = keys;
  for (const listener of pendingListeners) listener();
}

/** Keys saved but not live yet. A sidebar renders a dot when this is non-empty. */
export function usePendingRestart(): string[] {
  return useSyncExternalStore(subscribePending, readPending, readPending);
}
