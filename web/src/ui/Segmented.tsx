import type { ReactNode } from "react";
import s from "./Segmented.module.scss";

export type SegmentedOption = {
  value: string;
  label: ReactNode;
  /** Figure shown under the label, with number weight (a credit total, a count). */
  amount?: ReactNode;
  /** Note under the amount ("7 / 8 就绪"). */
  detail?: ReactNode;
  /** Native tooltip; this is where the full value behind a truncated figure belongs. */
  title?: string;
  disabled?: boolean;
};

export type SegmentedProps = {
  /** Accessible name of the group ("区域与账号类型筛选"). */
  label: string;
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  size?: "sm" | "md";
  className?: string;
};

/**
 * A segmented bar whose selected state is the button's own background and border.
 *
 * P1-1 was an absolutely positioned "thumb" painted over the selected segment: it was
 * opaque, it had no z-index, and it landed on the same rect as the button, so the
 * selected label disappeared on every viewport. There is deliberately no such element
 * here — `[aria-pressed="true"]` paints the segment itself, and the group contains
 * nothing but buttons, so an overlay cannot be reintroduced without deleting that rule.
 */
export function Segmented({
  label,
  options,
  value,
  onChange,
  size = "md",
  className = "",
}: SegmentedProps) {
  return (
    <div
      role="group"
      aria-label={label}
      data-size={size}
      className={className ? `${s.group} ${className}` : s.group}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className={s.segment}
          title={option.title}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          <span className={s.label}>{option.label}</span>
          {option.amount === undefined ? null : (
            <strong className={s.amount}>{option.amount}</strong>
          )}
          {option.detail === undefined ? null : <small className={s.detail}>{option.detail}</small>}
        </button>
      ))}
    </div>
  );
}
