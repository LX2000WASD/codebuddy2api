import { useEffect, useState } from "react";
import { list, metric, number, object, text } from "../api";
import { LineChart, StackedBars, type ChartBucket } from "../charts";
import { Badge, Empty, ErrorNotice, Icon, PageTitle, Panel, Skeleton } from "../components";
import { useFusionResource } from "../fusion/client";
import { FUSION_DEVELOPMENT } from "../fusion/client";
import type { StatsSeriesResponse } from "../fusion/types";
import s from "../ui.module.scss";

type Dimension = "global" | "model" | "profile" | "credential";
type MetricMode = "requests" | "latency" | "rate";

function normalizeSeries(value: unknown): StatsSeriesResponse {
  const data = object(value, "统计序列");
  if (!Array.isArray(data.series)) throw new Error("统计序列缺失");
  const series = list(data.series, "统计序列").map((row) => {
    if (number(row.bucket) === null) throw new Error("统计时段缺失");
    return row;
  });
  return { ...(data as StatsSeriesResponse), series: series as StatsSeriesResponse["series"] };
}

function normalizeDimensions(value: unknown): {
  items: Array<{ key: string; label: string | null }>;
} {
  const data = object(value, "维度列表");
  const items = list(data.items, "维度列表").map((item) => {
    if (typeof item.key !== "string" || !item.key) throw new Error("维度条目缺少 key");
    return { key: item.key, label: typeof item.label === "string" ? item.label : null };
  });
  return { items };
}

const percentiles = [
  { key: "latency_p50_ms", label: "P50", unit: "ms", color: "accent" as const },
  { key: "latency_p95_ms", label: "P95", unit: "ms", color: "strong" as const },
  { key: "latency_p99_ms", label: "P99", unit: "ms", color: "error" as const },
];
const rateMetric = [
  { key: "tokens_per_s", label: "生成速率", unit: "tok/s", color: "accent" as const },
];

export function Trends() {
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
  const successRate =
    summary && summary.requests ? (summary.success / summary.requests) * 100 : null;
  const selection = dimensions.data?.items.find((item) => item.key === key);

  return (
    <>
      <PageTitle
        title="趋势分析"
        description="按账号、模型或产品切分的请求量趋势与延迟分位曲线，数据来自审计聚合。"
        actions={
          <>
            {FUSION_DEVELOPMENT && <Badge tone="warn">本地演示数据</Badge>}
            <button onClick={() => series.reload()} disabled={series.loading}>
              <Icon name="refresh" />
              刷新
            </button>
          </>
        }
      />
      <Panel title="切分维度" hint="仅在此页打开时请求统计接口">
        <div className={s.fusionControls}>
          <label className={s.field}>
            时间范围
            <select
              aria-label="统计时间范围"
              value={days}
              onChange={(e) => setDays(e.target.value)}
            >
              {["1", "7", "30", "90"].map((value) => (
                <option value={value} key={value}>
                  最近 {value} 天
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            粒度
            <select
              aria-label="统计粒度"
              value={granularity}
              onChange={(e) => setGranularity(e.target.value)}
            >
              <option value="auto">自动粒度</option>
              <option value="hour">按小时</option>
              <option value="day">按天</option>
            </select>
          </label>
          <label className={s.field}>
            维度
            <select
              aria-label="切分维度"
              value={dimension}
              onChange={(e) => {
                setDimension(e.target.value as Dimension);
                setKey("");
              }}
            >
              <option value="global">全局汇总</option>
              <option value="model">按模型</option>
              <option value="profile">按产品</option>
              <option value="credential">按账号</option>
            </select>
          </label>
          {dimension !== "global" && (
            <label className={s.field}>
              {dimension === "credential" ? "账号" : dimension === "profile" ? "产品" : "模型"}
              {dimensions.loading ? (
                <select aria-label="切分对象" disabled>
                  <option>加载中…</option>
                </select>
              ) : (
                <select
                  aria-label="切分对象"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  disabled={!dimensions.data?.items.length}
                >
                  {!dimensions.data?.items.length && <option value="">暂无可用对象</option>}
                  {dimensions.data?.items.map((item) => (
                    <option value={item.key} key={item.key}>
                      {item.label ?? item.key}
                    </option>
                  ))}
                </select>
              )}
            </label>
          )}
          <div className={s.tabs} role="tablist" aria-label="指标">
            {(
              [
                ["requests", "请求量"],
                ["latency", "延迟分位"],
                ["rate", "生成速率"],
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
        <ErrorNotice message={dimensions.error} retry={dimensions.reload} />
      </Panel>

      {summary && (
        <div className={s.stats}>
          {[
            ["窗口请求", metric(summary.requests), "arrow"],
            ["成功率", successRate === null ? "未知" : `${successRate.toFixed(1)}%`, "shield"],
            [
              "P95 延迟",
              summary.latency_p95_ms === null ? "样本不足" : `${metric(summary.latency_p95_ms)} ms`,
              "pulse",
            ],
            [
              "生成速率",
              summary.tokens_per_s === null ? "未知" : `${metric(summary.tokens_per_s)} tok/s`,
              "model",
            ],
            ["Credit", metric(summary.credit), "leaf"],
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
        title="趋势曲线"
        hint={
          series.data
            ? `${actualGrain === "hour" ? "按小时" : "按天"} · ${selection?.label ?? key ?? "全局"}`
            : "等待数据"
        }
        className={s.trend}
      >
        {series.error ? (
          <ErrorNotice message={series.error} retry={series.reload} />
        ) : series.loading ? (
          <Skeleton variant="chart" label="趋势图加载中" />
        ) : !rows.length ? (
          <Empty title="当前范围内没有样本" />
        ) : metricMode === "requests" ? (
          <StackedBars rows={buckets} granularity={actualGrain} />
        ) : (
          <LineChart
            rows={buckets}
            granularity={actualGrain}
            metrics={metricMode === "latency" ? percentiles : rateMetric}
            emptyTitle={metricMode === "latency" ? "样本不足，无法计算分位" : "暂无生成速率样本"}
          />
        )}
      </Panel>

      <Panel title="分桶明细" hint={series.data ? `${rows.length} 个时段` : undefined}>
        {series.loading ? (
          <Skeleton variant="table" label="明细加载中" />
        ) : series.error ? (
          <Empty title="明细暂不可用">请在上方查看错误详情。</Empty>
        ) : rows.length ? (
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>时段（UTC）</th>
                  <th>请求</th>
                  <th>成功 / 失败</th>
                  <th>P50 / P95 / P99</th>
                  <th>生成速率</th>
                  <th>Token</th>
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
          <Empty title="暂无分桶数据" />
        )}
      </Panel>
    </>
  );
}
