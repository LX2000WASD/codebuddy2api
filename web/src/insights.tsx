import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  acquireShared,
  compact,
  metric,
  number,
  rememberSnapshot,
  sharedSnapshot,
  useResource,
  type RecordValue,
} from "./api";
import { fusionGet, useFusionResource } from "./fusion/client";
import { t, useT } from "./i18n";
import s from "./ui.module.scss";

/**
 * E3 insight surfaces: the cost tiles on the overview, the 7-day health column on
 * the model catalog, and the "credits expiring" sidebar badge.
 *
 * Two rules hold all three together:
 *
 *   1. No new polling. Every surface reads the shared snapshot layer (api.ts), so
 *      its freshness is the 5 s TTL and the explicit refresh buttons, exactly like
 *      the pages that already use it.
 *   2. No redundant endpoints. /admin/stats/summary answers with the same
 *      stats_daily projection /admin/dashboard already returned, so the cost tiles
 *      are derived from the dashboard payload instead of fetched again.
 */

/* -- Cost ---------------------------------------------------------------- */

export type CostFigures = {
  /** Credit spent on the newest UTC day in the window; null when that day has no bucket. */
  today: number | null;
  /** Credit spent on the previous UTC day; null when there is no daily predecessor. */
  yesterday: number | null;
  /** Window credit / window days. */
  dailyAverage: number | null;
  /** Linear 30-day extrapolation of dailyAverage; null when the sample is too thin. */
  runRate: number | null;
  /** Window credit / window requests. */
  perRequest: number | null;
  requests: number;
  days: number;
  /** True when the 30-day extrapolation was withheld for lack of samples. */
  insufficient: boolean;
};

/**
 * Below this many requests the 30-day extrapolation is withheld.
 *
 * The daily average is window credit divided by days, so a handful of requests lets
 * one expensive call dominate the mean: three requests costing 5 credits on the
 * first day of a 7-day window extrapolate to a 150-credit month. A number that
 * wrong is worse than "not enough data".
 */
export const RUN_RATE_MIN_REQUESTS = 10;
/** One day cannot be told apart from a burst, so a single-day window is never extrapolated. */
export const RUN_RATE_MIN_DAYS = 2;

/**
 * Derives the cost figures from the dashboard payload already in hand.
 *
 * Every "day" here is a UTC calendar day: the backend buckets stats_daily with
 * int(now // 86400) * 86400 (app/audit_store.py:759), so the newest bucket is the
 * UTC day, not the local one. Saying "today" without that qualifier would quietly
 * name the wrong day for anyone east of Greenwich.
 *
 * The series is only read as today/yesterday when it is a daily series: an hourly
 * series second-to-last bucket is the previous hour, not yesterday.
 */
export function costFigures(
  summary: RecordValue,
  series: RecordValue[],
  range: RecordValue | undefined,
): CostFigures {
  const requests = number(summary.requests) ?? 0;
  const days = number(range?.days) ?? (series.length || 1);
  const total = number(summary.credit);
  const granularity = typeof range?.granularity === "string" ? range.granularity : "";
  const buckets = granularity === "hour" ? [] : series;
  const today = buckets.length ? number(buckets[buckets.length - 1].credit) : null;
  const yesterday = buckets.length > 1 ? number(buckets[buckets.length - 2].credit) : null;
  const dailyAverage = total === null ? null : total / Math.max(1, days);
  const insufficient = requests < RUN_RATE_MIN_REQUESTS || days < RUN_RATE_MIN_DAYS;
  return {
    today,
    yesterday,
    dailyAverage,
    runRate: insufficient || dailyAverage === null ? null : dailyAverage * 30,
    perRequest: requests > 0 && total !== null ? total / requests : null,
    requests,
    days,
    insufficient,
  };
}

/** Signed percentage change, or null when the baseline is zero or unknown. */
export function changePercent(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function deltaText(pct: number | null): string | null {
  return pct === null ? null : (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
}

type CostTile = {
  key: string;
  label: string;
  value: string;
  hint: string;
  delta?: { text: string; up: boolean } | null;
  title?: string;
};

/**
 * Cost tiles for the overview. Mounting this card costs zero requests: it is a
 * re-projection of the dashboard payload the page already rendered.
 */
export function CostCards({
  summary,
  series,
  range,
  partial,
}: {
  summary: RecordValue;
  series: RecordValue[];
  range: RecordValue | undefined;
  partial: boolean;
}) {
  const t = useT();
  const figures = useMemo(() => costFigures(summary, series, range), [summary, series, range]);
  const vsYesterday = changePercent(figures.today, figures.yesterday);
  const todayDelta = deltaText(vsYesterday);
  const tiles: CostTile[] = [
    {
      key: "today",
      label: t("cost.today"),
      value: figures.today === null ? "—" : metric(figures.today),
      hint: t("cost.todayHint"),
      // The delta is only shown when yesterday was actually recorded; a missing
      // baseline must not render as "+100%".
      delta:
        todayDelta === null
          ? null
          : { text: t("cost.vsYesterday", { pct: todayDelta }), up: (vsYesterday ?? 0) >= 0 },
      title: todayDelta === null ? t("cost.noYesterday") : undefined,
    },
    {
      key: "average",
      label: t("cost.average"),
      value: figures.dailyAverage === null ? "—" : metric(figures.dailyAverage),
      hint: t("cost.averageHint", { days: figures.days }),
    },
    {
      key: "runRate",
      label: t("cost.runRate"),
      value: figures.runRate === null ? t("cost.runRateInsufficient") : metric(figures.runRate),
      hint:
        figures.runRate === null
          ? t("cost.runRateInsufficientHint", { requests: figures.requests })
          : t("cost.runRateHint"),
    },
    {
      key: "perRequest",
      label: t("cost.perRequest"),
      value: figures.perRequest === null ? "—" : metric(figures.perRequest),
      hint: t("cost.perRequestHint", { requests: compact(figures.requests) }),
    },
  ];
  return (
    <>
      {partial && (
        <p className={s.note} role="status">
          {t("cost.partial")}
        </p>
      )}
      <div className={s.metricGrid}>
        {tiles.map((tile) => (
          <section
            className={s.metricTile}
            key={tile.key}
            title={tile.delta ? undefined : tile.title}
          >
            <span className={s.metricLabel}>{tile.label}</span>
            <strong className={s.metricValue}>{tile.value}</strong>
            {tile.delta ? (
              <span
                className={
                  tile.delta.up
                    ? s.metricDelta + " " + s.metricUp
                    : s.metricDelta + " " + s.metricDown
                }
              >
                {tile.delta.text}
              </span>
            ) : (
              <span className={s.metricDelta}>{tile.hint}</span>
            )}
          </section>
        ))}
      </div>
      <p className={s.muted}>{t("cost.utcNote")}</p>
    </>
  );
}
/* -- Model health -------------------------------------------------------- */

export type ModelHealth = {
  key: string;
  requests: number;
  error: number;
  errorRate: number | null;
};

/**
 * One shared 7-day aggregate for the whole model catalog.
 *
 * /admin/stats/dimensions returns every model window aggregate in a single
 * response, which is what makes a health column affordable: one request covers
 * every row. It goes through the shared snapshot layer, so switching to the
 * credentials section and back inside the TTL does not refetch it.
 */
export function useModelHealth(): {
  byModel: Map<string, ModelHealth>;
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const resource = useFusionResource(
    "/admin/stats/dimensions",
    new URLSearchParams({ dimension: "model", days: "7" }),
    normalizeModelHealth,
  );
  const byModel = useMemo(() => resource.data ?? new Map<string, ModelHealth>(), [resource.data]);
  return { byModel, loading: resource.loading, error: resource.error, reload: resource.reload };
}

function normalizeModelHealth(value: unknown): Map<string, ModelHealth> {
  const data = (value ?? {}) as RecordValue;
  const items = Array.isArray(data.items) ? (data.items as RecordValue[]) : [];
  const byModel = new Map<string, ModelHealth>();
  for (const item of items) {
    const key = typeof item.key === "string" ? item.key : "";
    if (!key) continue;
    const requests = number(item.requests) ?? 0;
    const error = number(item.error) ?? 0;
    byModel.set(key, { key, requests, error, errorRate: requests > 0 ? error / requests : null });
  }
  return byModel;
}

export type HealthTone = "good" | "degraded" | "bad" | "none";

/**
 * Tone of one model health. Thresholds are on the error *rate*, not the raw
 * count: one failure out of three requests is a broken model, one out of three
 * thousand is noise.
 */
export function healthTone(health: ModelHealth | undefined): HealthTone {
  if (!health || health.requests === 0) return "none";
  if (health.error === 0) return "good";
  return (health.errorRate ?? 0) >= 0.2 ? "bad" : "degraded";
}

function toneClass(tone: HealthTone): string {
  if (tone === "good") return s.availGood;
  if (tone === "bad") return s.availBad;
  if (tone === "degraded") return s.availWarn;
  return s.availMuted;
}

/**
 * "X% errors" with a tone badge, the request count and the sparkline slot.
 *
 * The sparkline is a prop rather than an internal fetch: the page owns the request
 * budget and the cap, this cell only renders what it is handed.
 */
export function ModelHealthCell({
  name,
  health,
  spark,
}: {
  name: string;
  health: ModelHealth | undefined;
  spark?: ReactNode;
}) {
  const t = useT();
  const tone = healthTone(health);
  if (tone === "none")
    return (
      <div className={s.availStack}>
        <span className={s.availBadge + " " + s.availMuted}>{t("models.health.empty")}</span>
        {spark}
      </div>
    );
  const rate = health?.errorRate;
  const pct = rate === null || rate === undefined ? "—" : (rate * 100).toFixed(1) + "%";
  const title = t("models.health.tooltip", {
    requests: metric(health?.requests ?? 0),
    errors: metric(health?.error ?? 0),
    pct,
  });
  return (
    <div className={s.availStack}>
      <span className={s.availBadge + " " + toneClass(tone)} title={title} data-model={name}>
        {t("models.health.errorRate", { pct })}
      </span>
      <small>{t("models.health.requests", { requests: compact(health?.requests ?? 0) })}</small>
      {spark}
    </div>
  );
}

/**
 * Daily request counts for one model as bars, one bar per day.
 *
 * Bars are plain spans (ui.module.scss .sparkline), not a chart library: seven
 * bars carry "did this model keep serving" and nothing more.
 */
export function HealthSparkline({ name, rows }: { name: string; rows: RecordValue[] }) {
  const t = useT();
  if (!rows.length) return <span className={s.sparklineEmpty}>{t("models.health.empty")}</span>;
  const counts = rows.map((row) => number(row.requests) ?? 0);
  const peak = Math.max(1, ...counts);
  return (
    <span className={s.sparkline} role="img" aria-label={t("models.health.sparkAria", { name })}>
      {rows.map((row, index) => {
        const requests = number(row.requests) ?? 0;
        const errors = number(row.error) ?? 0;
        return (
          <span
            key={index}
            className={errors > 0 ? s.sparklineError : undefined}
            style={{ height: Math.max(2, Math.round((requests / peak) * 18)) + "px" }}
            title={(typeof row.date === "string" ? row.date + " · " : "") + metric(requests)}
          />
        );
      })}
    </span>
  );
}

/**
 * How many models get a sparkline in the current view.
 *
 * The aggregate above is one request for the whole catalog, but the day-by-day
 * series has no batch form: one call per model. Rendering a sparkline on every row
 * would fire one request per model (48 in the e2e fixture) before the user looked
 * at any of them. The cap keeps the cost proportional to what is on screen, and the
 * number is stated in the UI so a row without a sparkline reads as "not loaded",
 * not "no traffic".
 */
export const SPARKLINE_LIMIT = 12;
/** Concurrent series requests: enough to feel instant, few enough to stay polite. */
export const SPARKLINE_CONCURRENCY = 4;

/**
 * The model ids that deserve a sparkline: the busiest rows of the current view.
 *
 * Traffic comes from the aggregate, so the choice costs no extra request, and it
 * follows the filter: narrowing to one profile promotes the models that profile
 * actually serves.
 */
export function sparklineKeys(
  rows: RecordValue[] | undefined,
  byModel: Map<string, ModelHealth>,
  limit = SPARKLINE_LIMIT,
): string[] {
  if (!rows || !rows.length) return [];
  return rows
    .map(healthKey)
    .filter((key) => key !== "" && (byModel.get(key)?.requests ?? 0) > 0)
    .sort((a, b) => (byModel.get(b)?.requests ?? 0) - (byModel.get(a)?.requests ?? 0))
    .slice(0, limit);
}

/**
 * The key a model row is aggregated under.
 *
 * The audit store buckets the model dimension by the *requested* model name
 * (converter.py observe_route passes the client payload model, which is the public
 * id), so health and series must be looked up by public_id. `id` is only the
 * internal rule key and would silently match nothing.
 */
export function healthKey(row: RecordValue): string {
  if (typeof row.public_id === "string" && row.public_id) return row.public_id;
  return typeof row.id === "string" ? row.id : "";
}

/** Health for one model, preferring the public id and falling back to the rule id. */
export function healthFor(
  byModel: Map<string, ModelHealth>,
  model: { id: string; public_id: string },
): ModelHealth | undefined {
  return byModel.get(model.public_id) ?? byModel.get(model.id);
}

/** One model daily series, or null while it is still loading. */
export type SparklineEntry = { rows: RecordValue[] | null; loading: boolean };

/**
 * Loads the daily series for `keys` with bounded concurrency, keyed by model id.
 *
 * The hook fetches imperatively rather than through useFusionResource because the
 * key set is dynamic: a hook cannot be called once per key, and the endpoint takes a
 * single key, so one call cannot cover them all. Results are dropped when the key
 * set changes, so a filter change never paints one model sparkline onto another.
 */
export function useModelSparklines(
  keys: string[],
  options: { days?: number; reloadToken?: number } = {},
): Map<string, SparklineEntry> {
  const days = options.days ?? 7;
  const reloadToken = options.reloadToken ?? 0;
  const signature = keys.join("\u0000");
  const [state, setState] = useState<{ signature: string; entries: Map<string, SparklineEntry> }>({
    signature: "",
    entries: new Map(),
  });
  useEffect(() => {
    const wanted = signature === "" ? [] : signature.split("\u0000");
    if (!wanted.length) {
      setState({ signature: "", entries: new Map() });
      return;
    }
    let cancelled = false;
    // Seed from the snapshot layer first: a remount inside the TTL paints
    // immediately instead of flashing a loading state.
    const pending: string[] = [];
    const seeded = new Map<string, SparklineEntry>();
    for (const key of wanted) {
      const cached = sharedSnapshot(sparklineKey(key, days));
      if (cached) seeded.set(key, { rows: normalizeSparkline(cached.data), loading: false });
      else pending.push(key);
    }
    setState({
      signature,
      entries: new Map(
        wanted.map((key) => [key, seeded.get(key) ?? { rows: null, loading: true }]),
      ),
    });
    let cursor = 0;
    // fusionGet, not api.get: the fusion seam is what decides between the mock
    // fixtures (vitest, the e2e dev server) and the live /admin endpoints. Calling
    // axios directly here would silently bypass that seam, so a dev/e2e run would
    // get a 404 from the dev server while production worked — the exact
    // "green locally, broken in the browser" split this project has been bitten by.
    const load = async (key: string) => {
      const path = sparklineKey(key, days);
      return acquireShared(path, (signal) =>
        fusionGet(sparklinePath(key, days), sparklineParams(key, days), { signal }).then((data) => {
          rememberSnapshot(path, data);
          return data;
        }),
      );
    };
    const worker = async () => {
      while (!cancelled && cursor < pending.length) {
        const key = pending[cursor];
        cursor += 1;
        let entry: SparklineEntry = { rows: null, loading: false };
        try {
          entry = { rows: normalizeSparkline(await load(key)), loading: false };
        } catch {
          // A failed sparkline is not a page error: the aggregate badge above it
          // already reports the model health, so the trend just stays absent.
          entry = { rows: null, loading: false };
        }
        if (cancelled) return;
        setState((previous) =>
          previous.signature !== signature
            ? previous
            : { signature, entries: new Map(previous.entries).set(key, entry) },
        );
      }
    };
    void Promise.all(
      Array.from({ length: Math.min(SPARKLINE_CONCURRENCY, pending.length) }, () => worker()),
    );
    return () => {
      cancelled = true;
    };
  }, [signature, days, reloadToken]);
  return state.signature === signature ? state.entries : new Map();
}

function sparklineParams(key: string, days: number): URLSearchParams {
  return new URLSearchParams({
    dimension: "model",
    key,
    days: String(days),
    granularity: "day",
  });
}

/** Path as the fusion seam expects it: documented prefix, no query string. */
function sparklinePath(key: string, days: number): string {
  return "/admin/stats/series?" + sparklineParams(key, days).toString();
}

/**
 * Snapshot key for one sparkline.
 *
 * Deliberately identical to the fusion client's own key format so a sparkline and
 * a Trends request for the same model share one snapshot instead of racing each
 * other with two entries for the same payload.
 */
function sparklineKey(key: string, days: number): string {
  return "/admin/stats/series?" + sparklineParams(key, days).toString();
}

function normalizeSparkline(value: unknown): RecordValue[] {
  const data = (value ?? {}) as RecordValue;
  return Array.isArray(data.series) ? (data.series as RecordValue[]) : [];
}
/* -- Credits badge ------------------------------------------------------- */

export type CreditsAlert = {
  /** Enabled accounts with at least one positive segment expiring inside the window. */
  accounts: number;
  /** Credits expiring inside the window, summed across those accounts. */
  credits: number;
  days: number;
};

export const CREDITS_BADGE_DAYS = 7;

/**
 * Counts enabled accounts with credits expiring inside `days`.
 *
 * Reads the raw credential rows the shell already shares with the credentials page,
 * rather than /admin/credits/expiry: that endpoint re-derives the same segments but
 * also runs a burn-rate query per account, which is far too much work for a number
 * in the sidebar. Expiries are epoch seconds; a segment without one is an
 * unexpiring balance and never counts as urgent.
 */
export function creditsAlert(
  rows: RecordValue[] | null | undefined,
  now = Date.now() / 1000,
  days = CREDITS_BADGE_DAYS,
): CreditsAlert | null {
  if (!rows || !rows.length) return null;
  const horizon = now + days * 86400;
  let accounts = 0;
  let credits = 0;
  for (const row of rows) {
    if (row.enabled === false) continue;
    const creditsField = row.credits;
    if (!creditsField || typeof creditsField !== "object" || Array.isArray(creditsField)) continue;
    const segments = (creditsField as RecordValue).segments;
    if (!Array.isArray(segments)) continue;
    let expiring = 0;
    for (const segment of segments) {
      if (!segment || typeof segment !== "object" || Array.isArray(segment)) continue;
      const expiry = number((segment as RecordValue).expires_at);
      const remaining = number((segment as RecordValue).remaining) ?? 0;
      if (expiry === null || remaining <= 0) continue;
      if (expiry > now && expiry <= horizon) expiring += remaining;
    }
    if (expiring > 0) {
      accounts += 1;
      credits += expiring;
    }
  }
  return accounts > 0 ? { accounts, credits: Math.round(credits * 100) / 100, days } : null;
}

/**
 * Sidebar badge: the count, with the credit total and window in the tooltip.
 *
 * The count is the actionable number ("how many accounts do I need to look at");
 * the credits live in the title because they are the reason to click, not a figure
 * anyone reads from a 10px pill.
 */
export function CreditsBadge({ alert }: { alert: CreditsAlert }) {
  const t = useT();
  return (
    <span
      className={s.navBadge}
      title={t("nav.creditsExpiringHint", { credits: metric(alert.credits), days: alert.days })}
      data-credits-alert={alert.accounts}
    >
      {alert.accounts}
    </span>
  );
}

/** The dot shown instead of the badge when the sidebar is collapsed. */
export function CreditsDot({ alert }: { alert: CreditsAlert }) {
  const t = useT();
  return (
    <span
      className={s.navDot}
      title={t("nav.creditsExpiringHint", { credits: metric(alert.credits), days: alert.days })}
      data-credits-alert={alert.accounts}
      aria-hidden="true"
    />
  );
}

/**
 * The alert count for the shell, from the shared credential snapshot.
 *
 * Returns null while the payload is missing so the shell renders no badge at all
 * rather than a zero that claims "nothing expires".
 */
export function useCreditsAlert(): CreditsAlert | null {
  // Deliberately the same request key the credentials page and the model page use
  // (`/credentials`), so the shell joins their shared request instead of issuing a
  // second identical GET: one payload, three consumers, one network call.
  const resource = useResource("/credentials", credentialRows);
  return useMemo(() => creditsAlert(resource.data), [resource.data]);
}

/**
 * Tolerant reader for the credential list.
 *
 * The shell renders on every page, so a payload shape it does not recognise must
 * mean "no badge", never a thrown error that would take down the whole navigation.
 * The credentials page keeps its own strict parser for its own table.
 */
function credentialRows(value: unknown): RecordValue[] {
  const data = value as RecordValue | null;
  const rows = data && typeof data === "object" ? data.credentials : null;
  return Array.isArray(rows) ? (rows as RecordValue[]) : [];
}

export { t };
