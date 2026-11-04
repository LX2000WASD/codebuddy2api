import type { ReactNode } from "react";
import type { RecordValue } from "../api";
import s from "./Progress.module.scss";

/** The shape a banner needs out of a server job; the full `Job` type lives in jobs.tsx. */
export type JobProgress = {
  total: number;
  completed: number;
  current: { item: RecordValue; step: string | null }[];
};

export type ProgressBannerProps = {
  title: string;
  completed?: number;
  total?: number;
  children?: ReactNode;
};

/**
 * A progress banner for work in flight. Without a `total` the bar is indeterminate, for a
 * request that reports no progress of its own.
 */
export function ProgressBanner({ title, completed = 0, total, children }: ProgressBannerProps) {
  return (
    <div className={s.banner} role="status">
      <div className={s.head}>
        <strong className={s.title}>{title}</strong>
        {total === undefined ? null : (
          <span className={s.count}>
            {completed}/{total}
          </span>
        )}
      </div>
      {total === undefined ? (
        <progress className={s.bar} />
      ) : (
        <progress className={s.bar} value={completed} max={Math.max(total, 1)} />
      )}
      {children === undefined ? null : <div className={s.detail}>{children}</div>}
    </div>
  );
}

export type JobBannerProps = {
  title: string;
  job: JobProgress;
  /** What one running item is doing, in the page's own words. */
  describe: (item: RecordValue, step: string | null) => string;
  /** Shown when the job reports no current item ("正在准备…"). */
  preparingLabel: string;
  /** Prefix of each running line ("正在"). */
  runningPrefix: string;
};

/** A progress banner for one running job: what it is, how far along, and what it is doing now. */
export function JobBanner({ title, job, describe, preparingLabel, runningPrefix }: JobBannerProps) {
  return (
    <ProgressBanner title={title} completed={job.completed} total={job.total}>
      {job.current.length ? (
        job.current.map((row, index) => (
          <small className={s.line} key={index}>
            {runningPrefix}
            {describe(row.item, row.step)}
          </small>
        ))
      ) : (
        <small className={s.line}>{preparingLabel}</small>
      )}
    </ProgressBanner>
  );
}
