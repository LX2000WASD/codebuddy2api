// SVG charts for the fusion views, hand-rolled to stay dependency-free.
// Design inherited from workbuddy2api-panel's usage chart (real time axis, gradient
// stacked bars, mean reference line, peak annotation, per-bucket hover detail) and
// rewritten as accessible React components with keyboard navigation.
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { metric, number, type RecordValue } from "./api";
import { Empty } from "./components";
import { t } from "./i18n";
import s from "./ui.module.scss";

export type ChartBucket = RecordValue & {
  bucket: number;
  date: string;
};

// The viewBox is derived from the measured container width (1 user unit = 1 CSS px)
// instead of a fixed 1160×220 canvas. A fixed canvas scaled into a phone-width card
// shrank the 11px tick labels to ~4px and letterboxed the plot; matching the box
// keeps text at its designed size on every viewport while the geometry stays
// unscaled (no stretched strokes or distorted bars).
const PLOT_HEIGHT = 220;
const PLOT_TOP = 26;
const PLOT_BOTTOM = 30;
const PLOT_LEFT = 58;
const PLOT_RIGHT = 16;
const NARROW_LEFT = 44;
const NARROW_RIGHT = 10;
const NARROW_WIDTH = 520;
// First-render fallback only: the layout effect measures the real box before paint.
const DEFAULT_WIDTH = 1160;
const MIN_WIDTH = 240;

type Plot = {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

const plotFor = (width: number): Plot => {
  const narrow = width < NARROW_WIDTH;
  return {
    width,
    height: PLOT_HEIGHT,
    left: narrow ? NARROW_LEFT : PLOT_LEFT,
    right: narrow ? NARROW_RIGHT : PLOT_RIGHT,
    top: PLOT_TOP,
    bottom: PLOT_BOTTOM,
  };
};

const inner = (plot: Plot) => ({
  width: plot.width - plot.left - plot.right,
  height: plot.height - plot.top - plot.bottom,
});

// An outermost <svg> lays its viewBox out in the content box, so the stylesheet
// padding on .chartWide is excluded from both the scale and the pointer origin.
function contentBox(svg: SVGSVGElement): { left: number; width: number } {
  const rect = svg.getBoundingClientRect();
  const style = getComputedStyle(svg);
  const left = parseFloat(style.paddingLeft) || 0;
  const right = parseFloat(style.paddingRight) || 0;
  return { left: rect.left + left, width: Math.max(0, rect.width - left - right) };
}

/** Tracks the rendered width so the viewBox can match the SVG viewport exactly. */
function usePlot(): { ref: RefObject<SVGSVGElement | null>; plot: Plot } {
  const ref = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const sync = () => {
      const measured = contentBox(element).width;
      // jsdom reports 0 for layout; keep the fallback there instead of collapsing.
      if (measured > 0) setWidth(Math.max(MIN_WIDTH, Math.round(measured)));
    };
    sync();
    if (typeof ResizeObserver === "undefined") return;
    // contentRect is the content box, matching the SVG viewport above.
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) setWidth(Math.max(MIN_WIDTH, Math.round(measured)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, plot: plotFor(width) };
}

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

function useSelection(
  rows: ChartBucket[],
  plot: Plot,
): {
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
  const xFor = (clientX: number, svg: SVGSVGElement) => {
    const box = contentBox(svg);
    if (!box.width) return 0;
    return ((clientX - box.left) * plot.width) / box.width;
  };
  return {
    active,
    pointer: (event) => {
      const x = xFor(event.clientX, event.currentTarget);
      const index = nearestIndex(rows, x, plot);
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

const nearestIndex = (rows: ChartBucket[], plotX: number, plot: Plot) => {
  if (!rows.length) return null;
  const layout = timeLayout(rows, plot);
  let closest = 0;
  for (let i = 1; i < rows.length; i++)
    if (Math.abs(layout.xOf(i) - plotX) < Math.abs(layout.xOf(closest) - plotX)) closest = i;
  return closest;
};

function timeLayout(rows: ChartBucket[], plot: Plot): Axis {
  const box = inner(plot);
  if (rows.length < 2) return { xOf: () => plot.left + box.width / 2, indexes: [0], barWidth: 14 };
  const buckets = rows.map((row) => number(row.bucket));
  const first = buckets[0] ?? 0;
  const last = buckets.at(-1) ?? 0;
  const span = Math.max(1, last - first);
  const minGap = Math.min(
    ...buckets.slice(1).map((value, index) => Math.max(1, (value ?? 0) - (buckets[index] ?? 0))),
  );
  const barWidth = Math.max(2, Math.min(28, box.width * (minGap / span) * 0.72));
  const xOf = (index: number) =>
    plot.left +
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
  plot,
  frameRef,
  onPointer,
  onKeyDown,
  onBlur,
  onFocus,
  label,
  hintId,
}: {
  children: ReactNode;
  plot: Plot;
  frameRef: RefObject<SVGSVGElement | null>;
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
        ref={frameRef}
        viewBox={`0 0 ${plot.width} ${plot.height}`}
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
        {t("fusion.charts.keyboardHint")}
      </p>
    </div>
  );
}

function GridLines({ plot }: { plot: Plot }) {
  const box = inner(plot);
  return (
    <>
      {[0, 1, 2, 3, 4].map((step) => {
        const y = plot.top + box.height - (box.height * step) / 4;
        return (
          <line
            key={step}
            x1={plot.left}
            y1={y}
            x2={plot.width - plot.right}
            y2={y}
            stroke="var(--line)"
            strokeDasharray="4 5"
          />
        );
      })}
    </>
  );
}

function YTicks({
  plot,
  max,
  format,
}: {
  plot: Plot;
  max: number;
  format: (value: number) => string;
}) {
  const box = inner(plot);
  return (
    <>
      {[0, 1, 2, 3, 4].map((step) => {
        const y = plot.top + box.height - (box.height * step) / 4;
        return (
          <text key={step} x={plot.left - 8} y={y + 4} textAnchor="end" className={s.chartTick}>
            {format((max * step) / 4)}
          </text>
        );
      })}
    </>
  );
}

function XAxis({
  plot,
  rows,
  granularity,
  layout,
}: {
  plot: Plot;
  rows: ChartBucket[];
  granularity: string;
  layout: Axis;
}) {
  const box = inner(plot);
  return (
    <>
      <line
        x1={plot.left}
        y1={plot.top + box.height}
        x2={plot.width - plot.right}
        y2={plot.top + box.height}
        stroke="var(--line)"
      />
      {layout.indexes.map((index) => {
        const bucket = number(rows[index]?.bucket);
        if (bucket === null) return null;
        const x = layout.xOf(index);
        const anchor =
          x < plot.left + 16 ? "start" : x > plot.width - plot.right - 16 ? "end" : "middle";
        return (
          <text
            key={index}
            x={Math.max(plot.left, Math.min(plot.width - plot.right, x))}
            y={plot.top + box.height + 17}
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
  const { ref, plot } = usePlot();
  const selection = useSelection(rows, plot);
  if (!rows.length) return <Empty title={emptyTitle ?? t("fusion.charts.noRequestsInRange")} />;
  const box = inner(plot);
  const layout = timeLayout(rows, plot);
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
  const yOf = (value: number) => plot.top + box.height - box.height * (value / max);
  const active = selection.active;
  const selected = active === null ? null : rows[active];

  return (
    <>
      <ChartFrame
        plot={plot}
        frameRef={ref}
        label={
          granularity === "hour"
            ? t("fusion.charts.hourlyRequests")
            : t("fusion.charts.dailyRequests")
        }
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
        <GridLines plot={plot} />
        <YTicks plot={plot} max={max} format={(value) => metric(value)} />
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
                {t("fusion.charts.bucketTooltip", {
                  date: row.date,
                  requests: metric(total),
                  success: metric(values[index]!.success),
                  error: metric(values[index]!.error),
                })}
              </title>
              {successHeight > 0 && (
                <rect
                  x={x}
                  y={plot.top + box.height - successHeight - errorHeight}
                  width={layout.barWidth}
                  height={successHeight}
                  fill={`url(#${id}-ok)`}
                  rx={errorHeight > 0 ? 0 : 1.5}
                />
              )}
              {errorHeight > 0 && (
                <rect
                  x={x}
                  y={plot.top + box.height - errorHeight}
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
              x1={plot.left}
              y1={yOf(mean)}
              x2={plot.width - plot.right}
              y2={yOf(mean)}
              stroke="var(--strong)"
              strokeDasharray="7 6"
            />
            <text x={plot.left + 6} y={yOf(mean) - 5} textAnchor="start" className={s.chartMean}>
              {t("fusion.charts.mean", { value: metric(mean) })}
            </text>
          </>
        )}
        {totals[peakIndex]! > 0 && (
          <text
            x={Math.max(plot.left, Math.min(plot.width - plot.right, layout.xOf(peakIndex)))}
            y={Math.max(12, yOf(totals[peakIndex]!) - 6)}
            textAnchor={layout.xOf(peakIndex) > plot.width - plot.right - 90 ? "end" : "middle"}
            className={s.chartPeak}
          >
            {t("fusion.charts.peak", { value: metric(totals[peakIndex]!) })}
          </text>
        )}
        {active !== null && (
          <g aria-hidden="true">
            <line
              x1={layout.xOf(active)}
              x2={layout.xOf(active)}
              y1={plot.top - 6}
              y2={plot.top + box.height}
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
        <XAxis plot={plot} rows={rows} granularity={granularity} layout={layout} />
      </ChartFrame>
      {selected && active !== null && (
        <div className={s.chartDetailRow} role="status">
          <div>
            <strong>{selected.date}</strong>
            <span>{t("fusion.charts.detail.requests", { value: metric(selected.requests) })}</span>
            <span>{t("fusion.charts.detail.success", { value: metric(selected.success) })}</span>
            <span>{t("fusion.charts.detail.error", { value: metric(selected.error) })}</span>
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

type LineMetric = {
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
  const { ref, plot } = usePlot();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const selection = useSelection(rows, plot);
  if (!rows.length) return <Empty title={emptyTitle ?? t("fusion.charts.noSamplesInRange")} />;
  const box = inner(plot);
  const layout = timeLayout(rows, plot);
  const values = rows.map((row) =>
    metrics.map((metricDef) => (number(row[metricDef.key]) ?? null) as number | null),
  );
  const observed = values.flat().filter((value): value is number => value !== null);
  if (!observed.length) return <Empty title={t("fusion.charts.insufficientForPercentiles")} />;
  const max = Math.max(1, ...observed);
  const yOf = (value: number) => plot.top + box.height - box.height * (value / max);
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
      <div className={s.legend} role="group" aria-label={t("fusion.charts.legendAria")}>
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
              <small>{t("fusion.charts.knownBuckets", { count: known })}</small>
            </button>
          );
        })}
      </div>
      <ChartFrame
        plot={plot}
        frameRef={ref}
        label={t("fusion.charts.latencyPercentiles")}
        hintId={`${id}-hint`}
        onPointer={selection.pointer}
        onKeyDown={selection.keyDown}
        onBlur={selection.blur}
        onFocus={selection.focus}
      >
        <GridLines plot={plot} />
        <YTicks plot={plot} max={max} format={(value) => metric(value)} />
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
              y1={plot.top - 6}
              y2={plot.top + box.height}
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
        <XAxis plot={plot} rows={rows} granularity={granularity} layout={layout} />
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
                  {metricDef.label}{" "}
                  {value === null
                    ? t("fusion.common.unknown")
                    : `${metric(value)} ${metricDef.unit}`}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
