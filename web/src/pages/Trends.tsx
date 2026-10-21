import { useEffect, useState } from "react";
import { list, metric, number, object, text } from "../api";
import { LineChart, StackedBars, type ChartBucket } from "../charts";
import { Badge, Empty, ErrorNotice, Icon, PageTitle, Panel, Skeleton } from "../components";
import { useFusionResource } from "../fusion/client";
import { FUSION_DEVELOPMENT } from "../fusion/client";
import type { StatsSeriesResponse } from "../fusion/types";
import { t, useT } from "../i18n";
import s from "../ui.module.scss";

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

  return (
    <>
      <PageTitle
        title={t("nav.trends")}
        description={t("fusion.trends.pageDesc")}
        actions={
          <>
            {FUSION_DEVELOPMENT && <Badge tone="warn">{t("fusion.common.demoData")}</Badge>}
            <button onClick={() => series.reload()} disabled={series.loading}>
              <Icon name="refresh" />
              {t("fusion.common.refresh")}
            </button>
          </>
        }
      />
      <Panel title={t("fusion.trends.dimensionPanel")} hint={t("fusion.trends.dimensionPanelHint")}>
        <div className={s.fusionControls}>
          <label className={s.field}>
            {t("fusion.trends.range")}
            <select
              aria-label={t("fusion.trends.rangeAria")}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            >
              {["1", "7", "30", "90"].map((value) => (
                <option value={value} key={value}>
                  {t("fusion.trends.lastDays", { days: value })}
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            {t("fusion.trends.granularity")}
            <select
              aria-label={t("fusion.trends.granularityAria")}
              value={granularity}
              onChange={(e) => setGranularity(e.target.value)}
            >
              <option value="auto">{t("fusion.trends.grain.auto")}</option>
              <option value="hour">{t("fusion.trends.grain.hour")}</option>
              <option value="day">{t("fusion.trends.grain.day")}</option>
            </select>
          </label>
          <label className={s.field}>
            {t("fusion.trends.dimension")}
            <select
              aria-label={t("fusion.trends.dimensionAria")}
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
          </label>
          {dimension !== "global" && (
            <label className={s.field}>
              {dimension === "credential"
                ? t("fusion.trends.dim.credential")
                : dimension === "profile"
                  ? t("fusion.trends.dim.profile")
                  : t("fusion.trends.dim.model")}
              {dimensions.loading ? (
                <select aria-label={t("fusion.trends.objectAria")} disabled>
                  <option>{t("fusion.common.loading")}</option>
                </select>
              ) : (
                <select
                  aria-label={t("fusion.trends.objectAria")}
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
            </label>
          )}
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
                role="tab"
                aria-selected={metricMode === value}
                className={metricMode === value ? s.selectedTab : ""}
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
        <ErrorNotice message={dimensions.error} retry={dimensions.reload} />
      </Panel>

      {summary && (
        <div className={s.stats}>
          {[
            [t("fusion.trends.summary.requests"), metric(summary.requests), "arrow"],
            [
              t("fusion.trends.summary.successRate"),
              successRate === null ? t("fusion.common.unknown") : `${successRate.toFixed(1)}%`,
              "shield",
            ],
            [
              t("fusion.trends.summary.p95"),
              summary.latency_p95_ms === null
                ? t("fusion.trends.insufficientSamples")
                : `${metric(summary.latency_p95_ms)} ms · ${t("dash.p95Approx")}`,
              "pulse",
            ],
            [
              t("fusion.trends.summary.rate"),
              summary.tokens_per_s === null
                ? t("fusion.common.unknown")
                : `${metric(summary.tokens_per_s)} tok/s`,
              "model",
            ],
            [t("fusion.trends.summary.credit"), metric(summary.credit), "leaf"],
          ].map(([label, value, icon]) => (
            <section className={s.stat} key={label}>
              <div>
                {label}
                <span>
                  <Icon name={icon} />
                </span>
              </div>
              <strong>{value}</strong>
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
          <ErrorNotice message={series.error} retry={series.reload} />
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
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("fusion.trends.colBucket")}</th>
                  <th scope="col">{t("fusion.trends.colRequests")}</th>
                  <th scope="col">{t("fusion.trends.colSuccessError")}</th>
                  <th scope="col">P50 / P95 / P99</th>
                  <th scope="col">{t("fusion.trends.metric.rate")}</th>
                  <th scope="col">Token</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={index}>
                    <td>
                      <strong>{text(row.date)}</strong>
                    </td>
                    <td>{metric(row.requests)}</td>
                    <td>
                      {metric(row.success)} / {metric(row.error)}
                    </td>
                    <td>
                      {percentiles
                        .map((p) => (number(row[p.key]) === null ? "—" : `${metric(row[p.key])}ms`))
                        .join(" · ")}
                    </td>
                    <td>
                      {number(row.tokens_per_s) === null
                        ? "—"
                        : `${metric(row.tokens_per_s)} tok/s`}
                    </td>
                    <td>{metric(row.total_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t("fusion.trends.noBuckets")} />
        )}
      </Panel>
    </>
  );
}
