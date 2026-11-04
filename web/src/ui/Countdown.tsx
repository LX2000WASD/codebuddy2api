import { snapshotAge } from "../api";
import { countdownText, sinceText, useNow } from "../hooks";
import s from "./Countdown.module.scss";

/**
 * Live ticking countdown for epoch-second (or epoch-ms) deadlines.
 *
 * The tick comes from the process-wide clock in hooks.ts, not from a per-instance interval:
 * a lock table renders two countdowns per row, and one timer each meant 2N timers fighting
 * over 2N independent re-render schedules. The absolute end time stays available in a tooltip.
 */
export function Countdown({
  until,
  fallback = "—",
  ms = false,
  absolute = true,
}: {
  until: number | null;
  fallback?: string;
  ms?: boolean;
  absolute?: boolean;
}) {
  // A countdown with no deadline has nothing to tick: subscribe only while live, so a table
  // full of finished cooldowns holds zero timers.
  const now = useNow(typeof until === "number" && Number.isFinite(until) && until > 0);
  // 0 (or negative) deadlines mean "no deadline set", same as unknown.
  const seconds =
    typeof until === "number" && Number.isFinite(until) && until > 0
      ? Math.max(0, Math.ceil(until - (ms ? now : now / 1000)))
      : null;
  const ended = seconds !== null && seconds === 0;
  return (
    <span
      className={s.countdown}
      data-urgent={seconds !== null && seconds < 300 && !ended ? "true" : undefined}
      title={
        absolute && typeof until === "number"
          ? new Date(ms ? until : until * 1000).toLocaleString("zh-CN")
          : undefined
      }
    >
      {ended ? "已结束" : countdownText(until, fallback, now, ms)}
    </span>
  );
}

/**
 * "数据更新于 N 秒前" for a page whose payload may be a reused snapshot.
 *
 * The shared snapshot layer answers a navigation inside its TTL without touching the network
 * (that is the point), so a page can legitimately show data that is a few seconds old. Saying
 * so out loud is the difference between "fast" and "stale".
 *
 * The tick comes from the shared clock, so this is one leaf span re-rendering per second — not
 * the page. It also unsubscribes once the age passes a minute, at which point the exact second
 * stops mattering and the hint goes static.
 */
export function FreshnessHint({ path }: { path: string }) {
  const age = snapshotAge(path);
  const now = useNow(age !== null && age.ageMs < 60_000);
  if (age === null) return null;
  void now;
  return (
    <span className={s.freshness} title={new Date(age.fetchedAt).toLocaleString("zh-CN")}>
      数据更新于 {sinceText(age.fetchedAt)}
    </span>
  );
}
