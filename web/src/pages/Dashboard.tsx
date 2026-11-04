import { useCallback, useEffect, useState } from "react";
import {
  api,
  errorMessage,
  list,
  metric,
  number,
  object,
  text,
  useResource,
  type RecordValue,
} from "../api";
import {
  Badge,
  Button,
  Cluster,
  Drawer,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Icon,
  Page,
  Panel,
  Select,
  Skeleton,
  Table,
  type TableColumn,
} from "../ui";
import { Fields, profileLabel } from "../values";
import s from "./Dashboard.module.scss";
import { CostCards } from "../insights";
import { KpiCards, UsageTrend } from "../UsageOverview";
import { t, useDateFormat, useT } from "../i18n";

function normalize(value: unknown): RecordValue & {
  summary: RecordValue;
  previous: RecordValue | null;
  series: RecordValue[];
  models: RecordValue[];
  profiles: RecordValue[];
  health: RecordValue;
  storage: RecordValue;
  range: RecordValue;
  config_notice: RecordValue | null;
} {
  const d = object(value);
  for (const field of ["series", "models", "profiles"]) {
    if (list(d[field], field).some((row) => number(row.requests) === null))
      throw new Error(`${field} 中存在未知请求量，不能绘制为 0`);
  }
  return {
    ...d,
    summary: object(d.summary, t("dash.summary")),
    previous:
      d.previous === null || d.previous === undefined ? null : object(d.previous, "上周期汇总"),
    series: list(d.series, "趋势"),
    models: list(d.models, "模型排行"),
    profiles: list(d.profiles, t("dash.profileUsage")),
    health: object(d.health, "健康状态"),
    storage: object(d.storage, "存储状态"),
    range: d.range === undefined ? {} : object(d.range, t("dash.window")),
    config_notice:
      d.config_notice === undefined || d.config_notice === null
        ? null
        : object(d.config_notice, t("dash.configNoticeTitle")),
  };
}

/** "启用/手动停用 + 健康状态" as one badge tone, shared by both credential panels. */
function healthTone(c: RecordValue): "good" | "warn" | "neutral" {
  if (c.enabled === false) return "neutral";
  return c.health === "ready" ? "good" : "warn";
}

function Health({ data }: { data: RecordValue }) {
  const t = useT();
  if (!Array.isArray(data.credentials)) return <Fields data={data} />;
  const credentials = list(data.credentials);
  if (!credentials.length) return <Empty title={t("dash.credentialHealthEmpty")} />;
  return (
    <ul className={s.healthList}>
      {credentials.map((c, i) => (
        <li key={i} className={s.healthRow}>
          <div className={s.healthIdentity}>
            <strong>{text(c.name ?? c.filename)}</strong>
            <small>{profileLabel(text(c.profile))}</small>
          </div>
          <div className={s.healthState}>
            <Badge tone={healthTone(c)}>
              {c.enabled === false
                ? t("dash.status.manual")
                : c.health === "ready"
                  ? t("dash.status.ready")
                  : text(c.health)}
            </Badge>
            {Array.isArray(c.cooldowns) && c.cooldowns.length > 0 && (
              <small>{t("dash.modelCooldowns", { n: c.cooldowns.length })}</small>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One balance row, with the account name already resolved for the table. */
type BalanceRow = { key: string; name: string; credits: RecordValue | null; row: RecordValue };

function OfficialCredits({ value }: { value: unknown }) {
  const t = useT();
  const format = useDateFormat();
  const entries = Object.entries(object(value));
  if (!entries.length) return <Empty title={t("dash.balanceSnapshotEmpty")} />;
  const rows: BalanceRow[] = entries.map(([key, entry], index) => {
    const row = object(entry);
    return {
      key: String(index),
      name: typeof row.name === "string" ? row.name : (key.split(/[\\/]/).at(-1) ?? key),
      credits: row.credits ? object(row.credits) : null,
      row,
    };
  });
  const columns: TableColumn<BalanceRow>[] = [
    { id: "name", header: t("dash.credentials"), cell: (row) => row.name },
    {
      id: "balance",
      header: t("dash.balance"),
      cell: (row) =>
        row.credits?.unlimited && row.credits?.enterprise
          ? t("dash.unlimited")
          : metric(row.credits?.credits ?? row.credits?.remaining),
    },
    {
      id: "sync",
      header: t("dash.syncStatus"),
      cell: (row) =>
        row.row.error ? (
          <Badge tone="warn">{t("dash.status.syncError")}</Badge>
        ) : (
          <span>
            {typeof row.row.fetched_at === "number"
              ? format.dateTime(new Date(row.row.fetched_at * 1000))
              : t("dash.syncTimeUnknown")}
          </span>
        ),
    },
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      label={t("dash.balanceTitle")}
      scroll
    />
  );
}

/** One row of the model ranking: the resolved name plus the numbers it is ranked by. */
type RankRow = { key: string; model: string; row: RecordValue };

function ConfigNotice({ notice, onDismiss }: { notice: RecordValue; onDismiss: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const items = list(notice.items, t("dash.configNoticeTitle"));
  const keys = items.map((item) => text(item.key)).join("、");
  const command = text(notice.command);
  const count = number(notice.count) ?? items.length;
  return (
    <div className={s.notice} role="status">
      <Icon name="alert" size="sm" />
      <div className={s.noticeBody}>
        <strong>{t("dash.configNoticeTitle")}</strong>
        <p>{t("dash.configNoticeBody", { count: String(count), keys })}</p>
        <code className={s.noticeCommand}>{command}</code>
        <Cluster gap="2">
          <Button
            size="sm"
            onClick={() => {
              const clipboard = navigator.clipboard;
              if (!clipboard) return;
              void clipboard.writeText(command).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? t("dash.configNoticeCopied") : t("dash.configNoticeCopy")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t("dash.configNoticeDismiss")}
          </Button>
        </Cluster>
      </div>
    </div>
  );
}

function ConfigNoticeConfirm({
  notice,
  onClose,
  onDismissed,
}: {
  notice: RecordValue;
  onClose: () => void;
  onDismissed: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = number(notice.count) ?? list(notice.items).length;
  return (
    <Drawer
      title={t("dash.configNoticeConfirmTitle")}
      onClose={onClose}
      dismissDisabled={busy}
      closeLabel={t("common.closeDrawer")}
      footer={
        <Cluster gap="2">
          <Button disabled={busy} onClick={onClose}>
            {t("dash.configNoticeCancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void api
                .post("/config-notice/dismiss", {})
                .then(() => onDismissed())
                .catch((err: unknown) => setError(errorMessage(err)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? t("dash.configNoticeConfirming") : t("dash.configNoticeConfirm")}
          </Button>
        </Cluster>
      }
    >
      <div className={s.notice}>
        <Icon name="alert" size="sm" />
        <div className={s.noticeBody}>
          <strong>{t("dash.configNoticeConfirmStrong", { count: String(count) })}</strong>
          <p>{t("dash.configNoticeConfirmBody", { count: String(count) })}</p>
        </div>
      </div>
      <ErrorNotice message={error} />
    </Drawer>
  );
}

export { Trend } from "../Trend";

/**
 * Hourly buckets for the trend's zoom-in granularity swap. Mounted only after
 * the user actually zooms in: the payload is ~1.35 MB, so prefetching it on
 * every range change wasted a full dashboard request for users who never zoom.
 * It also reuses this module's normalize(), so the swap reads the same shape.
 */
function HourlyBuckets({
  path,
  onLoad,
}: {
  path: string;
  onLoad: (rows: RecordValue[], partial: boolean) => void;
}) {
  const hourly = useResource(path, normalize);
  useEffect(() => {
    if (hourly.data) onLoad(hourly.data.series, hourly.data.range.partial === true);
  }, [hourly.data, onLoad]);
  return null;
}

export function Dashboard() {
  const t = useT();
  const format = useDateFormat();
  const [days, setDays] = useState("7");
  const [granularity, setGranularity] = useState("auto");
  const [noticeHidden, setNoticeHidden] = useState(false);
  const [confirmingNotice, setConfirmingNotice] = useState(false);
  const resource = useResource(`/dashboard?days=${days}&granularity=${granularity}`, normalize);
  // Lazily fetched hourly series (see HourlyBuckets); null until the first zoom.
  const [hourly, setHourly] = useState<{ rows: RecordValue[]; partial: boolean } | null>(null);
  const [hourlyWanted, setHourlyWanted] = useState(false);
  const [hourlyReload, setHourlyReload] = useState(0);
  const loadHourly = useCallback(
    (rows: RecordValue[], partial: boolean) => setHourly({ rows, partial }),
    [],
  );
  const d = resource.data;
  const period = d?.range ?? {};
  const actualGrain = period.granularity === "hour" ? "hour" : "day";
  // When the server already answered with hourly buckets (auto + a one-day
  // range, or an explicit granularity=hour) a second, identical request would
  // download the same payload twice for the same chart.
  const wantsHourly = hourlyWanted && actualGrain !== "hour";
  const profiles = d?.profiles ?? [];
  const profileTotal = profiles.reduce((sum, row) => sum + (number(row.requests) ?? 0), 0);
  // The ranking table reads the ten busiest models of the window; the row key is the
  // position, because two rules may report the same public name.
  const rankRows: RankRow[] = [...(d?.models ?? [])]
    .sort((a, b) => (number(b.requests) ?? -1) - (number(a.requests) ?? -1))
    .slice(0, 10)
    .map((row, index) => ({
      key: String(index),
      model: text(row.model) || t("dash.unknownModel"),
      row,
    }));
  const rankColumns: TableColumn<RankRow>[] = [
    {
      id: "model",
      header: t("dash.models"),
      cell: (row) => (
        <span className={s.modelCell}>
          <span className={s.rank}>{String(Number(row.key) + 1).padStart(2, "0")}</span>
          <strong>{row.model}</strong>
        </span>
      ),
    },
    { id: "requests", header: t("dash.requests"), cell: (row) => metric(row.row.requests) },
    { id: "tokens", header: "Token", cell: (row) => metric(row.row.total_tokens) },
    { id: "credit", header: "Credit", cell: (row) => metric(row.row.credit) },
  ];
  return (
    <Page
      title={t("dash.runtime")}
      actions={
        <>
          <Select
            className={s.range}
            label={t("dash.range")}
            value={days}
            onChange={(value) => setDays(value)}
          >
            {["1", "7", "30", "90"].map((n) => (
              <option value={n} key={n}>
                {t("dash.lastNDays", { n })}
              </option>
            ))}
          </Select>
          <Select
            className={s.range}
            label={t("dash.granularity")}
            value={granularity}
            onChange={(value) => setGranularity(value)}
          >
            <option value="auto">{t("dash.granularityAuto")}</option>
            <option value="hour">{t("dash.granularityHour")}</option>
            <option value="day">{t("dash.granularityDay")}</option>
          </Select>
          <Button
            icon={<Icon name="refresh" size="sm" spin={resource.refreshing} />}
            onClick={() => {
              resource.reload();
              // Refetch the lazy hourly series too, if it is in play.
              setHourlyReload((v) => v + 1);
            }}
          >
            {t("dash.refresh")}
          </Button>
        </>
      }
    >
      {resource.loading && <Skeleton variant="card" label={t("common.loading")} />}
      <ErrorNotice
        message={resource.error}
        retry={{ label: t("common.retry"), onClick: resource.reload }}
      />
      {d?.config_notice && !noticeHidden && (
        <ConfigNotice notice={d.config_notice} onDismiss={() => setConfirmingNotice(true)} />
      )}
      <DrawerPresence>
        {confirmingNotice && d?.config_notice && (
          <ConfigNoticeConfirm
            notice={d.config_notice}
            onClose={() => setConfirmingNotice(false)}
            onDismissed={() => {
              setNoticeHidden(true);
              setConfirmingNotice(false);
            }}
          />
        )}
      </DrawerPresence>
      {d && (
        <>
          {(d.degraded === true || d.storage.degraded === true) && (
            <div className={s.notice} role="alert">
              {t("dash.storageDegraded")}
            </div>
          )}
          <KpiCards summary={d.summary} previous={d.previous} series={d.series} />
          {/* Cost is a re-projection of this same payload — see insights.tsx for why
              /admin/stats/summary is deliberately not called. */}
          <Panel title={t("cost.title")} hint={t("cost.hint")}>
            <CostCards
              summary={d.summary}
              series={d.series}
              range={d.range}
              partial={period.partial === true}
            />
          </Panel>
          <Panel title={t("dash.usageTrend")} hint={t("dash.usageTrendHint")}>
            {period.partial === true && (
              <p className={s.note} role="status">
                {t("dash.storagePartial")}
              </p>
            )}
            <UsageTrend
              rows={d.series}
              hourlyRows={hourly?.rows}
              hourlyPartial={hourly?.partial === true}
              granularity={actualGrain}
              partial={period.partial === true}
              onNeedHourly={() => setHourlyWanted(true)}
            />
            {wantsHourly && (
              <HourlyBuckets
                key={hourlyReload}
                path={`/dashboard?days=${days}&granularity=hour`}
                onLoad={loadHourly}
              />
            )}
          </Panel>
          <div className={s.grid}>
            <Panel title={t("dash.profileUsage")} hint={t("dash.granularityByRequests")}>
              {profiles.length ? (
                <div className={s.distribution}>
                  {profiles.map((p, i) => {
                    const count = number(p.requests);
                    return (
                      <div key={i} className={s.distributionRow}>
                        <div className={s.distributionHead}>
                          <strong>{profileLabel(text(p.profile))}</strong>
                          <span>{metric(p.requests)}</span>
                        </div>
                        <progress
                          max={profileTotal || 1}
                          value={count ?? 0}
                          aria-label={`${profileLabel(text(p.profile))} ${t("dash.shareOfRequests")}`}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : (
                <Empty title={t("dash.profileUsageEmpty")} />
              )}
            </Panel>
            <Panel title={t("dash.modelRank")}>
              {rankRows.length ? (
                <Table
                  columns={rankColumns}
                  rows={rankRows}
                  rowKey={(row) => row.key}
                  label={t("dash.modelRank")}
                  scroll
                />
              ) : (
                <Empty title={t("dash.modelRankEmpty")} />
              )}
            </Panel>
            <Panel title={t("dash.credentialHealth")}>
              <Health data={d.health} />
            </Panel>
            <Panel title={t("dash.balanceTitle")}>
              <p className={s.note}>{t("dash.balanceNote")}</p>
              {d.official_credits !== undefined ? (
                <OfficialCredits value={d.official_credits} />
              ) : (
                <p className={s.muted}>{t("dash.balanceEmpty")}</p>
              )}
            </Panel>
          </div>
          <p className={s.updated}>
            {t("dash.updatedAt")}{" "}
            {typeof d.generated_at === "number"
              ? format.dateTime(new Date(d.generated_at * 1000))
              : text(d.generated_at)}{" "}
          </p>
        </>
      )}
    </Page>
  );
}
