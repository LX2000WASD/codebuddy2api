// SVG charts for the fusion views, hand-rolled to stay dependency-free.
// Design inherited from workbuddy2api-panel's usage chart (real time axis, gradient
// stacked bars, mean reference line, peak annotation, per-bucket hover detail) and
// rewritten as accessible React components with keyboard navigation.
import { useId, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { metric, number, type RecordValue } from "./api";
import { Empty } from "./components";
import s from "./ui.module.scss";

export type ChartBucket = RecordValue & {
  bucket: number;
  date: string;
};

const PLOT = { width: 1160, height: 220, left: 58, right: 16, top: 26, bottom: 30 };
const inner = () => ({
  width: PLOT.width - PLOT.left - PLOT.right,
  height: PLOT.height - PLOT.top - PLOT.bottom,
});
const fmtTime = (bucket: number, granularity: string) => {
  const date = new Date(bucket * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return granularity === "hour"
    ? `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
    : `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};
const fmtDayLabel = (bucket: number) => {
  const date = new Date(bucket * 1000);
  return `${date.getUTCMonth() + 1}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

type Axis = { xOf: (index: number) => number; indexes: number[]; barWidth: number };

function useSelection(rows: ChartBucket[]): {
  active: number | null;
  pointer: (event: PointerEvent<SVGSVGElement>) => void;
  keyDown: (event: KeyboardEvent<SVGSVGElement>) => void;
  blur: () => void;
  focus: () => void;
} {
  const [selection, setSelection] = useState<{ rows: ChartBucket[]; index: number } | null>(null);
  const active = selection?.rows === rows ? selection.index : null;
  const choose = (index: number) =>
    setSelection({ rows, index: Math.max(0, Math.min(rows.length - 1, index)) });
  const xFor = (clientX: number, rect: DOMRect) => {
    if (!rect.width) return 0;
    return ((clientX - rect.left) * PLOT.width) / rect.width;
  };
  return {
    active,
    pointer: (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = xFor(event.clientX, rect);
      const index = nearestIndex(rows, x);
      if (index !== null) choose(index);
    },
    keyDown: (event) => {
      if (event.key === "Escape") {
        setSelection(null);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      choose(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : (active ?? 0) + (event.key === "ArrowRight" ? 1 : -1),
      );
    },
    blur: () => setSelection(null),
    focus: () => choose(active ?? 0),
  };
}

const nearestIndex = (rows: ChartBucket[], plotX: number) => {
  if (!rows.length) return null;
  const layout = timeLayout(rows);
  let closest = 0;
  for (let i = 1; i < rows.length; i++)
    if (Math.abs(layout.xOf(i) - plotX) < Math.abs(layout.xOf(closest) - plotX)) closest = i;
  return closest;
};

function timeLayout(rows: ChartBucket[]): Axis {
  const box = inner();
  if (rows.length < 2) return { xOf: () => PLOT.left + box.width / 2, indexes: [0], barWidth: 14 };
  const buckets = rows.map((row) => number(row.bucket));
  const first = buckets[0] ?? 0;
  const last = buckets.at(-1) ?? 0;
  const span = Math.max(1, last - first);
  const minGap = Math.min(
    ...buckets.slice(1).map((value, index) => Math.max(1, (value ?? 0) - (buckets[index] ?? 0))),
  );
  const barWidth = Math.max(2, Math.min(28, box.width * (minGap / span) * 0.72));
  const xOf = (index: number) =>
    PLOT.left +
    barWidth / 2 +
    ((buckets[index]! - first) / span) * Math.max(1, box.width - barWidth);
  // ~6 ticks snapped to real buckets, first/last anchored to the edges.
  const tickCount = Math.min(6, rows.length);
  const indexes = Array.from({ length: tickCount }, (_, step) => {
    const target = first + (span * step) / (tickCount - 1 || 1);
    let best = 0;
    for (let index = 1; index < rows.length; index++)
      if (Math.abs((buckets[index] ?? 0) - target) < Math.abs((buckets[best] ?? 0) - target))
        best = index;
    return best;
  });
  return { xOf, indexes: [...new Set(indexes)], barWidth };
}

function ChartFrame({
  children,
  onPointer,
  onKeyDown,
  onBlur,
  onFocus,
  label,
  hintId,
}: {
  children: ReactNode;
  onPointer: (event: PointerEvent<SVGSVGElement>) => void;
  onKeyDown: (event: KeyboardEvent<SVGSVGElement>) => void;
  onBlur: () => void;
  onFocus: () => void;
  label: string;
  hintId: string;
}) {
  return (
    <div className={s.chartInteractive}>
      <svg
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        preserveAspectRatio="xMidYMid meet"
        className={s.chartWide}
        role="img"
        tabIndex={0}
        aria-label={label}
        aria-describedby={hintId}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={(event) => {
          // Touch sessions keep the last bucket; mouse/pen clear the detail row.
          if (event.pointerType !== "touch") onBlur();
        }}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      >
        {children}
      </svg>
      <p className={s.srOnly} id={hintId}>
        指向或点按查看时段；键盘左右方向键逐点查看，Home 和 End 跳到首尾，Esc 关闭提示。
      </p>
    </div>
  );
}

function GridLines() {
  const box = inner();
  return (
    <>
      {[0, 1, 2, 3, 4].map((step) => {
        const y = PLOT.top + box.height - (box.height * step) / 4;
        return (
          <line
            key={step}
            x1={PLOT.left}
            y1={y}
            x2={PLOT.width - PLOT.right}
            y2={y}
            stroke="var(--line)"
            strokeDasharray="4 5"
          />
        );
      })}
    </>
  );
}

function YTicks({ max, format }: { max: number; format: (value: number) => string }) {
  const box = inner();
  return (
    <>
      {[0, 1, 2, 3, 4].map((step) => {
        const y = PLOT.top + box.height - (box.height * step) / 4;
        return (
          <text key={step} x={PLOT.left - 8} y={y + 4} textAnchor="end" className={s.chartTick}>
            {format((max * step) / 4)}
          </text>
        );
      })}
    </>
  );
}

function XAxis({
  rows,
  granularity,
  layout,
}: {
  rows: ChartBucket[];
  granularity: string;
  layout: Axis;
}) {
  const box = inner();
  return (
    <>
      <line
        x1={PLOT.left}
        y1={PLOT.top + box.height}
        x2={PLOT.width - PLOT.right}
        y2={PLOT.top + box.height}
        stroke="var(--line)"
      />
      {layout.indexes.map((index) => {
        const bucket = number(rows[index]?.bucket);
        if (bucket === null) return null;
        const x = layout.xOf(index);
        const anchor =
          x < PLOT.left + 16 ? "start" : x > PLOT.width - PLOT.right - 16 ? "end" : "middle";
        return (
          <text
            key={index}
            x={Math.max(PLOT.left, Math.min(PLOT.width - PLOT.right, x))}
            y={PLOT.top + box.height + 17}
            textAnchor={anchor}
            className={s.chartTick}
          >
            {granularity === "hour" ? fmtTime(bucket, granularity) : fmtDayLabel(bucket)}
          </text>
        );
      })}
    </>
  );
}

/**
 * Stacked request bars: success + error share one bar, gradient-filled, with the
 * window mean as a dashed reference line and the peak annotated. Hover or keyboard
 * focus shows the full per-bucket breakdown.
 */
export function StackedBars({
  rows,
  granularity = "day",
  emptyTitle,
}: {
  rows: ChartBucket[];
  granularity?: string;
  emptyTitle?: string;
}) {
  const id = useId();
  const selection = useSelection(rows);
  if (!rows.length) return <Empty title={emptyTitle ?? "当前时间范围内暂无请求"} />;
  const box = inner();
  const layout = timeLayout(rows);
  const values = rows.map((row) => ({
    requests: number(row.requests) ?? 0,
    success: number(row.success) ?? 0,
    error: number(row.error) ?? 0,
  }));
  const totals = values.map((value) => value.success + value.error);
  const max = Math.max(1, ...totals);
  const mean = totals.reduce((sum, value) => sum + value, 0) / totals.length;
  const peakIndex = totals.reduce(
    (best, value, index) => (value > totals[best]! ? index : best),
    0,
  );
  const yOf = (value: number) => PLOT.top + box.height - box.height * (value / max);
  const active = selection.active;
  const selected = active === null ? null : rows[active];

  return (
    <>
      <ChartFrame
        label={granularity === "hour" ? "按小时请求量" : "按日请求量"}
        hintId={`${id}-hint`}
        onPointer={selection.pointer}
        onKeyDown={selection.keyDown}
        onBlur={selection.blur}
        onFocus={selection.focus}
      >
        <defs>
          <linearGradient id={`${id}-ok`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--accent)", stopOpacity: 1 }} />
            <stop offset="1" style={{ stopColor: "var(--accent)", stopOpacity: 0.62 }} />
          </linearGradient>
          <linearGradient id={`${id}-err`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--error)", stopOpacity: 1 }} />
            <stop offset="1" style={{ stopColor: "var(--error)", stopOpacity: 0.62 }} />
          </linearGradient>
        </defs>
        <GridLines />
        <YTicks max={max} format={(value) => metric(value)} />
        {rows.map((row, index) => {
          const x = layout.xOf(index) - layout.barWidth / 2;
          const total = totals[index]!;
          const successHeight = total ? box.height * (values[index]!.success / max) : 0;
          const errorHeight = total
            ? Math.max(values[index]!.error ? 1.5 : 0, box.height * (total / max) - successHeight)
            : 0;
          return (
            <g key={index}>
              <title>
                {`${row.date} 请求 ${metric(total)} / 成功 ${metric(values[index]!.success)} / 失败 ${metric(values[index]!.error)}`}
              </title>
              {successHeight > 0 && (
                <rect
                  x={x}
                  y={PLOT.top + box.height - successHeight - errorHeight}
                  width={layout.barWidth}
                  height={successHeight}
                  fill={`url(#${id}-ok)`}
                  rx={errorHeight > 0 ? 0 : 1.5}
                />
              )}
              {errorHeight > 0 && (
                <rect
                  x={x}
                  y={PLOT.top + box.height - errorHeight}
                  width={layout.barWidth}
                  height={errorHeight}
                  fill={`url(#${id}-err)`}
                  rx={1.5}
                />
              )}
            </g>
          );
        })}
        {mean > 0 && mean < max && (
          <>
            <line
              x1={PLOT.left}
              y1={yOf(mean)}
              x2={PLOT.width - PLOT.right}
              y2={yOf(mean)}
              stroke="var(--strong)"
              strokeDasharray="7 6"
            />
            <text x={PLOT.left + 6} y={yOf(mean) - 5} textAnchor="start" className={s.chartMean}>
              均值 {metric(mean)}
            </text>
          </>
        )}
        {totals[peakIndex]! > 0 && (
          <text
            x={Math.max(PLOT.left, Math.min(PLOT.width - PLOT.right, layout.xOf(peakIndex)))}
            y={Math.max(12, yOf(totals[peakIndex]!) - 6)}
            textAnchor={layout.xOf(peakIndex) > PLOT.width - PLOT.right - 90 ? "end" : "middle"}
            className={s.chartPeak}
          >
            峰值 {metric(totals[peakIndex]!)}
          </text>
        )}
        {active !== null && (
          <g aria-hidden="true">
            <line
              x1={layout.xOf(active)}
              x2={layout.xOf(active)}
              y1={PLOT.top - 6}
              y2={PLOT.top + box.height}
              stroke="var(--accent)"
              strokeDasharray="3 4"
            />
            <circle
              cx={layout.xOf(active)}
              cy={yOf(totals[active]!)}
              r={5}
              fill="var(--surface)"
              stroke="var(--accent)"
              strokeWidth={3}
            />
          </g>
        )}
        <XAxis rows={rows} granularity={granularity} layout={layout} />
      </ChartFrame>
      {selected && active !== null && (
        <div className={s.chartDetailRow} role="status">
          <div>
            <strong>{selected.date}</strong>
            <span>请求 {metric(selected.requests)}</span>
            <span>成功 {metric(selected.success)}</span>
            <span>失败 {metric(selected.error)}</span>
            <span>Token {metric(selected.total_tokens)}</span>
            {number(selected.tokens_per_s) !== null && (
              <span>{metric(selected.tokens_per_s)} tok/s</span>
            )}
          </div>
        </div>
      )}
    </>
  );
}

export type LineMetric = {
  key: string;
  label: string;
  unit: string;
  color: "accent" | "strong" | "error" | "warning";
};

const COLORS: Record<LineMetric["color"], string> = {
  accent: "var(--accent)",
  strong: "var(--strong)",
  error: "var(--error)",
  warning: "var(--warning)",
};

/**
 * Multi-series line chart for latency quantiles or generation rate. Null values
 * break the line instead of being plotted as zero (unknown ≠ zero); legend buttons
 * toggle a series without hiding it from the detail row or the aria description.
 */
export function LineChart({
  rows,
  granularity = "day",
  metrics,
  emptyTitle,
}: {
  rows: ChartBucket[];
  granularity?: string;
  metrics: LineMetric[];
  emptyTitle?: string;
}) {
  const id = useId();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const selection = useSelection(rows);
  if (!rows.length) return <Empty title={emptyTitle ?? "当前时间范围内暂无样本"} />;
  const box = inner();
  const layout = timeLayout(rows);
  const values = rows.map((row) =>
    metrics.map((metricDef) => (number(row[metricDef.key]) ?? null) as number | null),
  );
  const observed = values.flat().filter((value): value is number => value !== null);
  if (!observed.length) return <Empty title="当前样本不足，无法计算分位数" />;
  const max = Math.max(1, ...observed);
  const yOf = (value: number) => PLOT.top + box.height - box.height * (value / max);
  const active = selection.active;
  const selected = active === null ? null : rows[active];

  const segment = (metricIndex: number) => {
    const points: Array<[number, number]> = [];
    const segments: Array<Array<[number, number]>> = [];
    values.forEach((row, index) => {
      const value = row[metricIndex];
      if (value === null) {
        if (points.length) segments.push(points.splice(0, points.length));
        return;
      }
      points.push([layout.xOf(index), yOf(value)]);
    });
    if (points.length) segments.push(points);
    return segments;
  };

  return (
    <>
      <div className={s.legend} role="group" aria-label="曲线图例">
        {metrics.map((metricDef, metricIndex) => {
          const off = hidden.has(metricDef.key);
          const known = values.filter((row) => row[metricIndex] !== null).length;
          return (
            <button
              key={metricDef.key}
              type="button"
              aria-pressed={!off}
              className={off ? s.legendOff : s.legendOn}
              onClick={() =>
                setHidden((old) => {
                  if (!old.has(metricDef.key)) {
                    const next = new Set(old);
                    next.add(metricDef.key);
                    // Keep at least one series visible.
                    return next.size === metrics.length ? old : next;
                  }
                  const next = new Set(old);
                  next.delete(metricDef.key);
                  return next;
                })
              }
            >
              <span style={{ background: COLORS[metricDef.color] }} />
              {metricDef.label}
              <small>已知 {known} 桶</small>
            </button>
          );
        })}
      </div>
      <ChartFrame
        label="延迟分位数曲线"
        hintId={`${id}-hint`}
        onPointer={selection.pointer}
        onKeyDown={selection.keyDown}
        onBlur={selection.blur}
        onFocus={selection.focus}
      >
        <GridLines />
        <YTicks max={max} format={(value) => metric(value)} />
        {metrics.map((metricDef) => {
          if (hidden.has(metricDef.key)) return null;
          const metricIndex = metrics.indexOf(metricDef);
          return segment(metricIndex).map((points, segmentIndex) => (
            <polyline
              key={`${metricDef.key}-${segmentIndex}`}
              points={points.map(([x, y]) => `${x},${y}`).join(" ")}
              stroke={COLORS[metricDef.color]}
              strokeWidth={2.6}
              fill="none"
            />
          ));
        })}
        {active !== null && (
          <g aria-hidden="true">
            <line
              x1={layout.xOf(active)}
              x2={layout.xOf(active)}
              y1={PLOT.top - 6}
              y2={PLOT.top + box.height}
              stroke="var(--muted)"
              strokeDasharray="3 4"
            />
            {metrics.map((metricDef, metricIndex) => {
              const value = values[active]![metricIndex];
              if (value === null || hidden.has(metricDef.key)) return null;
              return (
                <circle
                  key={metricDef.key}
                  cx={layout.xOf(active)}
                  cy={yOf(value)}
                  r={4.5}
                  fill="var(--surface)"
                  stroke={COLORS[metricDef.color]}
                  strokeWidth={2.5}
                />
              );
            })}
          </g>
        )}
        <XAxis rows={rows} granularity={granularity} layout={layout} />
      </ChartFrame>
      {selected && active !== null && (
        <div className={s.chartDetailRow} role="status">
          <div>
            <strong>{selected.date}</strong>
            {metrics.map((metricDef, metricIndex) => {
              const value = values[active]![metricIndex];
              return (
                <span
                  key={metricDef.key}
                  style={{ color: hidden.has(metricDef.key) ? "var(--muted)" : undefined }}
                >
                  {metricDef.label} {value === null ? "未知" : `${metric(value)} ${metricDef.unit}`}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
