import { useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "../hooks";
import {
  api,
  errorMessage,
  list,
  metric,
  object,
  text,
  useResource,
  type RecordValue,
} from "../api";
import {
  Badge,
  ClearLogs,
  Drawer,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Fields,
  Icon,
  PageTitle,
  Panel,
  ResourceState,
} from "../components";
import { DataTable, writeUrlParams, type DataTableColumn, type SortingState } from "../dataTable";
import { RequestTrace } from "../traceView";
import { eventActionLabel, eventKindLabel } from "../values";
import { profiles } from "./Models";
import s from "../ui.module.scss";
import { t, useT } from "../i18n";
function normalize(value: unknown) {
  const data = object(value);
  if (typeof data.has_more !== "boolean" || (data.has_more && typeof data.next_cursor !== "string"))
    throw new Error(t("logs.pageIncomplete"));
  return {
    items: list(data.items),
    next_cursor: typeof data.next_cursor === "string" ? data.next_cursor : null,
    has_more: data.has_more,
    degraded: data.degraded === true,
  };
}
const emptyFilters = {
  model: "",
  credential: "",
  profile: "",
  status: "",
  client_ip: "",
  search: "",
};
const outcomeLabels: Record<string, string> = {
  success: "logs.outcome.success",
  error: "logs.outcome.error",
  cancelled: "logs.outcome.cancelled",
  warning: "logs.outcome.warning",
};
export function Logs() {
  const t = useT();
  const [kind, setKind] = useState("request");
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [cursors, setCursors] = useState<string[]>([]);
  const [sorting, setSorting] = useState<SortingState>([]);
  // Live filter: typing debounces and re-fetches on its own; the Apply button stays
  // for an immediate submit. Each new filter resets pagination to the first page.
  // The effect fires only when the debounced value actually changes, not when it
  // differs from the applied filters: a manual Apply sets filters=draft
  // synchronously, and a difference check would treat that as stale for one
  // debounce interval and silently revert the submission.
  const debouncedDraft = useDebouncedValue(draft, 450);
  const lastDebounced = useRef(debouncedDraft);
  useEffect(() => {
    if (lastDebounced.current === debouncedDraft) return;
    lastDebounced.current = debouncedDraft;
    setFilters(debouncedDraft);
    setCursors([]);
  }, [debouncedDraft]);
  /**
   * The applied filters live in the address bar, so a refresh keeps them and a
   * pasted link reproduces the view. Only the applied set is written (not the
   * draft): a half-typed search box must not churn the URL on every keystroke.
   */
  useEffect(() => {
    writeUrlParams({ ...filters, kind: kind === "request" ? "" : kind });
  }, [filters, kind]);
  const [detail, setDetail] = useState<RecordValue | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef<AbortController | null>(null);
  useEffect(() => () => detailRequest.current?.abort(), []);
  const [clear, setClear] = useState(false);
  const params = new URLSearchParams({ kind, limit: "50" });
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  if (cursors.length) params.set("cursor", cursors.at(-1)!);
  const resource = useResource(`/logs?${params.toString()}`, normalize);
  const closeDetail = () => {
    detailRequest.current?.abort();
    detailRequest.current = null;
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  };
  const openDetail = (item: RecordValue) => {
    detailRequest.current?.abort();
    detailRequest.current = null;
    setDetail(item);
    setDetailError(null);
    setDetailLoading(false);
    if (kind !== "request") return;
    if (typeof item.id !== "string") {
      setDetailError(t("logs.detailNeedsId"));
      return;
    }
    const controller = new AbortController();
    detailRequest.current = controller;
    const active = () => detailRequest.current === controller && !controller.signal.aborted;
    setDetailLoading(true);
    void api
      .get<unknown>(`/logs/${encodeURIComponent(item.id)}`, { signal: controller.signal })
      .then((res) => {
        if (active()) setDetail(object(res.data));
      })
      .catch((err: unknown) => {
        if (active()) setDetailError(errorMessage(err));
      })
      .finally(() => {
        if (active()) {
          detailRequest.current = null;
          setDetailLoading(false);
        }
      });
  };
  /**
   * A cursor page has no single unique field (runtime events may repeat an id), so
   * the row key stays "id + position" exactly as the hand-written table had it.
   * Sorting is applied by DataTable on top of this fixed order.
   */
  const rows = (resource.data?.items ?? []).map((item, index) => ({
    ...item,
    __key: text(item.id) + index,
  }));
  const columns = useMemo<DataTableColumn<RecordValue>[]>(() => {
    const outcomeOf = (item: RecordValue) =>
      kind === "request" ? item.outcome : object(item.details ?? {}).outcome;
    const list: DataTableColumn<RecordValue>[] = [
      {
        id: "time",
        header: t("logs.col.time"),
        sortValue: (item) => (typeof item.started_at === "number" ? item.started_at : undefined),
        sortDescFirst: true,
        sortUndefined: "last",
        cell: (item) => (
          <>
            {typeof item.started_at === "number"
              ? new Date(item.started_at * 1000).toLocaleString("zh-CN")
              : text(item.started_at)}
            <small className={s.mono}>{text(item.id)}</small>
          </>
        ),
      },
      {
        id: "subject",
        header: kind === "request" ? t("logs.col.modelProfile") : t("logs.col.action"),
        cell: (item) => (
          <>
            <strong title={kind === "request" ? undefined : text(item.action)}>
              {text(
                kind === "request"
                  ? item.model
                  : eventActionLabel(item.action)
                    ? t(eventActionLabel(item.action)!)
                    : item.action,
              )}
            </strong>
            <small title={kind === "request" ? undefined : text(item.kind)}>
              {text(
                kind === "request"
                  ? item.profile
                  : eventKindLabel(item.kind)
                    ? t(eventKindLabel(item.kind)!)
                    : item.kind,
              )}
            </small>
            {kind === "request" && item.client_ip ? (
              <small className={s.mono}>{text(item.client_ip)}</small>
            ) : null}
          </>
        ),
      },
      {
        id: "status",
        header: t("logs.col.status"),
        cell: (item) => {
          const outcome = outcomeOf(item);
          return (
            <>
              <Badge
                tone={
                  outcome === "success"
                    ? "good"
                    : outcome === "error"
                      ? "bad"
                      : outcome === "warning"
                        ? "warn"
                        : "neutral"
                }
              >
                {(typeof outcome === "string" ? t(outcomeLabels[outcome]) : undefined) ??
                  text(outcome ?? item.level ?? item.status)}
              </Badge>
              {item.status_code !== undefined && <small>HTTP {text(item.status_code)}</small>}
            </>
          );
        },
      },
    ];
    if (kind === "request") {
      list.push(
        {
          id: "duration",
          header: t("logs.col.duration"),
          sortValue: (item) =>
            typeof item.duration_ms === "number" ? item.duration_ms : undefined,
          sortDescFirst: true,
          sortUndefined: "last",
          cell: (item) => `${metric(item.duration_ms)} ms`,
        },
        {
          id: "tokens",
          header: "Token / Credit",
          sortValue: (item) =>
            typeof item.total_tokens === "number" ? item.total_tokens : undefined,
          sortDescFirst: true,
          sortUndefined: "last",
          cell: (item) => (
            <>
              {metric(item.total_tokens)}
              <small>{metric(item.credit)} Credit</small>
            </>
          ),
        },
      );
    }
    list.push({
      id: "actions",
      header: t("logs.col.actions"),
      cell: (item) => (
        <button disabled={detailLoading} onClick={() => openDetail(item)}>
          {t("logs.viewDetail")}
        </button>
      ),
    });
    return list;
  }, [kind, t, detailLoading]);
  return (
    <>
      <PageTitle
        title={t("logs.title")}
        actions={
          <>
            <button onClick={resource.reload}>
              <Icon name="refresh" />
              {t("logs.refresh")}
            </button>
            <button onClick={() => setClear(true)}>{t("logs.clear")}</button>
          </>
        }
      />
      <div className={s.tabs} role="tablist" aria-label={t("logs.logTypes")}>
        {[
          ["request", t("logs.tab.request")],
          ["runtime", t("logs.tab.runtime")],
          ["admin", t("logs.kind.admin")],
        ].map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={kind === value}
            className={kind === value ? s.selectedTab : ""}
            onClick={() => {
              closeDetail();
              setKind(value);
              setCursors([]);
              setFilters(emptyFilters);
              setDraft(emptyFilters);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <Panel
        title={
          kind === "request"
            ? t("logs.panel.request")
            : kind === "runtime"
              ? t("logs.tab.runtime")
              : t("logs.tab.admin")
        }
        hint={t("logs.perPage")}
      >
        <form
          className={s.filters}
          onSubmit={(e) => {
            e.preventDefault();
            setFilters(draft);
            setCursors([]);
          }}
        >
          {kind === "request" && (
            <>
              <input
                aria-label={t("logs.filter.model")}
                placeholder={t("logs.placeholder.model")}
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
              <input
                aria-label={t("logs.filter.credential")}
                placeholder={t("logs.placeholder.credential")}
                value={draft.credential}
                onChange={(e) => setDraft({ ...draft, credential: e.target.value })}
              />
              <input
                aria-label={t("logs.filter.clientIp")}
                placeholder={t("logs.placeholder.clientIp")}
                value={draft.client_ip}
                onChange={(e) => setDraft({ ...draft, client_ip: e.target.value })}
              />
              <select
                aria-label={t("logs.filter.profile")}
                value={draft.profile}
                onChange={(e) => setDraft({ ...draft, profile: e.target.value })}
              >
                <option value="">{t("logs.allProfiles")}</option>
                {profiles.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
              <select
                aria-label={t("logs.filter.status")}
                value={draft.status}
                onChange={(e) => setDraft({ ...draft, status: e.target.value })}
              >
                <option value="">{t("logs.allStatuses")}</option>
                <option value="success">{t("logs.outcome.success")}</option>
                <option value="error">{t("logs.outcome.error")}</option>
                <option value="cancelled">{t("logs.outcome.cancelled")}</option>
                <option value="429">{t("logs.http429")}</option>
              </select>
            </>
          )}
          <input
            aria-label={t("logs.filter.search")}
            placeholder={t("logs.placeholder.search")}
            value={draft.search}
            onChange={(e) => setDraft({ ...draft, search: e.target.value })}
          />
          <button type="submit">{t("logs.apply")}</button>
          <button
            type="button"
            onClick={() => {
              setFilters(emptyFilters);
              setDraft(emptyFilters);
              setCursors([]);
            }}
          >
            {t("logs.reset")}
          </button>
        </form>
        <ResourceState {...resource} />
        {resource.data?.degraded && (
          <div className={s.warning} role="alert">
            {t("logs.degraded")}
          </div>
        )}
        <DataTable
          rows={rows}
          columns={columns}
          rowId={(item) => text(item.__key)}
          sorting={sorting}
          onSortingChange={setSorting}
          loading={resource.loading}
          // A 500 used to paint "没有匹配的日志" under the error banner: the failed
          // fetch also leaves rows empty, so the table could not tell the two apart.
          error={resource.error}
          rowHeight={87}
          // Mirrors the real columns: duration and tokens exist only on the request
          // tab, so the runtime/admin tabs get four skeleton cells, not six.
          skeletonCells={
            kind === "request"
              ? ["twoLine", "twoLine", "badge", "text", "twoLine", "badge"]
              : ["twoLine", "twoLine", "badge", "badge"]
          }
          empty={
            <Empty
              title={t("logs.noMatch")}
              tone="filtered"
              onClear={() => {
                setFilters(emptyFilters);
                setDraft(emptyFilters);
                setCursors([]);
              }}
            >
              {t("logs.adjustFilters")}
            </Empty>
          }
        />
        <div className={s.pagination}>
          <span>第 {cursors.length + 1} 页</span>
          <div className={s.actions}>
            <button
              disabled={!cursors.length || resource.loading}
              onClick={() => setCursors((old) => old.slice(0, -1))}
            >
              {t("logs.prevPage")}
            </button>
            <button
              disabled={!resource.data?.has_more || resource.loading}
              onClick={() => {
                if (resource.data?.next_cursor)
                  setCursors((old) => [...old, resource.data!.next_cursor!]);
              }}
            >
              {t("logs.nextPage")}
            </button>
          </div>
        </div>
      </Panel>
      <DrawerPresence>
        {detail && (
          <Drawer title={t("logs.detailTitle")} onClose={closeDetail}>
            <ErrorNotice message={detailError} />
            {detailLoading ? (
              <p role="status">{t("logs.detailLoading")}</p>
            ) : (
              <>
                <Fields
                  data={Object.fromEntries(
                    Object.entries(detail).filter(([key]) => key !== "attempts"),
                  )}
                />
                {Array.isArray(detail.attempts) && (
                  <Panel title={t("logs.attempts")}>
                    {/* The attempts arrive in the order they happened, so the timeline
                        renders them as recorded instead of re-sorting them. */}
                    <RequestTrace attempts={list(detail.attempts)} requestMs={detail.duration_ms} />
                  </Panel>
                )}
              </>
            )}
          </Drawer>
        )}
      </DrawerPresence>
      <DrawerPresence>
        {clear && (
          <ClearLogs
            onClose={() => setClear(false)}
            onDone={() => {
              setCursors([]);
              resource.reload();
            }}
          />
        )}
      </DrawerPresence>
    </>
  );
}
