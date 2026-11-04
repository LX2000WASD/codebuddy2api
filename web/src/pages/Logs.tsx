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
import { ClearLogs } from "../components";
import {
  Badge,
  Button,
  Cluster,
  Drawer,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Grid,
  Input,
  Page,
  Panel,
  Segmented,
  Select,
  Skeleton,
  Stack,
  Table,
  Toolbar,
  nextSort,
  sortRows,
  writeUrlParams,
  type SkeletonCell,
  type SortValue,
  type TableColumn,
  type TableSort,
} from "../ui";
import { RequestTrace } from "../traceView";
import { Fields } from "../values";
import { eventActionLabel, eventKindLabel, webToolLabel } from "../values";
import { serverToolSummary } from "../serverTools";
import {
  CreditAction,
  CreditAmount,
  CreditFilters,
  CreditSource,
  useAccountNames,
} from "../CreditChanges";
import { profiles } from "./Models";
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
  api_key: "",
  type: "",
  search: "",
};
const outcomeLabels: Record<string, string> = {
  success: "logs.outcome.success",
  error: "logs.outcome.error",
  cancelled: "logs.outcome.cancelled",
  warning: "logs.outcome.warning",
};

function ServerToolSummary({ attempts }: { attempts: unknown }) {
  const t = useT();
  const summary = serverToolSummary(attempts);
  if (!summary) return null;
  return (
    <>
      <div role="group" aria-label={t("logs.tool.summary")}>
        <Grid min="sm" gap="2">
          {(
            [
              [t("logs.tool.searches"), metric(summary.search), false],
              [t("logs.tool.fetches"), metric(summary.fetch), false],
              [t("logs.tool.failed"), metric(summary.failed), summary.failed > 0],
              [t("logs.tool.time"), `${metric(summary.durationMs)} ms`, false],
            ] as const
          ).map(([label, value, failed]) => (
            <div key={label}>
              <small>{label}</small>
              {failed ? <Badge tone="bad">{value}</Badge> : <strong>{value}</strong>}
            </div>
          ))}
        </Grid>
      </div>
      {summary.truncated && <small>{t("logs.tool.truncated")}</small>}
    </>
  );
}

export function Logs() {
  const t = useT();
  const [kind, setKind] = useState("request");
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const names = useAccountNames(kind === "credit");
  const [cursors, setCursors] = useState<string[]>([]);
  const [sort, setSort] = useState<TableSort>(null);
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
  useEffect(() => {
    writeUrlParams({ ...filters, kind: kind === "request" ? "" : kind });
  }, [filters, kind]);
  const [detail, setDetail] = useState<RecordValue | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailRequest = useRef<AbortController | null>(null);
  useEffect(() => () => detailRequest.current?.abort(), []);
  const [clear, setClear] = useState(false);
  const [keyNames, setKeyNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    void api
      .get("/keys")
      .then((response) => {
        if (!active) return;
        const rows = list(object(response.data).items, "密钥列表");
        setKeyNames(
          Object.fromEntries(
            rows
              .filter((item) => typeof item.id === "string" && typeof item.name === "string")
              .map((item) => [item.id, item.name]),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const params = new URLSearchParams({ kind, limit: "50" });
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  if (cursors.length) params.set("cursor", cursors.at(-1)!);
  const resource = useResource(`/logs?${params.toString()}`, normalize);
  const apiKeyLabel = (value: unknown) => {
    if (value === null || value === undefined || value === "") return t("logs.legacyApiKey");
    const id = text(value);
    if (id === "anonymous") return t("logs.anonymousApiKey");
    if (id === "admin-external") return t("logs.externalApiKey");
    return keyNames[id] ?? t("logs.deletedApiKey", { id });
  };
  const keyOptions = Array.from(
    new Set([
      ...Object.keys(keyNames),
      ...(resource.data?.items.flatMap((item) =>
        typeof item.api_key === "string" && item.api_key ? [item.api_key] : [],
      ) ?? []),
    ]),
  );
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
   */
  const rows: RecordValue[] = (resource.data?.items ?? []).map((item, index) => ({
    ...item,
    __key: text(item.id) + index,
  }));
  const columns = useMemo<TableColumn<RecordValue>[]>(() => {
    const outcomeOf = (item: RecordValue) =>
      kind === "request" ? item.outcome : object(item.details ?? {}).outcome;
    const toolOf = (item: RecordValue) =>
      kind === "request" ? serverToolSummary(item.attempts) : null;
    /**
     * The gateway reports its own web tools as the record's model ("web-search",
     * "web-fetch"). The list shows the localized name and keeps the raw id on hover,
     * because that id is what an operator greps for in the audit trail.
     */
    const subject: TableColumn<RecordValue> = {
      id: "subject",
      header: kind === "request" ? t("logs.col.modelProfile") : t("logs.col.action"),
      cell: (item) => {
        const toolModel = kind === "request" ? webToolLabel(item.model) : undefined;
        const tools = toolOf(item);
        return (
          <>
            <strong title={kind === "request" ? toolModel && text(item.model) : text(item.action)}>
              {text(
                kind === "request"
                  ? toolModel
                    ? t(toolModel)
                    : item.model
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
              {kind === "request" && (item.protocol === "images" || item.protocol === "videos") && (
                <Badge tone="neutral">
                  {t(item.protocol === "images" ? "val.protocol.images" : "val.protocol.videos")}
                </Badge>
              )}
              {tools && (
                <Badge tone={tools.failed ? "bad" : "neutral"}>
                  {t("logs.tool.badge", {
                    n: tools.truncated ? `${tools.total}+` : tools.total,
                  })}
                </Badge>
              )}
            </small>
            {kind === "request" && item.client_ip ? (
              <small>
                <code>{text(item.client_ip)}</code>
              </small>
            ) : null}
          </>
        );
      },
    };
    const status: TableColumn<RecordValue> = {
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
    };
    const result: TableColumn<RecordValue>[] = [
      {
        id: "time",
        header: t("logs.col.time"),
        sortable: true,
        cell: (item) => (
          <>
            {typeof item.started_at === "number"
              ? new Date(item.started_at * 1000).toLocaleString("zh-CN")
              : text(item.started_at)}
            <small>
              <code>{text(item.id)}</code>
            </small>
          </>
        ),
      },
    ];
    if (kind === "credit") {
      result.push(
        {
          id: "change",
          header: t("logs.col.changeAccount"),
          cell: (item) => <CreditAction item={item} names={names} />,
        },
        {
          id: "amount",
          header: t("logs.col.changeAmount"),
          cell: (item) => <CreditAmount item={item} />,
        },
        {
          id: "source",
          header: t("logs.col.changeSource"),
          cell: (item) => <CreditSource item={item} />,
        },
      );
    } else {
      result.push(subject, status);
      if (kind === "request") {
        result.push(
          // Below 1200px these three fold away: with the fixed sidebar the content column
          // cannot seat seven columns, and the ones that used to disappear were the middle
          // ones — 状态 among them — while 操作 stayed pinned. The card layout still shows all.
          {
            id: "apiKey",
            header: t("logs.col.apiKey"),
            cell: (item) => apiKeyLabel(item.api_key),
            secondary: true,
          },
          {
            id: "duration",
            header: t("logs.col.duration"),
            sortable: true,
            cell: (item) => `${metric(item.duration_ms)} ms`,
            secondary: true,
          },
          {
            id: "tokens",
            header: "Token / Credit",
            sortable: true,
            secondary: true,
            cell: (item) => (
              <>
                {metric(item.total_tokens)}
                <small>{metric(item.credit)} Credit</small>
              </>
            ),
          },
        );
      }
    }
    // The one entry point of the list: Table pins this column to the right edge, and in
    // the card layout it becomes the last pair, so the action never scrolls away (P1-2).
    result.push({
      id: "actions",
      header: t("logs.col.actions"),
      actions: true,
      cell: (item) => (
        <Button size="sm" disabled={detailLoading} onClick={() => openDetail(item)}>
          {t("logs.viewDetail")}
        </Button>
      ),
    });
    return result;
    // `keyNames` is the data the api-key cell formats; without it a late /keys
    // response would leave the column showing every id as "deleted".
  }, [kind, t, detailLoading, names, keyNames]);
  // The comparable value of each sortable column; a column without an entry is not sortable.
  const sortValues: Record<string, SortValue<RecordValue>> = {
    time: (item) => (typeof item.started_at === "number" ? item.started_at : undefined),
    duration: (item) => (typeof item.duration_ms === "number" ? item.duration_ms : undefined),
    tokens: (item) => (typeof item.total_tokens === "number" ? item.total_tokens : undefined),
  };
  const DESC_FIRST = new Set(["time", "duration", "tokens"]);
  const sortedRows = sortRows(rows, sortValues, sort);
  const skeletonCells: SkeletonCell[] =
    kind === "request"
      ? ["twoLine", "twoLine", "badge", "text", "text", "twoLine", "badge"]
      : kind === "credit"
        ? ["twoLine", "twoLine", "badge", "text", "badge"]
        : ["twoLine", "twoLine", "badge", "badge"];
  const resetFilters = () => {
    setFilters(emptyFilters);
    setDraft(emptyFilters);
    setCursors([]);
  };
  const kindLabels = [
    { value: "request", label: t("logs.tab.request") },
    { value: "runtime", label: t("logs.tab.runtime") },
    { value: "admin", label: t("logs.kind.admin") },
    { value: "credit", label: t("logs.tab.credit") },
  ];
  const tableBody =
    resource.error && !rows.length ? null : resource.loading && !rows.length ? (
      <Skeleton variant="table" label={t("common.loading")} cells={skeletonCells} rowHeight={87} />
    ) : rows.length ? (
      <Table
        label={t("logs.title")}
        columns={columns}
        rows={sortedRows}
        rowKey={(item) => text(item.__key)}
        sort={sort}
        onSort={(id) => setSort((current) => nextSort(current, id, DESC_FIRST.has(id)))}
      />
    ) : (
      <Empty
        title={t("logs.noMatch")}
        tone="filtered"
        action={<Button onClick={resetFilters}>{t("common.clearFilters")}</Button>}
      >
        {t("logs.adjustFilters")}
      </Empty>
    );
  return (
    <Page
      title={t("logs.title")}
      actions={
        <>
          <Button icon="refresh" onClick={resource.reload}>
            {t("logs.refresh")}
          </Button>
          <Button variant="danger" onClick={() => setClear(true)}>
            {t("logs.clear")}
          </Button>
        </>
      }
    >
      <Segmented
        label={t("logs.logTypes")}
        value={kind}
        onChange={(value) => {
          closeDetail();
          setKind(value);
          setCursors([]);
          setSort(null);
          setFilters(emptyFilters);
          setDraft(emptyFilters);
        }}
        options={kindLabels}
      />
      <Panel
        title={
          kind === "request"
            ? t("logs.panel.request")
            : kind === "runtime"
              ? t("logs.tab.runtime")
              : kind === "credit"
                ? t("logs.panel.credit")
                : t("logs.tab.admin")
        }
        hint={t("logs.perPage")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFilters(draft);
            setCursors([]);
          }}
        >
          <Stack gap="3">
            <Grid min="sm" gap="2">
              {kind === "request" && (
                <>
                  <Input
                    aria-label={t("logs.filter.model")}
                    placeholder={t("logs.placeholder.model")}
                    value={draft.model}
                    onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  />
                  <Input
                    aria-label={t("logs.filter.credential")}
                    placeholder={t("logs.placeholder.credential")}
                    value={draft.credential}
                    onChange={(e) => setDraft({ ...draft, credential: e.target.value })}
                  />
                  <Input
                    aria-label={t("logs.filter.clientIp")}
                    placeholder={t("logs.placeholder.clientIp")}
                    value={draft.client_ip}
                    onChange={(e) => setDraft({ ...draft, client_ip: e.target.value })}
                  />
                  <Select
                    label={t("logs.filter.apiKey")}
                    value={draft.api_key}
                    onChange={(value) => setDraft({ ...draft, api_key: value })}
                  >
                    <option value="">{t("logs.allApiKeys")}</option>
                    {keyOptions.map((id) => (
                      <option key={id} value={id}>
                        {apiKeyLabel(id)}
                      </option>
                    ))}
                  </Select>
                  <Select
                    label={t("logs.filter.profile")}
                    value={draft.profile}
                    onChange={(value) => setDraft({ ...draft, profile: value })}
                  >
                    <option value="">{t("logs.allProfiles")}</option>
                    {profiles.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </Select>
                  <Select
                    label={t("logs.filter.status")}
                    value={draft.status}
                    onChange={(value) => setDraft({ ...draft, status: value })}
                  >
                    <option value="">{t("logs.allStatuses")}</option>
                    <option value="success">{t("logs.outcome.success")}</option>
                    <option value="error">{t("logs.outcome.error")}</option>
                    <option value="cancelled">{t("logs.outcome.cancelled")}</option>
                    <option value="429">{t("logs.http429")}</option>
                  </Select>
                </>
              )}
              {kind === "credit" && (
                <CreditFilters
                  credential={draft.credential}
                  type={draft.type}
                  names={names}
                  onChange={(patch) => setDraft({ ...draft, ...patch })}
                />
              )}
              <Input
                aria-label={t("logs.filter.search")}
                placeholder={t("logs.placeholder.search")}
                value={draft.search}
                onChange={(e) => setDraft({ ...draft, search: e.target.value })}
              />
            </Grid>
            <Toolbar gap="2">
              <Button type="submit" variant="primary">
                {t("logs.apply")}
              </Button>
              <Button onClick={resetFilters}>{t("logs.reset")}</Button>
            </Toolbar>
          </Stack>
        </form>
        <ErrorNotice
          message={resource.error}
          retry={{ label: t("common.retry"), onClick: resource.reload }}
        />
        {resource.data?.degraded && (
          <div role="alert">
            <Badge tone="warn">{t("logs.degraded")}</Badge>
          </div>
        )}
        {tableBody}
        <Toolbar split>
          <Badge>第 {cursors.length + 1} 页</Badge>
          <Cluster gap="2">
            <Button
              disabled={!cursors.length || resource.loading}
              onClick={() => setCursors((old) => old.slice(0, -1))}
            >
              {t("logs.prevPage")}
            </Button>
            <Button
              disabled={!resource.data?.has_more || resource.loading}
              onClick={() => {
                if (resource.data?.next_cursor)
                  setCursors((old) => [...old, resource.data!.next_cursor!]);
              }}
            >
              {t("logs.nextPage")}
            </Button>
          </Cluster>
        </Toolbar>
      </Panel>
      <DrawerPresence>
        {detail && (
          <Drawer
            title={t("logs.detailTitle")}
            onClose={closeDetail}
            closeLabel={t("common.closeDrawer")}
          >
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
                    <ServerToolSummary attempts={detail.attempts} />
                    {/* The attempts arrive in the order they happened, so the timeline
                        renders them as recorded instead of re-sorting them. */}
                    <RequestTrace attempts={list(detail.attempts)} requestMs={detail.duration_ms} />
                    {/* The same records as fields, one block per attempt: the timeline
                        answers "in what order and how long", this answers "what exactly
                        did the backend store" — including keys the timeline has no slot
                        for, with the recorded stage and model values localized. */}
                    {list(detail.attempts).length > 0 && (
                      <details>
                        <summary>{t("logs.attempts")}</summary>
                        {list(detail.attempts).map((attempt, index) => (
                          <div key={index}>
                            <h3>{t("logs.attemptN", { n: index + 1 })}</h3>
                            <Fields data={attempt} />
                          </div>
                        ))}
                      </details>
                    )}
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
    </Page>
  );
}
