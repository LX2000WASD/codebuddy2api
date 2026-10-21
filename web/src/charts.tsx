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

/**
 * WCAG 1.4.1 (Use of Color) redundant encoding.
 *
 * Colour stays the primary channel, but every series also carries a stroke pattern
 * and a marker shape, so the chart survives greyscale printing, every kind of colour
 * vision deficiency, and the low-contrast dark themes. The two cycles are coprime
 * (6 x 4 = 12 distinct pairs), so the first six series never share a (dash, marker)
 * pair even though the palette repeats after six.
 */
export const SERIES_DASH = ["", "6 4", "2 4", "6 4 2 4", "10 4", "2 4 2 10"] as const;
export const SERIES_MARKERS = ["circle", "square", "triangle", "diamond"] as const;
export type SeriesMarkerShape = (typeof SERIES_MARKERS)[number];

/**
 * Per-point markers stay off for dense series: 24 hourly buckets x 3 series of
 * shapes reads as noise and hides the curve. Below this many buckets the shape is
 * the stronger cue, so it is drawn at every point as well as in the legend.
 */
const MARKER_MAX_POINTS = 14;

export const dashFor = (index: number): string => SERIES_DASH[index % SERIES_DASH.length]!;
export const markerFor = (index: number): SeriesMarkerShape =>
  SERIES_MARKERS[index % SERIES_MARKERS.length]!;

/** CSS preview of a dash pattern, for the HTML legend (the SVG legend is not an option). */
export function dashSwatch(color: string, dash: string): string {
  if (!dash) return color;
  const [on = "0", off = "0"] = dash.split(" ");
  return `repeating-linear-gradient(90deg, ${color} 0 ${on}px, transparent ${on}px ${Number(on) + Number(off)}px)`;
}

/**
 * A second data channel that survives greyscale. Rendered as path/polygon/circle
 * rather than <rect> on purpose: chart-readability.spec.ts measures the first
 * <rect> in the plot to prove the viewBox is not stretched, so markers must never
 * become the first rect in document order.
 */
function SeriesMarker({
  shape,
  x,
  y,
  size,
  fill,
  stroke,
  strokeWidth = 2,
}: {
  shape: SeriesMarkerShape;
  x: number;
  y: number;
  size: number;
  fill: string;
  stroke: string;
  strokeWidth?: number;
}) {
  if (shape === "square")
    return (
      <path
        d={`M${x - size} ${y - size} H${x + size} V${y + size} H${x - size} Z`}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );
  if (shape === "triangle")
    return (
      <polygon
        points={`${x},${y - size * 1.25} ${x + size * 1.15},${y + size * 0.85} ${x - size * 1.15},${y + size * 0.85}`}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );
  if (shape === "diamond")
    return (
      <polygon
        points={`${x},${y - size * 1.35} ${x + size * 1.35},${y} ${x},${y + size * 1.35} ${x - size * 1.35},${y}`}
        fill={fill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );
  return <circle cx={x} cy={y} r={size} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
}

/** CSS twin of the SVG hatch pattern, so the legend matches the bar it explains. */
function hatchSwatch(color: string): string {
  return `repeating-linear-gradient(45deg, ${color} 0 3px, var(--surface) 3px 4.5px)`;
}

/**
 * Legend key for the redundant encoding: colour is never the only thing in it.
 * Lines get "shape + dash preview"; filled bars get a solid or hatched chip that
 * mirrors the bar itself, so the legend explains the fill instead of guessing it.
 */
function LegendSwatch({
  shape,
  color,
  dash,
  fill,
}: {
  shape: SeriesMarkerShape;
  color: string;
  dash: string;
  fill?: "solid" | "hatch";
}) {
  if (fill)
    return (
      <i
        aria-hidden="true"
        style={{
          width: 9,
          height: 9,
          flexShrink: 0,
          borderRadius: 2,
          background: fill === "hatch" ? hatchSwatch(color) : color,
        }}
      />
    );
  return (
    <>
      <i
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          flexShrink: 0,
          background: color,
          borderRadius: shape === "circle" ? "50%" : shape === "diamond" ? 1 : 0,
          transform: shape === "diamond" ? "rotate(45deg)" : undefined,
          clipPath: shape === "triangle" ? "polygon(50% 0%, 100% 100%, 0% 100%)" : undefined,
        }}
      />
      <i
        aria-hidden="true"
        style={{ width: 16, height: 2, flexShrink: 0, background: dashSwatch(color, dash) }}
      />
    </>
  );
}

/** Hide/show one series, never hiding the last visible one. */
function toggleSeries(hidden: Set<string>, key: string, total: number): Set<string> {
  const next = new Set(hidden);
  if (!hidden.has(key)) {
    next.add(key);
    return next.size === total ? hidden : next;
  }
  next.delete(key);
  return next;
}

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
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
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
  // Success is series 0, error series 1: same (dash, marker) pairs the line chart
  // uses, so the legend reads the same across both chart types.
  const successOn = !hidden.has("success");
  const errorOn = !hidden.has("error");

  return (
    <>
      <div className={s.legend} role="group" aria-label={t("fusion.charts.legendAria")}>
        {
          // Reuse the outcome labels the tables and the detail row already use, so
          // the legend needs no new i18n key and reads identically everywhere.
          (
            [
              ["success", t("logs.outcome.success")],
              ["error", t("logs.outcome.error")],
            ] as const
          ).map(([key, label], index) => {
            const off = hidden.has(key);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={!off}
                className={off ? s.legendOff : s.legendOn}
                onClick={() => setHidden((old) => toggleSeries(old, key, 2))}
              >
                <LegendSwatch
                  shape={markerFor(index)}
                  color={index === 0 ? "var(--accent)" : "var(--error)"}
                  dash=""
                  fill={index === 1 ? "hatch" : "solid"}
                />
                {label}
              </button>
            );
          })
        }
      </div>
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
          {/* Redundant encoding for the filled stack: the error segment is hatched, the
              success segment is solid. In greyscale (or on a bad projector) the two
              halves of a bar stay distinguishable without relying on colour.
              Deliberately path-only — a <rect> here would become the first rect in the
              plot and break chart-readability.spec.ts's scale measurement. */}
          <pattern
            id={`${id}-errhatch`}
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <path d="M0 0 V6" stroke="var(--error)" strokeWidth="6" strokeOpacity="0.82" />
            <path d="M0 0 V6" stroke="var(--page)" strokeWidth="1.6" strokeOpacity="0.55" />
          </pattern>
        </defs>
        <GridLines plot={plot} />
        <YTicks plot={plot} max={max} format={(value) => metric(value)} />
        {rows.map((row, index) => {
          const x = layout.xOf(index) - layout.barWidth / 2;
          // Hiding a series shrinks the stack to what is still drawn; it must not
          // leave a hole of the hidden series' height. The tooltip keeps the real
          // total, because that is the data, not the rendering.
          const total = totals[index]!;
          const drawn =
            (successOn ? values[index]!.success : 0) + (errorOn ? values[index]!.error : 0);
          const successHeight =
            drawn && successOn ? box.height * (values[index]!.success / max) : 0;
          const errorHeight =
            drawn && errorOn
              ? Math.max(values[index]!.error ? 1.5 : 0, box.height * (drawn / max) - successHeight)
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
                <>
                  <rect
                    x={x}
                    y={plot.top + box.height - errorHeight}
                    width={layout.barWidth}
                    height={errorHeight}
                    fill={`url(#${id}-err)`}
                    rx={1.5}
                  />
                  <rect
                    x={x}
                    y={plot.top + box.height - errorHeight}
                    width={layout.barWidth}
                    height={errorHeight}
                    fill={`url(#${id}-errhatch)`}
                    rx={1.5}
                  />
                </>
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
              onClick={() => setHidden((old) => toggleSeries(old, metricDef.key, metrics.length))}
            >
              {/* Colour + dash + shape: the legend is the key to the redundant encoding. */}
              <LegendSwatch
                shape={markerFor(metricIndex)}
                color={COLORS[metricDef.color]}
                dash={dashFor(metricIndex)}
              />
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
        {metrics.map((metricDef, metricIndex) => {
          if (hidden.has(metricDef.key)) return null;
          const dash = dashFor(metricIndex);
          const shape = markerFor(metricIndex);
          return (
            <g key={metricDef.key} data-series={metricDef.key}>
              {segment(metricIndex).map((points, segmentIndex) => (
                <polyline
                  key={`${metricDef.key}-${segmentIndex}`}
                  data-dash={dash || "solid"}
                  points={points.map(([x, y]) => `${x},${y}`).join(" ")}
                  stroke={COLORS[metricDef.color]}
                  strokeWidth={2.6}
                  strokeDasharray={dash || undefined}
                  fill="none"
                />
              ))}
              {values.length <= MARKER_MAX_POINTS &&
                segment(metricIndex).map((points, segmentIndex) =>
                  points.map(([x, y], pointIndex) => (
                    <SeriesMarker
                      key={`${segmentIndex}-${pointIndex}`}
                      shape={shape}
                      x={x}
                      y={y}
                      size={3.2}
                      fill="var(--surface)"
                      stroke={COLORS[metricDef.color]}
                      strokeWidth={2}
                    />
                  )),
                )}
            </g>
          );
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
                <SeriesMarker
                  key={metricDef.key}
                  shape={markerFor(metricIndex)}
                  x={layout.xOf(active)}
                  y={yOf(value)}
                  size={4.5}
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
