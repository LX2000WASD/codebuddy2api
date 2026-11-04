import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import s from "./Stat.module.scss";

export type StatTone = "neutral" | "good" | "warn" | "bad";

export type StatProps = {
  /** What the number is ("P95 延迟", "累计请求"). */
  label: ReactNode;
  /** The number itself — the reason the card exists. */
  value: ReactNode;
  /** One line of context: the method, the unit, the measurement window. */
  hint?: ReactNode;
  icon?: IconName;
  /** Colours the value for a state the operator must notice. */
  tone?: StatTone;
  /** A sparkline, a delta chip, a distribution strip. */
  children?: ReactNode;
  className?: string;
};

/**
 * One metric card.
 *
 * The value never truncates: it wraps (and the card grows) rather than ending in an ellipsis.
 * P2-2 was five of these on a 1024px viewport where "P95 延迟 6,519.71 ms" was cut to
 * "6,519.7…" because the number was nowrap + ellipsis inside a 145px cell — a KPI whose value
 * cannot be read is not a KPI.
 */
export function Stat({
  label,
  value,
  hint,
  icon,
  tone = "neutral",
  children,
  className = "",
}: StatProps) {
  return (
    <div className={className ? `${s.stat} ${className}` : s.stat} data-tone={tone}>
      <div className={s.head}>
        <span className={s.label}>{label}</span>
        {icon === undefined ? null : (
          <span className={s.icon} aria-hidden="true">
            <Icon name={icon} size="sm" />
          </span>
        )}
      </div>
      <strong className={s.value}>{value}</strong>
      {hint === undefined ? null : <small className={s.hint}>{hint}</small>}
      {children === undefined ? null : <div className={s.extra}>{children}</div>}
    </div>
  );
}
