import type { CSSProperties, ReactNode } from "react";
import { ToastRegion } from "./Toast";
import s from "./Layout.module.scss";

/** A step of the spacing scale; the token is resolved in CSS, never in the tsx. */
export type SpaceGap = "1" | "2" | "3" | "4" | "5" | "6";

const gap = (value: SpaceGap): CSSProperties => ({ gap: `var(--space-${value})` });

export type PageProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Page-level controls, right-aligned next to the title. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * The page frame: one level-one heading, the controls that belong to the whole page, and
 * the sections below them.
 *
 * The heading is visible on purpose — a breadcrumb names the *area*, and with the title
 * visually hidden the largest type on the page was a KPI number.
 */
export function Page({ title, description, actions, children, className = "" }: PageProps) {
  return (
    <div className={className ? `${s.page} ${className}` : s.page}>
      <header className={s.head}>
        <div className={s.heading}>
          <h1 className={s.title}>{title}</h1>
          {description === undefined ? null : <p className={s.description}>{description}</p>}
        </div>
        {actions === undefined ? null : <div className={s.actions}>{actions}</div>}
      </header>
      {children}
      {/* The page header is the last-mounted toast host, so notices raised anywhere on the
          page paint above their own backdrop. */}
      <ToastRegion />
    </div>
  );
}

export type StackProps = {
  gap?: SpaceGap;
  children: ReactNode;
  className?: string;
};

/** A vertical flow. The default rhythm is the one every section already uses. */
export function Stack({ gap: spacing = "3", children, className = "" }: StackProps) {
  return (
    <div className={className ? `${s.stack} ${className}` : s.stack} style={gap(spacing)}>
      {children}
    </div>
  );
}

export type ClusterProps = {
  gap?: SpaceGap;
  /** Cross-axis alignment of the items. */
  align?: "start" | "center" | "baseline";
  children: ReactNode;
  className?: string;
};

/** A wrapping row: filters, tags, button groups. Wrapping is what keeps a narrow viewport
 *  from pushing the page sideways. */
export function Cluster({
  gap: spacing = "2",
  align = "center",
  children,
  className = "",
}: ClusterProps) {
  return (
    <div
      className={className ? `${s.cluster} ${className}` : s.cluster}
      data-align={align}
      style={gap(spacing)}
    >
      {children}
    </div>
  );
}

export type GridProps = {
  /** Smallest a column may get before the grid adds another one. */
  min?: "sm" | "md" | "lg";
  gap?: SpaceGap;
  children: ReactNode;
  className?: string;
};

/** An auto-fitting grid: the column count follows the width instead of a fixed breakpoint
 *  table, so a 1024 viewport cannot leave one lonely card on a second row. */
export function Grid({ min = "md", gap: spacing = "3", children, className = "" }: GridProps) {
  return (
    <div
      className={className ? `${s.grid} ${className}` : s.grid}
      data-min={min}
      style={gap(spacing)}
    >
      {children}
    </div>
  );
}

export type ToolbarProps = {
  gap?: SpaceGap;
  /** Push the last item to the far edge (filters left, actions right). */
  split?: boolean;
  children: ReactNode;
  className?: string;
};

/** A control bar above a list. It wraps; it never scrolls sideways. */
export function Toolbar({
  gap: spacing = "2",
  split = false,
  children,
  className = "",
}: ToolbarProps) {
  return (
    <div
      className={className ? `${s.toolbar} ${className}` : s.toolbar}
      data-split={split ? "true" : undefined}
      style={gap(spacing)}
    >
      {children}
    </div>
  );
}

export type SplitProps = {
  /** The narrow column; it moves below the main one under 1200px. */
  aside: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Main column + aside, stacked on a narrow viewport rather than squeezed. */
export function Split({ aside, children, className = "" }: SplitProps) {
  return (
    <div className={className ? `${s.split} ${className}` : s.split}>
      <div className={s.main}>{children}</div>
      <aside className={s.aside}>{aside}</aside>
    </div>
  );
}
