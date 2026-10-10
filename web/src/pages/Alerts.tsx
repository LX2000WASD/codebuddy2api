import { useEffect, useMemo, useRef, useState } from "react";
import { metric, object } from "../api";
import { Badge, Empty, ErrorNotice, Icon, PageTitle, Panel, Skeleton } from "../components";
import { Drawer, DrawerPresence } from "../components";
import {
  fusionGet,
  fusionMutate,
  FUSION_DEVELOPMENT,
  FusionAbortError,
  useFusionResource,
} from "../fusion/client";
import {
  ALERT_KINDS,
  ALERT_KIND_LABELS,
  CHANNEL_KINDS,
  type AlertEventsResponse,
  type AlertKind,
  type ChannelKind,
  type ChannelsResponse,
  type ChannelTestResult,
} from "../fusion/types";
import s from "../ui.module.scss";

function normalizeEvents(value: unknown): AlertEventsResponse {
  const data = object(value, "告警事件");
  if (!Array.isArray(data.items)) throw new Error("告警事件列表缺失");
  return data as AlertEventsResponse;
}
function normalizeChannels(value: unknown): ChannelsResponse {
  const data = object(value, "告警通道");
  if (!data.channels || typeof data.channels !== "object") throw new Error("告警通道缺失");
  return data as ChannelsResponse;
}

const severityTone = (severity: string) =>
  severity === "critical" ? "bad" : severity === "warning" ? "warn" : "neutral";
const severityLabel = (severity: string) =>
  severity === "critical" ? "严重" : severity === "warning" ? "警告" : "信息";

function EventsPanel() {
  const [kinds, setKinds] = useState<Set<AlertKind>>(() => new Set());
  const [severity, setSeverity] = useState("");
  const [items, setItems] = useState<AlertEventsResponse["items"]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);

  const params = new URLSearchParams({ limit: "50" });
  const selected = ALERT_KINDS.filter((kind) => kinds.has(kind));
  if (selected.length) params.set("kind", selected.join(","));
  if (severity) params.set("severity", severity);

  const controllerRef = useRef<AbortController | null>(null);
  const load = (mode: "replace" | "older") => {
    controllerRef.current?.abort();
    const query = new URLSearchParams(params);
    if (mode === "older" && items.at(-1)?.fired_at)
      query.set("since", String(Math.floor(items.at(-1)!.fired_at) - 1));
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    fusionGet("/admin/alerts/events", query, { signal: controller.signal })
      .then((raw) => {
        const data = normalizeEvents(raw);
        setItems((old) => (mode === "older" ? [...old, ...data.items] : data.items));
        setHasMore(data.has_more);
      })
      .catch((err: unknown) => {
        if (err instanceof FusionAbortError) return;
        setError(err instanceof Error ? err.message : "告警事件加载失败");
      })
      .finally(() => setLoading(false));
    return controller;
  };

  // Fetch on mount, on filter change, and on manual refresh; superseded requests
  // are aborted so flipping filters never applies a stale page.
  useEffect(() => {
    const controller = load("replace");
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.toString(), reloadRevision]);

  return (
    <Panel title="告警事件流" hint="按触发时间倒序">
      <div className={s.filterChips} role="group" aria-label="事件类型筛选">
        {ALERT_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={kinds.has(kind)}
            className={kinds.has(kind) ? s.chipOn : s.chip}
            onClick={() =>
              setKinds((old) => {
                const next = new Set(old);
                if (next.has(kind)) next.delete(kind);
                else next.add(kind);
                return next;
              })
            }
          >
            {ALERT_KIND_LABELS[kind]}
          </button>
        ))}
        <select
          aria-label="事件级别"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className={s.severitySelect}
        >
          <option value="">全部级别</option>
          <option value="critical">严重</option>
          <option value="warning">警告</option>
          <option value="info">信息</option>
        </select>
      </div>
      {error && <ErrorNotice message={error} retry={() => setReloadRevision((v) => v + 1)} />}
      {loading && !items.length ? (
        <Skeleton variant="table" label="事件流加载中" />
      ) : items.length ? (
        <>
          <div className={s.eventList}>
            {items.map((event) => (
              <article key={event.id} className={s.eventItem} data-severity={event.severity}>
                <div className={s.eventHead}>
                  <strong>{event.title}</strong>
                  <Badge tone={severityTone(event.severity)}>{severityLabel(event.severity)}</Badge>
                </div>
                <small>
                  {ALERT_KIND_LABELS[event.kind as AlertKind] ?? event.kind} ·{" "}
                  {new Date(event.fired_at * 1000).toLocaleString("zh-CN")}
                </small>
                <p>{event.detail}</p>
                {event.delivered.length > 0 && (
                  <small>
                    投递：
                    {event.delivered
                      .map((d) => `${d.channel} ${d.ok ? "成功" : "失败"}`)
                      .join("、")}
                  </small>
                )}
              </article>
            ))}
          </div>
          {hasMore && (
            <div className={s.pagination}>
              <span>共显示 {items.length} 条</span>
              <button disabled={loading} onClick={() => load("older")}>
                加载更早的事件
              </button>
            </div>
          )}
        </>
      ) : (
        <Empty title="暂无告警事件">
          触发条件（余额耗尽、积分将到期、认证熔断等）满足时自动记录。
        </Empty>
      )}
    </Panel>
  );
}

const channelLabels: Record<ChannelKind, string> = {
  webhook: "Webhook",
  bark: "Bark",
  email: "邮件",
};

function ChannelEditor({
  channels,
  onClose,
  onSaved,
}: {
  channels: ChannelsResponse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(() => ({
    webhook_enabled: Boolean(channels.channels.webhook?.enabled),
    webhook_url: String(channels.channels.webhook?.url_masked ?? ""),
    bark_enabled: Boolean(channels.channels.bark?.enabled),
    bark_server: String(channels.channels.bark?.server ?? ""),
    bark_key: String(channels.channels.bark?.key_masked ?? ""),
    email_enabled: Boolean(channels.channels.email?.enabled),
    email_host: String(channels.channels.email?.smtp_host ?? ""),
    email_port: String(channels.channels.email?.smtp_port ?? 465),
    email_username: String(channels.channels.email?.username ?? ""),
    email_password: String(channels.channels.email?.password_masked ?? ""),
    email_from: String(channels.channels.email?.from ?? ""),
    email_to: String((channels.channels.email?.to ?? []).join(",")),
    email_tls: Boolean(channels.channels.email?.use_tls),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<ChannelTestResult | null>(null);
  const maskedHints: Record<ChannelKind, string | null> = {
    webhook: channels.channels.webhook?.has_secret ? "原地址包含密钥信息，需重新完整输入" : null,
    bark: channels.channels.bark?.key_masked ? "原 Key 已脱敏，需重新完整输入" : null,
    email: channels.channels.email?.password_masked ? "原密码已脱敏，需重新完整输入" : null,
  };
  // The read endpoint never returns secrets; saving a masked value back would drop
  // them, so required secret fields must be re-typed when the channel is enabled.
  const looksMasked = (value: string) => value.includes("****") || value.includes("********");

  const set = (field: keyof typeof form, value: string | boolean) =>
    setForm((old) => ({ ...old, [field]: value }));

  const buildPayload = () => ({
    channels: {
      webhook: {
        enabled: form.webhook_enabled,
        url: form.webhook_enabled ? form.webhook_url.trim() : "",
      },
      bark: {
        enabled: form.bark_enabled,
        server: form.bark_enabled ? form.bark_server.trim() : "",
        key: form.bark_enabled ? form.bark_key.trim() : "",
      },
      email: {
        enabled: form.email_enabled,
        smtp_host: form.email_enabled ? form.email_host.trim() : "",
        smtp_port: Number(form.email_port) || 465,
        username: form.email_enabled ? form.email_username.trim() : "",
        password: form.email_enabled ? form.email_password : "",
        from: form.email_enabled ? form.email_from.trim() : "",
        to: form.email_enabled
          ? form.email_to
              .split(",")
              .map((address) => address.trim())
              .filter(Boolean)
          : [],
        use_tls: form.email_tls,
      },
    },
  });

  const validate = () => {
    if (form.webhook_enabled) {
      const url = form.webhook_url.trim();
      if (!url) return "启用 Webhook 时必须填写完整回调地址";
      if (looksMasked(url)) return "Webhook 地址需重新完整输入（读端点只返回脱敏地址）";
      if (!/^https?:\/\/[^/\s@]+/i.test(url)) return "Webhook 地址必须为 http/https 且包含主机名";
      if (url.length > 500) return "Webhook 地址过长（≤500 字符）";
    }
    if (form.bark_enabled) {
      const key = form.bark_key.trim();
      if (!key) return "启用 Bark 时必须填写完整 Key";
      if (looksMasked(key)) return "Bark Key 需重新完整输入（读端点只返回脱敏 Key）";
      if (key.length > 128) return "Bark Key 过长（≤128 字符）";
      const server = form.bark_server.trim();
      if (server && !/^https:\/\//i.test(server)) return "Bark 服务地址必须为 https";
    }
    if (form.email_enabled) {
      if (!form.email_host.trim()) return "启用邮件时必须填写 SMTP 主机";
      const port = Number(form.email_port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "SMTP 端口须为 1..65535";
      if (!/^[^@\s]+@[^@\s]+$/.test(form.email_from.trim())) return "发件地址格式不正确";
      const recipients = form.email_to
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);
      if (!recipients.length || recipients.length > 8) return "收件地址须为 1..8 个";
      if (recipients.some((address) => !/^[^@\s]+@[^@\s]+$/.test(address)))
        return "收件地址格式不正确";
      if (looksMasked(form.email_password))
        return "SMTP 密码需重新完整输入（读端点只返回脱敏占位）";
    }
    return null;
  };

  const runTest = (channel: ChannelKind) => {
    setBusy(true);
    setError(null);
    setTest(null);
    void fusionMutate("POST", "/admin/alerts/test", undefined, new URLSearchParams({ channel }))
      .then((raw) => {
        const data = object(raw, "通道测试");
        if (typeof data.ok !== "boolean") throw new Error("通道测试结果不完整");
        setTest(data as ChannelTestResult);
      })
      .catch((err: unknown) => {
        if (err instanceof FusionAbortError) return;
        setError(err instanceof Error ? err.message : "通道测试失败");
      })
      .finally(() => setBusy(false));
  };

  return (
    <Drawer title="通知通道配置" onClose={onClose} dismissDisabled={busy}>
      <p className={s.note}>
        读端点只返回脱敏的密钥与地址；启用某通道时，对应密钥字段必须重新完整输入，否则保存会拒绝。
        保存为全量覆盖：未编辑的通道需按原样保留启用状态。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const invalid = validate();
          if (invalid) {
            setError(invalid);
            return;
          }
          setBusy(true);
          setError(null);
          void fusionMutate("PUT", "/admin/alerts/channels", buildPayload())
            .then(() => {
              onSaved();
              onClose();
            })
            .catch((err: unknown) => {
              if (err instanceof FusionAbortError) return;
              setError(err instanceof Error ? err.message : "保存失败");
            })
            .finally(() => setBusy(false));
        }}
      >
        <fieldset className={s.fieldset}>
          <legend>Webhook</legend>
          <label className={s.check}>
            <input
              type="checkbox"
              role="switch"
              checked={form.webhook_enabled}
              onChange={(e) => set("webhook_enabled", e.target.checked)}
            />
            启用 Webhook
          </label>
          <label className={s.field}>
            回调地址（完整 URL）
            <input
              type="url"
              value={form.webhook_url}
              onChange={(e) => set("webhook_url", e.target.value)}
              placeholder="https://hook.example.com/path?token=…"
              disabled={!form.webhook_enabled}
            />
          </label>
          {maskedHints.webhook && form.webhook_enabled && (
            <small className={s.mutedInline}>{maskedHints.webhook}</small>
          )}
        </fieldset>
        <fieldset className={s.fieldset}>
          <legend>Bark</legend>
          <label className={s.check}>
            <input
              type="checkbox"
              role="switch"
              checked={form.bark_enabled}
              onChange={(e) => set("bark_enabled", e.target.checked)}
            />
            启用 Bark
          </label>
          <label className={s.field}>
            服务地址（留空使用默认）
            <input
              value={form.bark_server}
              onChange={(e) => set("bark_server", e.target.value)}
              placeholder="https://api.day.app"
              disabled={!form.bark_enabled}
            />
          </label>
          <label className={s.field}>
            Key
            <input
              value={form.bark_key}
              onChange={(e) => set("bark_key", e.target.value)}
              disabled={!form.bark_enabled}
            />
          </label>
          {maskedHints.bark && form.bark_enabled && (
            <small className={s.mutedInline}>{maskedHints.bark}</small>
          )}
        </fieldset>
        <fieldset className={s.fieldset}>
          <legend>邮件（SMTP）</legend>
          <label className={s.check}>
            <input
              type="checkbox"
              role="switch"
              checked={form.email_enabled}
              onChange={(e) => set("email_enabled", e.target.checked)}
            />
            启用邮件
          </label>
          <label className={s.field}>
            SMTP 主机
            <input
              value={form.email_host}
              onChange={(e) => set("email_host", e.target.value)}
              disabled={!form.email_enabled}
            />
          </label>
          <label className={s.field}>
            端口
            <input
              type="number"
              min={1}
              max={65535}
              value={form.email_port}
              onChange={(e) => set("email_port", e.target.value)}
              disabled={!form.email_enabled}
            />
          </label>
          <label className={s.field}>
            用户名
            <input
              value={form.email_username}
              onChange={(e) => set("email_username", e.target.value)}
              disabled={!form.email_enabled}
            />
          </label>
          <label className={s.field}>
            密码（中继可留空）
            <input
              type="password"
              value={form.email_password}
              onChange={(e) => set("email_password", e.target.value)}
              disabled={!form.email_enabled}
              autoComplete="off"
            />
          </label>
          <label className={s.field}>
            发件地址
            <input
              type="email"
              value={form.email_from}
              onChange={(e) => set("email_from", e.target.value)}
              disabled={!form.email_enabled}
            />
          </label>
          <label className={s.field}>
            收件地址（逗号分隔，至多 8 个）
            <input
              value={form.email_to}
              onChange={(e) => set("email_to", e.target.value)}
              placeholder="ops@example.com, ops2@example.com"
              disabled={!form.email_enabled}
            />
          </label>
          <label className={s.check}>
            <input
              type="checkbox"
              checked={form.email_tls}
              onChange={(e) => set("email_tls", e.target.checked)}
              disabled={!form.email_enabled}
            />
            使用 TLS
          </label>
          {maskedHints.email && form.email_enabled && (
            <small className={s.mutedInline}>{maskedHints.email}</small>
          )}
        </fieldset>
        <ErrorNotice message={error} />
        <div className={s.actions}>
          <button className={s.primary} disabled={busy}>
            {busy ? "保存中…" : "保存通道配置"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setError(null);
              setTest(null);
            }}
          >
            清空提示
          </button>
        </div>
      </form>
      <Panel title="通道测试">
        <p className={s.note}>测试发送绕过去重并同步返回结果；请先用真实配置保存再测试。</p>
        <div className={s.actions}>
          {CHANNEL_KINDS.map((channel) => (
            <button
              key={channel}
              type="button"
              disabled={busy}
              onClick={() => runTest(channel)}
              aria-label={`测试 ${channelLabels[channel]} 通道`}
            >
              测试 {channelLabels[channel]}
            </button>
          ))}
        </div>
        {test && (
          <div className={s.eventItem} data-severity={test.ok ? "info" : "critical"}>
            <div className={s.eventHead}>
              <strong>{channelLabels[test.channel as ChannelKind] ?? test.channel}</strong>
              <Badge tone={test.ok ? "good" : "bad"}>{test.ok ? "投递成功" : "投递失败"}</Badge>
            </div>
            <small>
              尝试 {metric(test.attempts)} 次 · 耗时 {metric(test.duration_ms)} ms
            </small>
            {test.error && <p>{test.error}</p>}
          </div>
        )}
      </Panel>
    </Drawer>
  );
}

export function Alerts() {
  const channels = useFusionResource("/admin/alerts/channels", null, normalizeChannels);
  const [editing, setEditing] = useState(false);
  const status = channels.data;

  const enabledList = useMemo(
    () => (status ? CHANNEL_KINDS.filter((kind) => status.channels[kind]?.enabled) : []),
    [status],
  );

  return (
    <>
      <PageTitle
        title="告警中心"
        description="余额耗尽、积分将到期、认证熔断等事件的统一出口；开关与阈值在系统设置中热更新。"
        actions={
          <>
            {FUSION_DEVELOPMENT && <Badge tone="warn">本地演示数据</Badge>}
            <button onClick={channels.reload} disabled={channels.loading}>
              <Icon name="refresh" />
              刷新通道
            </button>
            <button className={s.primary} disabled={!status} onClick={() => setEditing(true)}>
              <Icon name="bell" />
              配置通道
            </button>
          </>
        }
      />
      <Panel title="通道总览">
        {channels.error ? (
          <ErrorNotice message={channels.error} retry={channels.reload} />
        ) : channels.loading ? (
          <Skeleton variant="card" label="通道状态加载中" />
        ) : status ? (
          <div className={s.channelGrid}>
            {CHANNEL_KINDS.map((kind) => {
              const channels = status.channels;
              const enabled = Boolean(channels[kind]?.enabled);
              return (
                <section className={s.channelCard} key={kind}>
                  <div>
                    <strong>{channelLabels[kind]}</strong>
                    <Badge tone={enabled ? "good" : "neutral"}>
                      {enabled ? "已启用" : "未启用"}
                    </Badge>
                  </div>
                  {kind === "webhook" && (
                    <small>{channels.webhook?.url_masked ?? "未配置地址"}</small>
                  )}
                  {kind === "bark" && (
                    <small>
                      {channels.bark?.server ?? "https://api.day.app"} ·{" "}
                      {channels.bark?.key_masked ?? "未配置 Key"}
                    </small>
                  )}
                  {kind === "email" && (
                    <small>
                      {channels.email?.smtp_host}:{channels.email?.smtp_port} ·{" "}
                      {(channels.email?.to ?? []).join("、") || "未配置收件人"}
                    </small>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          <Empty title="通道状态未知" />
        )}
        {status && (
          <p className={s.note}>
            告警总开关当前 {status.alert_enabled ? "已启用" : "未启用"}；已启用通道{" "}
            {enabledList.length} 个。 阈值（到期天数、节流窗口、评估周期等）请在系统设置中调整。
          </p>
        )}
      </Panel>
      <EventsPanel />
      <DrawerPresence>
        {editing && status && (
          <ChannelEditor
            channels={status}
            onClose={() => setEditing(false)}
            onSaved={() => channels.reload()}
          />
        )}
      </DrawerPresence>
    </>
  );
}
