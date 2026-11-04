import { useEffect, useState } from "react";
import { list, metric, number, object, text, type RecordValue } from "../api";
import { LineChart, StackedBars, type ChartBucket } from "../charts";
import { useFusionResource } from "../fusion/client";
import { FUSION_DEVELOPMENT } from "../fusion/client";
import type { StatsSeriesResponse } from "../fusion/types";
import { t, useT } from "../i18n";
import {
  Badge,
  Button,
  Empty,
  ErrorNotice,
  Field,
  Icon,
  Page,
  Panel,
  Skeleton,
  Table,
  type IconName,
  type TableColumn,
} from "../ui";
import s from "./Trends.module.scss";

type Dimension = "global" | "model" | "profile" | "credential";
type MetricMode = "requests" | "latency" | "rate";

function normalizeSeries(value: unknown): StatsSeriesResponse {
  const data = object(value, t("fusion.trends.seriesContext"));
  if (!Array.isArray(data.series)) throw new Error(t("fusion.trends.seriesMissing"));
  const series = list(data.series, t("fusion.trends.seriesContext")).map((row) => {
    if (number(row.bucket) === null) throw new Error(t("fusion.trends.bucketMissing"));
    return row;
  });
  return { ...(data as StatsSeriesResponse), series: series as StatsSeriesResponse["series"] };
}

/**
 * Splits a dimension response into usable items.
 *
 * A single unusable row used to throw, which turned the whole trends page into an
 * error state — one dirty key from the aggregate table and the user loses every
 * chart. Invalid rows are now dropped instead: the page renders what it can, and the
 * count of skipped rows is returned so the view can say so rather than silently
 * pretending the data was complete.
 */
function normalizeDimensions(value: unknown): {
  items: Array<{ key: string; label: string | null }>;
  skipped: number;
} {
  const data = object(value, t("fusion.trends.dimensionsContext"));
  const items: Array<{ key: string; label: string | null }> = [];
  let skipped = 0;
  for (const item of list(data.items, t("fusion.trends.dimensionsContext"))) {
    if (typeof item.key !== "string" || !item.key) {
      skipped += 1;
      continue;
    }
    items.push({ key: item.key, label: typeof item.label === "string" ? item.label : null });
  }
  return { items, skipped };
}

const percentiles = [
  { key: "latency_p50_ms", label: "P50", unit: "ms", color: "accent" as const },
  { key: "latency_p95_ms", label: "P95", unit: "ms", color: "strong" as const },
  { key: "latency_p99_ms", label: "P99", unit: "ms", color: "error" as const },
];
// Resolved through the module-level t() so the label follows the active language.
const rateMetric = () => [
  {
    key: "tokens_per_s",
    label: t("fusion.trends.metric.rate"),
    unit: "tok/s",
    color: "accent" as const,
  },
];

/** The six per-bucket numbers as table columns, in the order the panel has always shown. */
function bucketColumns(): TableColumn<RecordValue>[] {
  return [
    {
      id: "bucket",
      header: t("fusion.trends.colBucket"),
      cell: (row) => <strong>{text(row.date)}</strong>,
    },
    { id: "requests", header: t("fusion.trends.colRequests"), cell: (row) => metric(row.requests) },
    {
      id: "outcome",
      header: t("fusion.trends.colSuccessError"),
      cell: (row) => `${metric(row.success)} / ${metric(row.error)}`,
    },
    {
      id: "percentiles",
      header: "P50 / P95 / P99",
      cell: (row) =>
        percentiles
          .map((p) => (number(row[p.key]) === null ? "—" : `${metric(row[p.key])}ms`))
          .join(" · "),
    },
    {
      id: "rate",
      header: t("fusion.trends.metric.rate"),
      cell: (row) =>
        number(row.tokens_per_s) === null ? "—" : `${metric(row.tokens_per_s)} tok/s`,
    },
    { id: "tokens", header: "Token", cell: (row) => metric(row.total_tokens) },
  ];
}

export function Trends() {
  const t = useT();
  const [days, setDays] = useState("7");
  const [granularity, setGranularity] = useState("auto");
  const [dimension, setDimension] = useState<Dimension>("global");
  const [key, setKey] = useState("");
  const [metricMode, setMetricMode] = useState<MetricMode>("requests");

  const dimParams = new URLSearchParams({ dimension, days });
  const dimensions = useFusionResource(
    dimension === "global" ? null : "/admin/stats/dimensions",
    dimParams,
    normalizeDimensions,
  );
  // Auto-select the first key of a fresh dimension list so the series request is
  // always well-formed (dimension ≠ global requires a key per the contract).
  useEffect(() => {
    const items = dimensions.data?.items ?? [];
    if (!items.length || dimension === "global") return;
    if (!key || !items.some((item) => item.key === key)) setKey(items[0]!.key);
  }, [dimensions.data, dimension, key]);

  const seriesParams = new URLSearchParams({ days, granularity, dimension });
  if (dimension !== "global" && key) seriesParams.set("key", key);
  const ready = dimension === "global" || !!key;
  const series = useFusionResource("/admin/stats/series", seriesParams, normalizeSeries, ready);

  const rows = series.data?.series ?? [];
  const buckets: ChartBucket[] = rows;
  const actualGrain = series.data?.range.granularity === "hour" ? "hour" : "day";
  const summary = series.data?.summary;
  // Rows the backend could not key are dropped in normalizeDimensions instead of
  // failing the page; say how many, because silently showing a partial dimension
  // list is the same lie as a switch that reports the wrong state.
  const skipped = dimensions.data?.skipped ?? 0;
  const successRate =
    summary && summary.requests ? (summary.success / summary.requests) * 100 : null;
  const selection = dimensions.data?.items.find((item) => item.key === key);
  const objectLabel =
    dimension === "credential"
      ? t("fusion.trends.dim.credential")
      : dimension === "profile"
        ? t("fusion.trends.dim.profile")
        : t("fusion.trends.dim.model");
  // Five stats, keyed by position: the label is the identity the reader needs, and two
  // localized labels may collide on a long translation.
  const stats: Array<{
    label: string;
    value: string;
    icon: IconName;
    hint?: string;
    title?: string;
  }> = summary
    ? [
        {
          label: t("fusion.trends.summary.requests"),
          value: metric(summary.requests),
          icon: "arrow",
        },
        {
          label: t("fusion.trends.summary.successRate"),
          value: successRate === null ? t("fusion.common.unknown") : `${successRate.toFixed(1)}%`,
          icon: "shield",
        },
        {
          label: t("fusion.trends.summary.p95"),
          value:
            summary.latency_p95_ms === null
              ? t("fusion.trends.insufficientSamples")
              : `${metric(summary.latency_p95_ms)} ms`,
          icon: "pulse",
          // The "approximate (histogram)" qualifier used to sit inside the value. It
          // belongs on the hint line: it explains the number without competing with it
          // for width, and the value keeps the full, untruncated figure.
          hint: summary.latency_p95_ms === null ? undefined : t("dash.p95Approx"),
        },
        {
          label: t("fusion.trends.summary.rate"),
          value:
            summary.tokens_per_s === null
              ? t("fusion.common.unknown")
              : `${metric(summary.tokens_per_s)} tok/s`,
          icon: "model",
        },
        {
          label: t("fusion.trends.summary.credit"),
          value: metric(summary.credit),
          icon: "leaf",
        },
      ]
    : [];
  // The bucket id is optional in the contract, so the table is keyed by position.
  const bucketRows: RecordValue[] = rows.map((row, index) => ({ ...row, key: String(index) }));
  return (
    <Page
      title={t("nav.trends")}
      description={t("fusion.trends.pageDesc")}
      actions={
        <>
          {FUSION_DEVELOPMENT && <Badge tone="warn">{t("fusion.common.demoData")}</Badge>}
          <Button
            icon={<Icon name="refresh" size="sm" spin={series.loading} />}
            disabled={series.loading}
            onClick={() => series.reload()}
          >
            {t("fusion.common.refresh")}
          </Button>
        </>
      }
    >
      <Panel title={t("fusion.trends.dimensionPanel")} hint={t("fusion.trends.dimensionPanelHint")}>
        <div className={s.controls}>
          {/* Native selects: the platform picker, the keyboard and the change event are
              worth more here than a drawn listbox, and the shared control face keeps them
              visually identical to every other field. */}
          <Field label={t("fusion.trends.range")} className={s.control}>
            <select
              aria-label={t("fusion.trends.rangeAria")}
              className={s.select}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            >
              {["1", "7", "30", "90"].map((value) => (
                <option value={value} key={value}>
                  {t("fusion.trends.lastDays", { days: value })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("fusion.trends.granularity")} className={s.control}>
            <select
              aria-label={t("fusion.trends.granularityAria")}
              className={s.select}
              value={granularity}
              onChange={(e) => setGranularity(e.target.value)}
            >
              <option value="auto">{t("fusion.trends.grain.auto")}</option>
              <option value="hour">{t("fusion.trends.grain.hour")}</option>
              <option value="day">{t("fusion.trends.grain.day")}</option>
            </select>
          </Field>
          <Field label={t("fusion.trends.dimension")} className={s.control}>
            <select
              aria-label={t("fusion.trends.dimensionAria")}
              className={s.select}
              value={dimension}
              onChange={(e) => {
                setDimension(e.target.value as Dimension);
                setKey("");
              }}
            >
              <option value="global">{t("fusion.trends.dim.global")}</option>
              <option value="model">{t("fusion.trends.dim.model")}</option>
              <option value="profile">{t("fusion.trends.dim.profile")}</option>
              <option value="credential">{t("fusion.trends.dim.credential")}</option>
            </select>
          </Field>
          {dimension !== "global" && (
            <Field label={objectLabel} className={s.control}>
              {dimensions.loading ? (
                <select aria-label={t("fusion.trends.objectAria")} className={s.select} disabled>
                  <option>{t("fusion.common.loading")}</option>
                </select>
              ) : (
                <select
                  aria-label={t("fusion.trends.objectAria")}
                  className={s.select}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  disabled={!dimensions.data?.items.length}
                >
                  {!dimensions.data?.items.length && (
                    <option value="">{t("fusion.trends.noObjects")}</option>
                  )}
                  {dimensions.data?.items.map((item) => (
                    <option value={item.key} key={item.key}>
                      {item.label ?? item.key}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          )}
          {/* A tablist: it switches which chart is drawn. aria-selected is the state, and
              the button paints it (colour + underline) — no separate highlight layer. */}
          <div className={s.tabs} role="tablist" aria-label={t("fusion.trends.metricAria")}>
            {(
              [
                ["requests", t("fusion.trends.metric.requests")],
                ["latency", t("fusion.trends.metric.latency")],
                ["rate", t("fusion.trends.metric.rate")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={metricMode === value}
                className={s.tab}
                onClick={() => setMetricMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {skipped > 0 && (
          <p className={s.muted} role="status">
            {t("fusion.trends.dimensionsSkipped", { n: skipped })}
          </p>
        )}
        <ErrorNotice
          message={dimensions.error}
          retry={{ label: t("common.retry"), onClick: dimensions.reload }}
        />
      </Panel>

      {stats.length > 0 && (
        <div className={s.stats}>
          {stats.map((stat) => (
            <section className={s.stat} key={stat.label}>
              <div className={s.statHead}>
                <span className={s.statLabel}>{stat.label}</span>
                <span className={s.statIcon} aria-hidden="true">
                  <Icon name={stat.icon} size="sm" />
                </span>
              </div>
              <strong className={s.statValue}>{stat.value}</strong>
              {stat.hint ? <small className={s.statHint}>{stat.hint}</small> : null}
            </section>
          ))}
        </div>
      )}

      <Panel
        title={t("fusion.trends.chartPanel")}
        hint={
          series.data
            ? t("fusion.trends.chartHint", {
                grain:
                  actualGrain === "hour"
                    ? t("fusion.trends.grain.hour")
                    : t("fusion.trends.grain.day"),
                selection: selection?.label ?? key ?? t("fusion.trends.dim.global"),
              })
            : t("fusion.trends.awaitingData")
        }
      >
        {series.error ? (
          <ErrorNotice
            message={series.error}
            retry={{ label: t("common.retry"), onClick: series.reload }}
          />
        ) : series.loading ? (
          <Skeleton variant="chart" label={t("fusion.trends.chartLoading")} />
        ) : !rows.length ? (
          <Empty title={t("fusion.trends.noSamples")} />
        ) : metricMode === "requests" ? (
          <StackedBars rows={buckets} granularity={actualGrain} />
        ) : (
          <LineChart
            rows={buckets}
            granularity={actualGrain}
            metrics={metricMode === "latency" ? percentiles : rateMetric()}
            emptyTitle={
              metricMode === "latency"
                ? t("fusion.trends.noPercentileSamples")
                : t("fusion.trends.noRateSamples")
            }
          />
        )}
      </Panel>

      <Panel
        title={t("fusion.trends.buckets")}
        hint={series.data ? t("fusion.trends.bucketCount", { count: rows.length }) : undefined}
      >
        {series.loading ? (
          <Skeleton variant="table" label={t("fusion.trends.bucketsLoading")} />
        ) : series.error ? (
          <Empty title={t("fusion.trends.bucketsUnavailable")}>
            {t("fusion.trends.bucketsUnavailableHint")}
          </Empty>
        ) : rows.length ? (
          // Six columns is more than a phone can show side by side, so the shared table
          // takes over: sticky header, card rows below 900px, no clipped P50/P95 column
          // (P1-2 on this page).
          <Table
            columns={bucketColumns()}
            rows={bucketRows}
            rowKey={(row) => String(row.key)}
            label={t("fusion.trends.buckets")}
            scroll
          />
        ) : (
          <Empty title={t("fusion.trends.noBuckets")} />
        )}
      </Panel>
    </Page>
  );
}
