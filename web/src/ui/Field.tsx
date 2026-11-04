import type { ReactNode } from "react";
import s from "./Field.module.scss";

export type FieldProps = {
  label: ReactNode;
  /** Why the field exists or what format it takes; rendered under the control. */
  hint?: ReactNode;
  /** Validation message; announced as it appears. */
  error?: string | null;
  className?: string;
  children: ReactNode;
};

/**
 * Label + control + hint as one block.
 *
 * The wrapper is a `<label>`, so an Input, a Textarea or a Switch inside it is named by
 * the visible text with no id plumbing. A Select is a button, which no label can label:
 * it takes its accessible name from its own `label` prop, and the text here stays the
 * visible one.
 */
export function Field({ label, hint, error, className = "", children }: FieldProps) {
  return (
    <label className={className ? `${s.field} ${className}` : s.field}>
      <span className={s.label}>{label}</span>
      {children}
      {hint === undefined ? null : <small className={s.hint}>{hint}</small>}
      {error ? (
        <small className={s.error} role="alert">
          {error}
        </small>
      ) : null}
    </label>
  );
}
