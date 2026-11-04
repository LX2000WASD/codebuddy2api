import type { CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";
import s from "./Feedback.module.scss";

export type BadgeTone = "neutral" | "good" | "warn" | "bad";

export type BadgeProps = {
  children: ReactNode;
  tone?: BadgeTone;
  /** Full value behind a shortened badge (a truncated id, a long status). */
  title?: string;
};

/** A state tag. The tone is a semantic triple (fg/bg/border), never a palette hue. */
export function Badge({ children, tone = "neutral", title }: BadgeProps) {
  return (
    <span className={s.badge} data-tone={tone} title={title}>
      {children}
    </span>
  );
}

export type EmptyTone = "initial" | "filtered";

export type EmptyProps = {
  title: string;
  /**
   * "initial" means there is nothing yet and the answer is a next step; "filtered" means
   * the data exists but the current filter excludes it. They must not look the same: the
   * old table painted "没有匹配的日志" under every failed request.
   */
  tone?: EmptyTone;
  /** The next step, or the way out of the filter. Pages own the copy. */
  action?: ReactNode;
  children?: ReactNode;
};

export function Empty({ title, tone = "initial", action, children }: EmptyProps) {
  return (
    <div className={s.empty} data-tone={tone}>
      <span className={s.emptyIcon} aria-hidden="true">
        <Icon name={tone === "filtered" ? "search" : "leaf"} size="lg" />
      </span>
      <h3 className={s.emptyTitle}>{title}</h3>
      {children === undefined ? null : <p className={s.emptyBody}>{children}</p>}
      {action === undefined ? null : <div className={s.emptyAction}>{action}</div>}
    </div>
  );
}

export type LoadingLineProps = {
  /** What is loading ("凭证列表"). Announced once as a status. */
  label: string;
};

/** A single status line for a page that is fetching: a spinner and one word. */
export function LoadingLine({ label }: LoadingLineProps) {
  return (
    <div className={s.loading} role="status">
      <span className={s.loadingDot} aria-hidden="true" />
      {label}
    </div>
  );
}

export type ErrorNoticeProps = {
  /** The page's load or save error; nothing renders when it is empty. */
  message: string | null;
  retry?: { label: string; onClick: () => void };
};

/** A failed request, stated once, with the way to try it again. */
export function ErrorNotice({ message, retry }: ErrorNoticeProps) {
  if (!message) return null;
  return (
    <div className={s.error} role="alert">
      <Icon name="alert" size="sm" />
      <span className={s.errorText}>{message}</span>
      {retry && (
        <button type="button" className={s.errorRetry} onClick={retry.onClick}>
          {retry.label}
        </button>
      )}
    </div>
  );
}

/** The shape of one skeleton cell, matching what the real cell paints. */
export type SkeletonCell = "text" | "badge" | "twoLine";

export type SkeletonProps = {
  variant?: "line" | "card" | "chart" | "table";
  /** Accessible name of the loading region ("模型目录加载中"). */
  label: string;
  /** Table variant: one entry per column, in column order. */
  cells?: SkeletonCell[];
  /** Table variant: height of one skeleton row; match the real row height so the first
   *  payload does not shift every row down. */
  rowHeight?: number;
  className?: string;
};

const SKELETON_ROWS = 6;

/** Widths cycle so a column of skeletons does not read as one grey block. */
const CELL_WIDTHS: Record<SkeletonCell, string[]> = {
  text: [s.w40, s.w65, s.w50],
  badge: [s.wPill],
  twoLine: [s.w50, s.w40],
};

/**
 * Placeholders that reserve the space they describe, so a loading table never shifts the
 * layout it is standing in for.
 */
export function Skeleton({
  variant = "line",
  label,
  cells,
  rowHeight,
  className = "",
}: SkeletonProps) {
  const shapes = cells?.length ? cells : (["text", "badge", "twoLine", "text"] as SkeletonCell[]);
  return (
    <div
      className={className ? `${s.skeleton} ${className}` : s.skeleton}
      data-variant={variant}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      {variant === "table" &&
        Array.from({ length: SKELETON_ROWS }, (_, row) => (
          <div
            key={row}
            className={s.skeletonRow}
            aria-hidden="true"
            style={
              {
                ...(rowHeight ? { height: rowHeight } : {}),
                "--skeleton-columns": String(shapes.length),
              } as CSSProperties
            }
          >
            {shapes.map((shape, cell) => (
              <span
                key={cell}
                className={CELL_WIDTHS[shape][(row + cell) % CELL_WIDTHS[shape].length]}
                data-shape={shape}
                style={{ animationDelay: `${(row * shapes.length + cell) * 70}ms` }}
              />
            ))}
          </div>
        ))}
      {variant !== "table" && <span className={s.skeletonBlock} aria-hidden="true" />}
    </div>
  );
}
