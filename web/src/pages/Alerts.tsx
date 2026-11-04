import { useEffect, useMemo, useRef, useState } from "react";
import { metric, object } from "../api";
import {
  Badge,
  Button,
  Cluster,
  Drawer,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Field,
  Grid,
  Icon,
  Input,
  Page,
  Panel,
  Skeleton,
  Stack,
  Switch,
  Toolbar,
} from "../ui";
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
import { t, useDateFormat, useT } from "../i18n";
import s from "./system.module.scss";

function normalizeEvents(value: unknown): AlertEventsResponse {
  const data = object(value, t("fusion.alerts.eventsContext"));
  if (!Array.isArray(data.items)) throw new Error(t("fusion.alerts.eventsMissing"));
  return data as AlertEventsResponse;
}
function normalizeChannels(value: unknown): ChannelsResponse {
  const data = object(value, t("fusion.alerts.channelsContext"));
  if (!data.channels || typeof data.channels !== "object")
    throw new Error(t("fusion.alerts.channelsMissing"));
  return data as ChannelsResponse;
}

const severityTone = (severity: string) =>
  severity === "critical" ? "bad" : severity === "warning" ? "warn" : "neutral";
const severityLabel = (severity: string) =>
  severity === "critical"
    ? t("fusion.severity.critical")
    : severity === "warning"
      ? t("fusion.severity.warning")
      : t("fusion.severity.info");

function EventsPanel() {
  const t = useT();
  const format = useDateFormat();
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
        setError(err instanceof Error ? err.message : t("fusion.alerts.eventsLoadFailed"));
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
    <Panel title={t("fusion.alerts.eventsPanel")} hint={t("fusion.alerts.eventsPanelHint")}>
      <Toolbar split gap="2">
        <div role="group" aria-label={t("fusion.alerts.filterKinds")}>
          <Cluster gap="1">
            {ALERT_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={kinds.has(kind)}
                className={s.chip}
                onClick={() =>
                  setKinds((old) => {
                    const next = new Set(old);
                    if (next.has(kind)) next.delete(kind);
                    else next.add(kind);
                    return next;
                  })
                }
              >
                {t(ALERT_KIND_LABELS[kind])}
              </button>
            ))}
          </Cluster>
        </div>
        {/* A native select on purpose: the compact filter in a chip bar keeps its
            platform behaviour, and three suites drive it by value (fireEvent.change /
            Playwright selectOption). ui/Select is the form-field control. */}
        <select
          aria-label={t("fusion.alerts.severityFilter")}
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className={s.filter}
        >
          <option value="">{t("fusion.alerts.allSeverities")}</option>
          <option value="critical">{t("fusion.severity.critical")}</option>
          <option value="warning">{t("fusion.severity.warning")}</option>
          <option value="info">{t("fusion.severity.info")}</option>
        </select>
      </Toolbar>
      {error && (
        <ErrorNotice
          message={error}
          retry={{ label: t("common.retry"), onClick: () => setReloadRevision((v) => v + 1) }}
        />
      )}
      {loading && !items.length ? (
        <Skeleton variant="table" label={t("fusion.alerts.eventsLoading")} />
      ) : items.length ? (
        <>
          <Stack gap="2">
            {items.map((event) => (
              <article key={event.id} className={s.event} data-severity={event.severity}>
                <div className={s.eventHead}>
                  <strong className={s.eventTitle}>{event.title}</strong>
                  <Badge tone={severityTone(event.severity)}>{severityLabel(event.severity)}</Badge>
                </div>
                <small className={s.eventMeta}>
                  {event.kind in ALERT_KIND_LABELS
                    ? t(ALERT_KIND_LABELS[event.kind as AlertKind])
                    : event.kind}{" "}
                  · {format.dateTime(new Date(event.fired_at * 1000))}
                </small>
                <p className={s.eventBody}>{event.detail}</p>
                {event.delivered.length > 0 && (
                  <small className={s.eventMeta}>
                    {t("fusion.alerts.delivery")}
                    {event.delivered
                      .map((d) =>
                        t("fusion.alerts.deliveryEntry", {
                          channel: d.channel,
                          outcome: d.ok
                            ? t("fusion.alerts.deliveryOk")
                            : t("fusion.alerts.deliveryFailed"),
                        }),
                      )
                      .join(t("fusion.common.listSeparator"))}
                  </small>
                )}
              </article>
            ))}
          </Stack>
          {hasMore && (
            <div className={s.pagination}>
              <span className={s.eventMeta}>
                {t("fusion.alerts.shownCount", { count: items.length })}
              </span>
              <Button size="sm" disabled={loading} onClick={() => load("older")}>
                {t("fusion.alerts.loadOlder")}
              </Button>
            </div>
          )}
        </>
      ) : (
        <Empty title={t("fusion.alerts.noEvents")}>{t("fusion.alerts.noEventsHint")}</Empty>
      )}
    </Panel>
  );
}

// Brand names stay literal; only the localised channel name goes through t().
const channelLabels: Record<ChannelKind, string> = {
  webhook: "Webhook",
  bark: "Bark",
  email: "fusion.channel.email",
};
const channelLabel = (channel: ChannelKind) => t(channelLabels[channel]);

function ChannelEditor({
  channels,
  onClose,
  onSaved,
}: {
  channels: ChannelsResponse;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
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
    webhook: channels.channels.webhook?.has_secret ? t("fusion.alerts.maskedWebhook") : null,
    bark: channels.channels.bark?.key_masked ? t("fusion.alerts.maskedBark") : null,
    email: channels.channels.email?.password_masked ? t("fusion.alerts.maskedEmail") : null,
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
      if (!url) return t("fusion.alerts.invalidWebhookEmpty");
      if (looksMasked(url)) return t("fusion.alerts.invalidWebhookMasked");
      if (!/^https?:\/\/[^/\s@]+/i.test(url)) return t("fusion.alerts.invalidWebhookScheme");
      if (url.length > 500) return t("fusion.alerts.invalidWebhookTooLong");
    }
    if (form.bark_enabled) {
      const key = form.bark_key.trim();
      if (!key) return t("fusion.alerts.invalidBarkEmpty");
      if (looksMasked(key)) return t("fusion.alerts.invalidBarkMasked");
      if (key.length > 128) return t("fusion.alerts.invalidBarkTooLong");
      const server = form.bark_server.trim();
      if (server && !/^https:\/\//i.test(server)) return t("fusion.alerts.invalidBarkServer");
    }
    if (form.email_enabled) {
      if (!form.email_host.trim()) return t("fusion.alerts.invalidEmailHost");
      const port = Number(form.email_port);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return t("fusion.alerts.invalidEmailPort");
      if (!/^[^@\s]+@[^@\s]+$/.test(form.email_from.trim()))
        return t("fusion.alerts.invalidEmailFrom");
      const recipients = form.email_to
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean);
      if (!recipients.length || recipients.length > 8)
        return t("fusion.alerts.invalidEmailToCount");
      if (recipients.some((address) => !/^[^@\s]+@[^@\s]+$/.test(address)))
        return t("fusion.alerts.invalidEmailToFormat");
      if (looksMasked(form.email_password)) return t("fusion.alerts.invalidEmailPasswordMasked");
    }
    return null;
  };

  const runTest = (channel: ChannelKind) => {
    setBusy(true);
    setError(null);
    setTest(null);
    void fusionMutate("POST", "/admin/alerts/test", undefined, new URLSearchParams({ channel }))
      .then((raw) => {
        const data = object(raw, t("fusion.alerts.testContext"));
        if (typeof data.ok !== "boolean") throw new Error(t("fusion.alerts.testIncomplete"));
        setTest(data as ChannelTestResult);
      })
      .catch((err: unknown) => {
        if (err instanceof FusionAbortError) return;
        setError(err instanceof Error ? err.message : t("fusion.alerts.testFailed"));
      })
      .finally(() => setBusy(false));
  };

  const enable = (field: keyof typeof form, label: string) => (
    <div className={s.switchRow}>
      <span className={s.switchLabel}>{label}</span>
      <Switch
        label={label}
        checked={form[field] === true}
        onChange={(checked) => set(field, checked)}
      />
    </div>
  );

  return (
    <Drawer
      title={t("fusion.alerts.editorTitle")}
      closeLabel={t("common.closeDrawer")}
      onClose={onClose}
      dismissDisabled={busy}
    >
      <p className={s.note}>{t("fusion.alerts.editorNote")}</p>
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
              setError(err instanceof Error ? err.message : t("fusion.alerts.saveFailed"));
            })
            .finally(() => setBusy(false));
        }}
      >
        <Stack gap="4">
          <Panel title="Webhook">
            {enable("webhook_enabled", t("fusion.alerts.enableWebhook"))}
            <Field label={t("fusion.alerts.webhookUrl")}>
              <Input
                type="url"
                value={form.webhook_url}
                onChange={(e) => set("webhook_url", e.target.value)}
                placeholder="https://hook.example.com/path?token=…"
                disabled={!form.webhook_enabled}
                mono
              />
            </Field>
            {maskedHints.webhook && form.webhook_enabled && (
              <small className={s.note}>{maskedHints.webhook}</small>
            )}
          </Panel>
          <Panel title="Bark">
            {enable("bark_enabled", t("fusion.alerts.enableBark"))}
            <Grid min="sm" gap="3">
              <Field label={t("fusion.alerts.barkServer")}>
                <Input
                  value={form.bark_server}
                  onChange={(e) => set("bark_server", e.target.value)}
                  placeholder="https://api.day.app"
                  disabled={!form.bark_enabled}
                />
              </Field>
              <Field label={t("fusion.alerts.barkKey")}>
                <Input
                  value={form.bark_key}
                  onChange={(e) => set("bark_key", e.target.value)}
                  disabled={!form.bark_enabled}
                  mono
                />
              </Field>
            </Grid>
            {maskedHints.bark && form.bark_enabled && (
              <small className={s.note}>{maskedHints.bark}</small>
            )}
          </Panel>
          <Panel title={t("fusion.alerts.emailLegend")}>
            {enable("email_enabled", t("fusion.alerts.enableEmail"))}
            <Grid min="sm" gap="3">
              <Field label={t("fusion.alerts.emailHost")}>
                <Input
                  value={form.email_host}
                  onChange={(e) => set("email_host", e.target.value)}
                  disabled={!form.email_enabled}
                />
              </Field>
              <Field label={t("fusion.alerts.emailPort")}>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.email_port}
                  onChange={(e) => set("email_port", e.target.value)}
                  disabled={!form.email_enabled}
                />
              </Field>
              <Field label={t("fusion.alerts.emailUsername")}>
                <Input
                  value={form.email_username}
                  onChange={(e) => set("email_username", e.target.value)}
                  disabled={!form.email_enabled}
                />
              </Field>
              <Field label={t("fusion.alerts.emailPassword")}>
                <Input
                  type="password"
                  value={form.email_password}
                  onChange={(e) => set("email_password", e.target.value)}
                  disabled={!form.email_enabled}
                  autoComplete="off"
                />
              </Field>
              <Field label={t("fusion.alerts.emailFrom")}>
                <Input
                  type="email"
                  value={form.email_from}
                  onChange={(e) => set("email_from", e.target.value)}
                  disabled={!form.email_enabled}
                />
              </Field>
              <Field label={t("fusion.alerts.emailTo")}>
                <Input
                  value={form.email_to}
                  onChange={(e) => set("email_to", e.target.value)}
                  placeholder="ops@example.com, ops2@example.com"
                  disabled={!form.email_enabled}
                />
              </Field>
            </Grid>
            <div className={s.switchRow}>
              <span className={s.switchLabel}>{t("fusion.alerts.emailTls")}</span>
              <Switch
                label={t("fusion.alerts.emailTls")}
                checked={form.email_tls}
                disabled={!form.email_enabled}
                onChange={(checked) => set("email_tls", checked)}
              />
            </div>
            {maskedHints.email && form.email_enabled && (
              <small className={s.note}>{maskedHints.email}</small>
            )}
          </Panel>
          <Panel title={t("fusion.alerts.testPanel")}>
            <p className={s.note}>{t("fusion.alerts.testNote")}</p>
            <Cluster gap="2">
              {CHANNEL_KINDS.map((channel) => (
                <Button
                  key={channel}
                  size="sm"
                  disabled={busy}
                  onClick={() => runTest(channel)}
                  aria-label={t("fusion.alerts.testChannelAria", {
                    channel: channelLabel(channel),
                  })}
                >
                  {t("fusion.alerts.testChannel", { channel: channelLabel(channel) })}
                </Button>
              ))}
            </Cluster>
            {test && (
              <div className={s.event} data-severity={test.ok ? "info" : "critical"}>
                <div className={s.eventHead}>
                  <strong className={s.eventTitle}>
                    {channelLabel(test.channel as ChannelKind)}
                  </strong>
                  <Badge tone={test.ok ? "good" : "bad"}>
                    {test.ok ? t("fusion.alerts.deliveryOk") : t("fusion.alerts.deliveryFailed")}
                  </Badge>
                </div>
                <small className={s.eventMeta}>
                  {t("fusion.alerts.testResult", {
                    attempts: metric(test.attempts),
                    duration: metric(test.duration_ms),
                  })}
                </small>
                {test.error && <p className={s.eventBody}>{test.error}</p>}
              </div>
            )}
          </Panel>
          <ErrorNotice message={error} />
          <Toolbar gap="2">
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? t("fusion.alerts.saving") : t("fusion.alerts.save")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setError(null);
                setTest(null);
              }}
            >
              {t("fusion.alerts.clearNotice")}
            </Button>
          </Toolbar>
        </Stack>
      </form>
    </Drawer>
  );
}

export function Alerts() {
  const t = useT();
  const channels = useFusionResource("/admin/alerts/channels", null, normalizeChannels);
  const [editing, setEditing] = useState(false);
  const status = channels.data;

  const enabledList = useMemo(
    () => (status ? CHANNEL_KINDS.filter((kind) => status.channels[kind]?.enabled) : []),
    [status],
  );

  return (
    <Page
      title={t("nav.alerts")}
      description={t("fusion.alerts.pageDesc")}
      actions={
        <>
          {FUSION_DEVELOPMENT && <Badge tone="warn">{t("fusion.common.demoData")}</Badge>}
          <Button
            onClick={channels.reload}
            disabled={channels.loading}
            icon={<Icon name="refresh" spin={channels.loading} />}
          >
            {t("fusion.alerts.refreshChannels")}
          </Button>
          <Button variant="primary" icon="bell" disabled={!status} onClick={() => setEditing(true)}>
            {t("fusion.alerts.configureChannels")}
          </Button>
        </>
      }
    >
      <Panel title={t("fusion.alerts.channelsPanel")}>
        {channels.error ? (
          <ErrorNotice
            message={channels.error}
            retry={{ label: t("common.retry"), onClick: channels.reload }}
          />
        ) : channels.loading ? (
          <Skeleton variant="card" label={t("fusion.alerts.channelsLoading")} />
        ) : status ? (
          <Grid min="md" gap="3">
            {CHANNEL_KINDS.map((kind) => {
              const configured = status.channels;
              const enabled = Boolean(configured[kind]?.enabled);
              return (
                <section className={s.card} key={kind}>
                  <div className={s.cardHead}>
                    <strong>{channelLabel(kind)}</strong>
                    <Badge tone={enabled ? "good" : "neutral"}>
                      {enabled ? t("fusion.common.enabled") : t("fusion.common.disabled")}
                    </Badge>
                  </div>
                  {kind === "webhook" && (
                    <small className={s.note}>
                      {configured.webhook?.url_masked ?? t("fusion.alerts.noUrl")}
                    </small>
                  )}
                  {kind === "bark" && (
                    <small className={s.note}>
                      {configured.bark?.server ?? "https://api.day.app"} ·{" "}
                      {configured.bark?.key_masked ?? t("fusion.alerts.noKey")}
                    </small>
                  )}
                  {kind === "email" && (
                    <small className={s.note}>
                      {configured.email?.smtp_host}:{configured.email?.smtp_port} ·{" "}
                      {(configured.email?.to ?? []).join(t("fusion.common.listSeparator")) ||
                        t("fusion.alerts.noRecipients")}
                    </small>
                  )}
                </section>
              );
            })}
          </Grid>
        ) : (
          <Empty title={t("fusion.alerts.channelsUnknown")} />
        )}
        {status && (
          <p className={s.note}>
            {t("fusion.alerts.summary", {
              state: status.alert_enabled
                ? t("fusion.common.enabled")
                : t("fusion.common.disabled"),
              count: enabledList.length,
            })}
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
    </Page>
  );
}
