import { useMemo, useState } from "react";
import { metric, number, type RecordValue } from "./api";
import { Badge } from "./components";
import { useT } from "./i18n";
import s from "./ui.module.scss";

/**
 * One entry of a request's attempt trail, derived from GET /admin/logs/{id}.
 *
 * The backend stores attempts in the order they happened (audit_store.py keys them by
 * (request_id, ordinal) and inserts them in list order), so the array order *is* the
 * timeline. Nothing here re-sorts: the cumulative column only means "time up to here"
 * if the order is the recorded order.
 */

/** Semantic weight of a stage: `warn` is a retry/recovery marker, not a failure. */
export type TraceTone = "normal" | "failed" | "warn";

type StageMeta = { label: string; tone: TraceTone };

/**
 * Every stage the backend records today (app/observability.py observe_attempt and its
 * call sites in converter.py). The list is a lookup for wording and colour only — an
 * unknown stage still renders, because a new backend stage must not vanish from the
 * timeline just because this table has not learned its name yet.
 */
const STAGES: Record<string, StageMeta> = {
  upstream_attempt: { label: "logs.stage.upstreamAttempt", tone: "normal" },
  upstream_http: { label: "logs.stage.upstreamHttp", tone: "normal" },
  upstream_http_error: { label: "logs.stage.upstreamHttpError", tone: "failed" },
  transport: { label: "logs.stage.transport", tone: "failed" },
  upstream_queue_full: { label: "logs.stage.upstreamQueueFull", tone: "failed" },
  dsml_repaired: { label: "logs.stage.dsmlRepaired", tone: "warn" },
  dsml_rejected: { label: "logs.stage.dsmlRejected", tone: "failed" },
  native_markup_opensource: { label: "logs.stage.nativeMarkup", tone: "warn" },
  tool_args_retry: { label: "logs.stage.toolArgsRetry", tone: "warn" },
  tool_args_exhausted: { label: "logs.stage.toolArgsExhausted", tone: "failed" },
  content_filter: { label: "logs.stage.contentFilter", tone: "failed" },
  content_filter_retry: { label: "logs.stage.contentFilterRetry", tone: "warn" },
  connect_retry: { label: "logs.stage.connectRetry", tone: "warn" },
  write_timeout_retry: { label: "logs.stage.writeTimeoutRetry", tone: "warn" },
  request_preflight_rejected: { label: "logs.stage.preflightRejected", tone: "failed" },
  intl_image_merge: { label: "logs.stage.intlImageMerge", tone: "normal" },
  failover_recovered: { label: "logs.stage.failoverRecovered", tone: "warn" },
  attempts_truncated: { label: "logs.stage.attemptsTruncated", tone: "warn" },
  // Recorded when the bounded parser gave up on an oversized body (observability.py
  // :493). Informational: it explains why a trail stops early without any stage failing.
  observer: { label: "logs.stage.observer", tone: "warn" },
};

/**
 * Tone for one step: the table default, refined by what the record itself says.
 *
 * `upstream_http` is the one stage whose meaning depends on the status it carries — a 200
 * is the healthy path, a 4xx/5xx is that dial being rejected. `upstream_http_error` is
 * *not* a reliable companion: converter.py:4300 only emits it when the error body carries
 * a business code, so a bare 429/403/500 records that stage alone. Treating the status as
 * decoration would draw a rejected dial as a healthy step.
 *
 * The distribution behind this was measured on a real audit database (312 MB, snapshot
 * taken 2026-10-17): 170 of 93,527 `upstream_http` rows were non-200 (164×429, 4×500,
 * 2×403). That snapshot predates `upstream_http_error` (added 2026-10-21, commit 4251e7b),
 * so it cannot prove the companion stage is absent in current data — the conditional
 * emission at converter.py:4300 is what proves it.
 */
function toneFor(stage: string, statusCode: number | null): TraceTone {
  if (stage === "upstream_http" && statusCode !== null && statusCode >= 400) return "failed";
  return STAGES[stage]?.tone ?? "normal";
}

export type TraceStep = {
  key: string;
  /** 1-based position in the recorded trail. */
  ordinal: number;
  stage: string;
  tone: TraceTone;
  /** Duration this stage reported, or null when the stage is a marker rather than time. */
  durationMs: number | null;
  /** Sum of every reported duration up to and including this step. */
  cumulativeMs: number;
  statusCode: number | null;
  errorCode: string | null;
  retryAfter: number | null;
  /** Per-request dial index (request_context.attempt_index). */
  attemptIndex: number | null;
  /** Tool-argument retry counter, when the stage carries one. */
  attempt: number | null;
  maxAttempts: number | null;
  upstreamRequestId: string | null;
  upstreamModel: string | null;
  profile: string | null;
  credential: string | null;
  raw: RecordValue;
};

export type TraceModel = {
  steps: TraceStep[];
  /** Sum of every duration a stage actually reported. */
  knownMs: number;
  /** The request's own duration when it has one, otherwise the sum of the stages. */
  totalMs: number;
  /** Bar scale. Never zero, so a 0 ms stage still draws a track instead of nothing. */
  scaleMs: number;
  /** Stages the backend collapsed into the overflow marker. */
  dropped: number;
};

function label(raw: RecordValue, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value ? value : null;
}

export function deriveTrace(attempts: RecordValue[], requestMs?: unknown): TraceModel {
  const steps: TraceStep[] = [];
  let knownMs = 0;
  let dropped = 0;
  for (const [index, raw] of attempts.entries()) {
    const stage = typeof raw.stage === "string" ? raw.stage : "";
    const duration = number(raw.duration_ms);
    if (duration !== null) knownMs += duration;
    if (stage === "attempts_truncated") dropped = number(raw.dropped) ?? 0;
    const statusCode = number(raw.status_code);
    steps.push({
      key: `${index}:${stage}`,
      ordinal: index + 1,
      stage,
      tone: toneFor(stage, statusCode),
      durationMs: duration,
      // A stage that reports no duration is metadata, not time: it keeps the running
      // total instead of adding a fake zero-length slice to the bar chart.
      cumulativeMs: knownMs,
      statusCode,
      errorCode: label(raw, "error_code") ?? label(raw, "code"),
      retryAfter: number(raw.retry_after),
      attemptIndex: number(raw.attempt_index),
      attempt: number(raw.attempt),
      maxAttempts: number(raw.max_attempts),
      upstreamRequestId: label(raw, "upstream_request_id"),
      upstreamModel: label(raw, "upstream_model"),
      profile: label(raw, "profile"),
      credential: label(raw, "credential"),
      raw,
    });
  }
  const reported = number(requestMs);
  // The request total is the honest denominator: the gap between it and the sum of the
  // stages is time spent outside the upstream trail, and scaling by the sum would hide
  // exactly that. When the record has no total (cancelled mid-flight) the sum is all
  // the truth there is.
  const totalMs = reported !== null && reported > 0 ? reported : knownMs;
  return { steps, knownMs, totalMs, scaleMs: Math.max(totalMs, knownMs, 1), dropped };
}

function statusTone(code: number): "good" | "bad" | "warn" {
  if (code >= 500) return "bad";
  if (code === 429) return "warn";
  return code >= 400 ? "bad" : "good";
}

function CopyId({ value, label: ariaLabel }: { value: string; label: string }) {
  const t = useT();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = () => {
    // Clipboard access is denied in insecure contexts and absent in jsdom: report the
    // failure instead of pretending the copy worked (same rule as the command palette).
    const pending = navigator.clipboard?.writeText(value);
    if (!pending) {
      setState("failed");
      return;
    }
    void pending.then(() => setState("copied")).catch(() => setState("failed"));
  };
  return (
    <button type="button" onClick={copy} title={value} aria-label={ariaLabel}>
      <code>{value}</code>{" "}
      {state === "copied"
        ? t("logs.trace.copied")
        : state === "failed"
          ? t("logs.trace.copyFailed")
          : t("logs.trace.copy")}
    </button>
  );
}

function TraceRow({ step, scaleMs }: { step: TraceStep; scaleMs: number }) {
  const t = useT();
  const meta = STAGES[step.stage];
  const classes = [
    s.traceStep,
    step.tone === "failed" ? s.traceStepFailed : "",
    step.tone === "warn" ? s.traceStepWarn : "",
  ]
    .filter(Boolean)
    .join(" ");
  const width =
    step.durationMs === null ? 0 : Math.min(100, Math.max(0, (step.durationMs / scaleMs) * 100));
  const parts: string[] = [];
  if (step.attemptIndex !== null) parts.push(t("logs.trace.dial", { n: step.attemptIndex }));
  if (step.attempt !== null)
    parts.push(
      step.maxAttempts === null
        ? t("logs.trace.retry", { n: step.attempt })
        : t("logs.trace.retryOf", { n: step.attempt, max: step.maxAttempts }),
    );
  const route = [step.profile, step.upstreamModel, step.credential].filter(Boolean).join(" · ");
  const cumulative = t("logs.trace.cumulative", { ms: metric(step.cumulativeMs) });
  return (
    <li className={classes} data-trace-stage={step.stage || "unknown"} data-trace-tone={step.tone}>
      <span className={s.traceOrdinal}>{step.ordinal}</span>
      <div className={s.traceBody}>
        <div className={s.traceLabel}>
          <span className={s.traceStage} title={step.stage || undefined}>
            {meta ? t(meta.label) : step.stage || t("logs.trace.stageUnknown")}
          </span>
          {step.statusCode !== null && (
            <Badge tone={statusTone(step.statusCode)}>{step.statusCode}</Badge>
          )}
          {/* Only a failing stage's code is an error. Informational stages carry a
              code too (failover_recovered, observer), and painting those red would
              report a recovery as a failure. */}
          {step.errorCode !== null && (
            <Badge tone={step.tone === "failed" ? "bad" : "neutral"}>{step.errorCode}</Badge>
          )}
          {step.retryAfter !== null && (
            <Badge tone="warn">{t("logs.trace.retryAfter", { n: step.retryAfter })}</Badge>
          )}
          {parts.length > 0 && <span className={s.traceMeta}>{parts.join(" · ")}</span>}
          {step.upstreamRequestId !== null && (
            <CopyId value={step.upstreamRequestId} label={t("logs.trace.copyRequestId")} />
          )}
        </div>
        <div className={s.traceBar}>
          <span style={{ width: `${width}%` }} />
        </div>
        <div className={s.traceMeta}>
          {route && <span title={route}>{route} · </span>}
          {cumulative}
        </div>
      </div>
      <span className={s.traceDuration}>
        {step.durationMs === null ? t("logs.trace.noDuration") : `${metric(step.durationMs)} ms`}
      </span>
    </li>
  );
}

/**
 * The attempt trail of one request as an ordered timeline: which stage ran, how long it
 * took, how much time had accumulated by then, and which stages failed. Replaces the
 * flat key/value dump, which showed the same fields but hid the order and the cost.
 */
export function RequestTrace({
  attempts,
  requestMs,
}: {
  attempts: RecordValue[];
  requestMs?: unknown;
}) {
  const t = useT();
  const trace = useMemo(() => deriveTrace(attempts, requestMs), [attempts, requestMs]);
  if (!trace.steps.length) return <p>{t("logs.noAttempts")}</p>;
  return (
    <>
      <p className={s.traceMeta}>
        {t("logs.trace.summary", {
          steps: trace.steps.length,
          total: metric(trace.totalMs),
          known: metric(trace.knownMs),
        })}
      </p>
      <ol className={s.traceTimeline} aria-label={t("logs.trace.timeline")}>
        {trace.steps.map((step) => (
          <TraceRow key={step.key} step={step} scaleMs={trace.scaleMs} />
        ))}
      </ol>
      {trace.dropped > 0 && (
        <p className={s.traceMeta}>{t("logs.trace.truncated", { n: trace.dropped })}</p>
      )}
      <details className={s.rawData}>
        <summary>{t("logs.trace.raw")}</summary>
        <pre>{JSON.stringify(attempts, null, 2)}</pre>
      </details>
    </>
  );
}
