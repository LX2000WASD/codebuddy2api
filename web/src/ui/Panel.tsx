import type { ReactNode } from "react";
import s from "./Panel.module.scss";

export type PanelProps = {
  title: ReactNode;
  /** One line of context next to the title (a count, a timestamp). */
  hint?: ReactNode;
  /** Controls for the panel's content, right-aligned in the heading row. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * The one bordered box a page section may use: heading row, then a body with the shared
 * inner rhythm. Everything card-like inside it is a sunken block, not a second border —
 * nesting is what made the credentials page read as three levels of boxes.
 */
export function Panel({ title, hint, action, children, className = "" }: PanelProps) {
  return (
    <section className={className ? `${s.panel} ${className}` : s.panel}>
      <header className={s.head}>
        <h2 className={s.title}>{title}</h2>
        {hint === undefined ? null : <span className={s.hint}>{hint}</span>}
        {action === undefined ? null : <div className={s.action}>{action}</div>}
      </header>
      <div className={s.body}>{children}</div>
    </section>
  );
}
