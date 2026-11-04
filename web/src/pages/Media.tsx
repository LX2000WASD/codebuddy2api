import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  api,
  errorMessage,
  list,
  number,
  object,
  text,
  useResource,
  type RecordValue,
} from "../api";
import { useT } from "../i18n";
import { notify } from "../toast";
import {
  Badge,
  Button,
  Cluster,
  Drawer,
  Empty,
  ErrorNotice,
  Field,
  Grid,
  Icon,
  Input,
  Page,
  ResourceState,
  Select,
  Stat,
  Table,
  Toolbar,
  type TableColumn,
} from "../ui";
import { bytes, Fields } from "../values";
import s from "./Media.module.scss";

const TTL_PRESETS = [24, 72, 168, 720];

/** Client-side mirror of the gateway's media_public_base_url validator. */
export function validateMediaBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname)
      return "media.settings.baseUrlInvalid";
    if (parsed.username || parsed.password || parsed.search || parsed.hash)
      return "media.settings.baseUrlInvalid";
    return null;
  } catch {
    return "media.settings.baseUrlInvalid";
  }
}

export type MediaSummary = {
  configured: boolean;
  base_url: string;
  locked: boolean;
  available: boolean;
  limit_bytes: number;
  ttl_hours: number;
  usage: {
    total_bytes: number;
    images: { count: number; bytes: number };
    videos: { count: number; bytes: number };
  };
  tasks: { active: number; failed: number };
};

export function normalizeMediaSummary(value: unknown): MediaSummary {
  const data = object(value, "媒体概览");
  const group = (raw: unknown) => ({
    count: number((raw as RecordValue)?.count) ?? 0,
    bytes: number((raw as RecordValue)?.bytes) ?? 0,
  });
  return {
    configured: data.configured === true,
    base_url: typeof data.base_url === "string" ? data.base_url : "",
    locked: data.locked === true,
    available: data.available !== false,
    limit_bytes: number(data.limit_bytes) ?? 0,
    ttl_hours: number(data.ttl_hours) ?? 72,
    usage: {
      total_bytes: number((data.usage as RecordValue)?.total_bytes) ?? 0,
      images: group((data.usage as RecordValue)?.images),
      videos: group((data.usage as RecordValue)?.videos),
    },
    tasks: {
      active: number((data.tasks as RecordValue)?.active) ?? 0,
      failed: number((data.tasks as RecordValue)?.failed) ?? 0,
    },
  };
}

/** Remaining retention as a short label; under six hours it turns warning-coloured. */
export function remainingLabel(
  expires: unknown,
  t: (key: string, vars?: Record<string, string | number>) => string,
  now = Date.now(),
): { text: string; warn: boolean } {
  const end = number(expires);
  if (end === null) return { text: "—", warn: false };
  const seconds = Math.max(0, end - now / 1000);
  const hours = seconds / 3600;
  if (hours >= 48)
    return { text: t("media.remaining.days", { count: Math.round(hours / 24) }), warn: false };
  if (hours >= 1)
    return { text: t("media.remaining.hours", { count: hours.toFixed(1) }), warn: hours < 6 };
  return {
    text: t("media.remaining.minutes", { count: Math.max(1, Math.round(seconds / 60)) }),
    warn: true,
  };
}

export function taskStatusTone(status: unknown): "good" | "bad" | "neutral" {
  if (status === "completed") return "good";
  if (status === "failed") return "bad";
  return "neutral";
}

function pageNormalize(value: unknown) {
  const data = object(value, "媒体列表");
  if (typeof data.has_more !== "boolean" || (data.has_more && typeof data.next_cursor !== "string"))
    throw new Error("媒体列表分页响应不完整");
  return {
    items: list(data.items),
    next_cursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    has_more: data.has_more,
  };
}

/** An id that never fits its column: shortened, with the full value in the tooltip. */
function shortId(value: string, limit = 18): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function taskTime(value: unknown): string {
  return typeof value === "number" ? new Date(value * 1000).toLocaleString("zh-CN") : text(value);
}

function AssetPreview({
  item,
  configured,
  onClose,
  onDeleted,
}: {
  item: RecordValue;
  configured: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const assetId = text(item.id);
  const content = `/admin/media/assets/${encodeURIComponent(assetId)}/content`;
  const isVideo = item.kind === "video";
  const link = typeof item.public_url === "string" ? item.public_url : "";
  const remove = () => {
    setBusy(true);
    setError(null);
    void api
      .delete(`/media/assets/${encodeURIComponent(assetId)}`)
      .then(() => {
        onDeleted();
        onClose();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  if (confirming) {
    return (
      <Drawer
        title={t("media.deleteConfirm")}
        closeLabel={t("common.closeDrawer")}
        onClose={() => setConfirming(false)}
        dismissDisabled={busy}
      >
        <ErrorNotice message={error} />
        <p className={s.note}>{t("media.deleteHint")}</p>
        <p className={s.mono}>{assetId}</p>
        <Cluster gap="2">
          <Button disabled={busy} onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={busy} onClick={remove}>
            {busy ? t("media.deleting") : t("media.deleteConfirm")}
          </Button>
        </Cluster>
      </Drawer>
    );
  }
  return (
    <Drawer
      title={t("media.preview")}
      closeLabel={t("common.closeDrawer")}
      onClose={onClose}
      dismissDisabled={busy}
    >
      <ErrorNotice message={error} />
      <div className={s.preview}>
        {isVideo ? (
          <video className={s.previewMedia} controls preload="metadata" src={content}>
            <track kind="captions" />
          </video>
        ) : (
          <img
            className={s.previewMedia}
            src={content}
            alt={text(item.model) || assetId}
            decoding="async"
          />
        )}
      </div>
      <Fields
        data={{
          id: assetId,
          kind: item.kind,
          mime: item.mime,
          size: bytes(number(item.size) ?? 0),
          sha256: typeof item.sha256 === "string" ? item.sha256.slice(0, 12) : item.sha256,
          model: item.model,
          created_at: number(item.created_at),
          expires_at: number(item.expires_at),
        }}
      />
      <Cluster gap="2">
        {configured && link && (
          <Button
            onClick={() => {
              void navigator.clipboard
                .writeText(link)
                .then(() =>
                  notify({ key: `media-copy-${assetId}`, tone: "good", title: t("media.copied") }),
                )
                .catch(() => setError(t("media.copyFailed")));
            }}
          >
            {t("media.copyLink")}
          </Button>
        )}
        <a className={s.linkButton} href={`${content}?download=1`} download>
          {t("media.download")}
        </a>
        <Button
          variant="danger"
          onClick={() => {
            setError(null);
            setConfirming(true);
          }}
        >
          {t("media.delete")}
        </Button>
      </Cluster>
      {!configured && <p className={s.note}>{t("media.noLinkNote")}</p>}
    </Drawer>
  );
}

function MediaSettingsDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [form, setForm] = useState<{
    revision: number;
    base: string;
    limit: number;
    ttl: number;
    locked: Set<string>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api
      .get<unknown>("/settings")
      .then((response) => {
        if (cancelled) return;
        const data = object(response.data, "设置");
        const items = list(data.items);
        const find = (key: string) => items.find((item) => item.key === key);
        setForm({
          revision: number(data.revision) ?? 0,
          base: text(find("media_public_base_url")?.value ?? ""),
          limit: number(find("media_max_total_mb")?.value) ?? 1024,
          ttl: number(find("media_ttl_hours")?.value) ?? 72,
          locked: new Set(
            items
              .filter((item) => item.locked === true && typeof item.key === "string")
              .map((item) => text(item.key)),
          ),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const invalid = form ? validateMediaBaseUrl(form.base) : null;
  const presets =
    form && !TTL_PRESETS.includes(form.ttl)
      ? [...TTL_PRESETS, form.ttl].sort((a, b) => a - b)
      : TTL_PRESETS;
  const save = () => {
    if (!form || invalid) return;
    const values: Record<string, unknown> = {};
    if (!form.locked.has("media_public_base_url"))
      values.media_public_base_url = form.base.trim().replace(/\/+$/, "");
    if (!form.locked.has("media_max_total_mb")) values.media_max_total_mb = form.limit;
    if (!form.locked.has("media_ttl_hours")) values.media_ttl_hours = form.ttl;
    setBusy(true);
    setError(null);
    void api
      .patch("/settings", { revision: form.revision, values })
      .then(() => {
        notify({ key: "media-settings", tone: "good", title: t("media.settings.saved") });
        onSaved();
        onClose();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  const locked = (key: string) =>
    form?.locked.has(key) ? <p className={s.note}>{t("media.settings.locked")}</p> : null;
  return (
    <Drawer
      title={t("media.settings.title")}
      closeLabel={t("common.closeDrawer")}
      onClose={onClose}
      dismissDisabled={busy}
    >
      <ErrorNotice message={error} />
      {form && (
        <form
          className={s.form}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <Field label={t("media.settings.baseUrl")} error={invalid ? t(invalid) : null}>
            <Input
              value={form.base}
              mono
              placeholder={t("media.settings.baseUrlPlaceholder")}
              disabled={busy || form.locked.has("media_public_base_url")}
              invalid={invalid !== null}
              onChange={(event) => setForm({ ...form, base: event.target.value })}
            />
          </Field>
          <p className={s.note}>{t("media.settings.baseUrlHelp")}</p>
          {!invalid && form.base.trim() && (
            <p className={`${s.note} ${s.mono}`}>
              {t("media.settings.baseUrlExample", {
                url: `${form.base.trim().replace(/\/+$/, "")}/v1/media/images/img_…`,
              })}
            </p>
          )}
          {locked("media_public_base_url")}
          <Field label={t("media.settings.limit")}>
            <Input
              type="number"
              min={64}
              max={1048576}
              value={form.limit}
              disabled={busy || form.locked.has("media_max_total_mb")}
              onChange={(event) => setForm({ ...form, limit: Number(event.target.value) })}
            />
          </Field>
          {locked("media_max_total_mb")}
          <Field label={t("media.settings.ttl")}>
            <Select
              label={t("media.settings.ttl")}
              value={form.ttl}
              disabled={busy || form.locked.has("media_ttl_hours")}
              onChange={(value) => setForm({ ...form, ttl: Number(value) })}
            >
              {presets.map((hours) => (
                <option key={hours} value={hours}>
                  {t("media.settings.ttlHours", { hours })}
                </option>
              ))}
            </Select>
          </Field>
          {locked("media_ttl_hours")}
          <p className={s.note}>{t("media.settings.note")}</p>
          <Button type="submit" variant="primary" disabled={busy || invalid !== null}>
            {t("media.settings.save")}
          </Button>
        </form>
      )}
    </Drawer>
  );
}

export function Media() {
  const t = useT();
  const [tab, setTab] = useState<"library" | "tasks">("library");
  const [kind, setKind] = useState("");
  const [taskStatus, setTaskStatus] = useState("");
  const [assetCursors, setAssetCursors] = useState<string[]>([]);
  const [taskCursors, setTaskCursors] = useState<string[]>([]);
  const [preview, setPreview] = useState<RecordValue | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const summary = useResource("/media", normalizeMediaSummary);
  const assetParams = new URLSearchParams({ limit: "24" });
  if (kind) assetParams.set("kind", kind);
  if (assetCursors.length) assetParams.set("cursor", assetCursors.at(-1)!);
  const assets = useResource(`/media/assets?${assetParams.toString()}`, pageNormalize);
  const taskParams = new URLSearchParams({ limit: "50" });
  if (taskStatus) taskParams.set("status", taskStatus);
  if (taskCursors.length) taskParams.set("cursor", taskCursors.at(-1)!);
  const tasks = useResource(`/media/tasks?${taskParams.toString()}`, pageNormalize);
  const data = summary.data;
  const configured = data?.configured === true;
  const reloadAll = () => {
    summary.reload();
    if (tab === "library") assets.reload();
    if (tab === "tasks") tasks.reload();
  };

  // The two panels this bar switches between. Tabs, not a segmented control: the buttons
  // change *which* panel is shown, which is what role="tab" means — and the selection is
  // painted by the tab itself, so no block is ever drawn over a label (P1-1).
  const tabs = [
    { value: "library" as const, label: t("media.tab.library") },
    { value: "tasks" as const, label: t("media.tab.tasks") },
  ];
  const tabsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const selectTab = (value: "library" | "tasks") => {
    setTab(value);
    setAssetCursors([]);
    setTaskCursors([]);
  };
  // Roving focus inside the tablist: one tab is in the tab order and the arrows move
  // between them, the convention every tablist in this console follows.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const last = tabs.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : (index + (event.key === "ArrowRight" ? 1 : last)) % tabs.length;
    const target = tabs[next];
    if (!target) return;
    selectTab(target.value);
    tabsRef.current[next]?.focus();
  };

  const openAsset = (item: RecordValue) => setPreview(item);
  const openAssetById = (id: string) => {
    void api
      .get<unknown>(`/media/assets/${encodeURIComponent(id)}`)
      .then((response) => setPreview(object(response.data, "媒体资源")))
      .catch((err: unknown) =>
        notify({ key: `media-open-${id}`, tone: "bad", title: errorMessage(err) }),
      );
  };

  const usedFraction = data?.limit_bytes
    ? Math.min(1, data.usage.total_bytes / data.limit_bytes)
    : 0;
  const usageTone = usedFraction >= 1 ? "bad" : usedFraction >= 0.85 ? "warn" : "neutral";

  const taskColumns: TableColumn<RecordValue>[] = [
    {
      id: "time",
      header: t("logs.col.time"),
      cell: (row) => taskTime(row.created),
      title: (row) => taskTime(row.created),
    },
    {
      id: "task",
      header: t("media.tasks.taskId"),
      className: s.idCell,
      cell: (row) => shortId(text(row.task_id)),
      title: (row) => text(row.task_id),
    },
    {
      id: "model",
      header: t("media.tasks.model"),
      cell: (row) => text(row.public_model || row.model),
    },
    {
      id: "account",
      header: t("media.tasks.account"),
      cell: (row) => (
        <>
          {text(row.profile)} <small className={s.mono}>{text(row.account_key).slice(0, 12)}</small>
        </>
      ),
      title: (row) => text(row.account_key),
    },
    {
      id: "status",
      header: t("logs.col.status"),
      cell: (row) => {
        const status = text(row.status);
        const active = status === "queued" || status === "in_progress";
        return (
          <>
            <Badge tone={taskStatusTone(status)}>
              {t(
                status === "queued"
                  ? "media.status.queued"
                  : status === "in_progress"
                    ? "media.status.in_progress"
                    : status === "completed"
                      ? "media.status.completed"
                      : "media.status.failed",
              )}
            </Badge>{" "}
            {active && row.error ? <Badge tone="warn">{t("media.tasks.retrying")}</Badge> : null}{" "}
            {row.error ? <small className={s.muted}>{shortId(text(row.error), 40)}</small> : null}
          </>
        );
      },
      title: (row) => (row.error ? text(row.error) : undefined),
    },
    {
      id: "credit",
      header: t("media.tasks.credit"),
      cell: (row) => (number(row.credit) === null ? "—" : number(row.credit)),
    },
    {
      // Both row actions live in the pinned column: a separate "资源" column in the middle
      // of a wide table is exactly what scrolled the only entry point off screen (P1-2).
      id: "actions",
      header: t("logs.col.actions"),
      actions: true,
      cell: (row) => {
        const status = text(row.status);
        const active = status === "queued" || status === "in_progress";
        if (!row.media_id && !active) return <span className={s.muted}>—</span>;
        return (
          <Cluster gap="1">
            {row.media_id ? (
              <Button size="sm" onClick={() => openAssetById(text(row.media_id))}>
                {t("media.tasks.view")}
              </Button>
            ) : null}
            {active ? (
              <Button
                size="sm"
                onClick={() => {
                  void api
                    .post(`/media/tasks/${encodeURIComponent(text(row.task_id))}/refresh`)
                    .then(() => {
                      tasks.reload();
                      summary.reload();
                    })
                    .catch((err: unknown) =>
                      notify({
                        key: `media-task-${text(row.task_id)}`,
                        tone: "bad",
                        title: errorMessage(err),
                      }),
                    );
                }}
              >
                {t("media.tasks.refresh")}
              </Button>
            ) : null}
          </Cluster>
        );
      },
    },
  ];

  return (
    <Page
      title={t("media.title")}
      description={t("media.desc")}
      actions={
        <>
          <Badge tone={configured ? "good" : "warn"}>
            {configured ? t("media.baseConfigured") : t("media.baseMissing")}
          </Badge>
          <Button
            icon={<Icon name="refresh" size="sm" spin={summary.refreshing} />}
            onClick={reloadAll}
          >
            {t("media.refresh")}
          </Button>
          <Button onClick={() => setSettingsOpen(true)}>{t("media.settings")}</Button>
        </>
      }
    >
      {data && !configured && (
        <div className={s.banner} role="alert">
          <Icon name="alert" size="sm" />
          <p className={s.bannerText}>
            {data.locked ? t("media.bannerLocked") : t("media.banner")}
          </p>
          {!data.locked && (
            <Button size="sm" onClick={() => setSettingsOpen(true)}>
              {t("media.bannerAction")}
            </Button>
          )}
        </div>
      )}
      {data && (
        <div className={s.stats}>
          <Stat
            label={t("media.kpi.usage")}
            value={`${bytes(data.usage.total_bytes)} / ${bytes(data.limit_bytes)}`}
            tone={usageTone}
          >
            <span className={s.meter} data-tone={usageTone}>
              <span className={s.meterFill} style={{ width: `${usedFraction * 100}%` }} />
            </span>
          </Stat>
          <Stat
            label={t("media.kpi.images")}
            value={`${data.usage.images.count} · ${bytes(data.usage.images.bytes)}`}
            hint={t("media.retention", { hours: data.ttl_hours })}
          />
          <Stat
            label={t("media.kpi.videos")}
            value={`${data.usage.videos.count} · ${bytes(data.usage.videos.bytes)}`}
          />
          <Stat
            label={t("media.kpi.tasks")}
            value={t("media.kpi.tasksValue", {
              active: data.tasks.active,
              failed: data.tasks.failed,
            })}
            tone={data.tasks.failed > 0 ? "warn" : "neutral"}
          />
        </div>
      )}

      <div className={s.tabs} role="tablist" aria-label={t("media.title")}>
        {tabs.map((entry, index) => (
          <button
            key={entry.value}
            ref={(node) => {
              tabsRef.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`media-tab-${entry.value}`}
            aria-selected={tab === entry.value}
            tabIndex={tab === entry.value ? 0 : -1}
            className={s.tab}
            onClick={() => selectTab(entry.value)}
            onKeyDown={(event) => onTabKey(event, index)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "library" && (
        <>
          <Toolbar gap="2">
            <span className={s.filter}>
              <Select
                aria-label={t("media.filter.kind")}
                value={kind}
                onChange={(value) => {
                  setKind(value);
                  setAssetCursors([]);
                }}
              >
                <option value="">{t("media.filter.all")}</option>
                <option value="image">{t("media.filter.images")}</option>
                <option value="video">{t("media.filter.videos")}</option>
              </Select>
            </span>
          </Toolbar>
          <ResourceState {...assets} />
          {assets.data &&
            (assets.data.items.length ? (
              <Grid min="sm">
                {assets.data.items.map((item) => {
                  const remaining = remainingLabel(item.expires_at, t);
                  const isVideo = item.kind === "video";
                  const model = text(item.model);
                  return (
                    <button
                      key={text(item.id)}
                      type="button"
                      className={s.card}
                      onClick={() => openAsset(item)}
                      title={model}
                    >
                      <span className={s.thumb}>
                        {isVideo ? (
                          <Icon name="play" />
                        ) : (
                          <img
                            src={`/admin/media/assets/${encodeURIComponent(text(item.id))}/content`}
                            alt={`${t(isVideo ? "media.kind.video" : "media.kind.image")} ${model} ${remaining.text}`}
                            loading="lazy"
                            decoding="async"
                          />
                        )}
                      </span>
                      <span className={s.meta}>
                        <strong className={s.model} title={model}>
                          {model}
                        </strong>
                        <small className={s.metaLine}>
                          <Badge>{t(isVideo ? "media.kind.video" : "media.kind.image")}</Badge>
                          {bytes(number(item.size) ?? 0)}
                        </small>
                        <small
                          className={s.metaLine}
                          data-warn={remaining.warn ? "true" : undefined}
                        >
                          {t("media.remaining", { time: remaining.text })}
                        </small>
                      </span>
                    </button>
                  );
                })}
              </Grid>
            ) : (
              <Empty title={t("media.empty.library")}>{t("media.empty.libraryHint")}</Empty>
            ))}
          <div className={s.pagination}>
            <span className={s.pageLabel}>第 {assetCursors.length + 1} 页</span>
            <Cluster gap="2">
              <Button
                size="sm"
                disabled={!assetCursors.length || assets.loading}
                onClick={() => setAssetCursors((old) => old.slice(0, -1))}
              >
                {t("logs.prevPage")}
              </Button>
              <Button
                size="sm"
                disabled={!assets.data?.has_more || assets.loading}
                onClick={() => {
                  if (assets.data?.next_cursor)
                    setAssetCursors((old) => [...old, assets.data!.next_cursor!]);
                }}
              >
                {t("logs.nextPage")}
              </Button>
            </Cluster>
          </div>
        </>
      )}

      {tab === "tasks" && (
        <>
          <Toolbar gap="2">
            <span className={s.filter}>
              <Select
                aria-label={t("media.tab.tasks")}
                value={taskStatus}
                onChange={(value) => {
                  setTaskStatus(value);
                  setTaskCursors([]);
                }}
              >
                <option value="">{t("media.filter.all")}</option>
                <option value="active">{t("media.filter.active")}</option>
                <option value="completed">{t("media.filter.completed")}</option>
                <option value="failed">{t("media.filter.failed")}</option>
              </Select>
            </span>
          </Toolbar>
          <ResourceState {...tasks} />
          {tasks.data &&
            (tasks.data.items.length ? (
              <Table
                columns={taskColumns}
                rows={tasks.data.items}
                rowKey={(row) => text(row.task_id)}
                label={t("media.tab.tasks")}
              />
            ) : (
              <Empty title={t("media.empty.tasks")} />
            ))}
          <div className={s.pagination}>
            <span className={s.pageLabel}>第 {taskCursors.length + 1} 页</span>
            <Cluster gap="2">
              <Button
                size="sm"
                disabled={!taskCursors.length || tasks.loading}
                onClick={() => setTaskCursors((old) => old.slice(0, -1))}
              >
                {t("logs.prevPage")}
              </Button>
              <Button
                size="sm"
                disabled={!tasks.data?.has_more || tasks.loading}
                onClick={() => {
                  if (tasks.data?.next_cursor)
                    setTaskCursors((old) => [...old, tasks.data!.next_cursor!]);
                }}
              >
                {t("logs.nextPage")}
              </Button>
            </Cluster>
          </div>
        </>
      )}

      {preview && (
        <AssetPreview
          item={preview}
          configured={configured}
          onClose={() => setPreview(null)}
          onDeleted={() => {
            assets.reload();
            summary.reload();
          }}
        />
      )}
      {settingsOpen && (
        <MediaSettingsDrawer
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            summary.reload();
            assets.reload();
          }}
        />
      )}
    </Page>
  );
}
