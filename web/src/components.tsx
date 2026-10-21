import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, errorMessage, object, snapshotAge } from "./api";
import { countdownText, sinceText, useNow } from "./hooks";
import { lockPage } from "./modal";
import { useExiting } from "./presence";
export { DrawerPresence } from "./presence";
import s from "./ui.module.scss";
import { useT } from "./i18n";

export function Icon({ name = "grid" }: { name?: string }) {
  const paths: Record<string, string> = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    model: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
    key: "M14 4a6 6 0 1 1-3 11l-6 6H2v-3l6-6a6 6 0 0 1 6-8Z M16 8h.01",
    logs: "M6 3h12v18H6z M9 7h6M9 11h6M9 15h4",
    settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
    arrow: "M5 12h14m-5-5 5 5-5 5",
    plus: "M12 5v14M5 12h14",
    collapse: "M4 4h16v16H4zM9 4v16m7-12-3 4 3 4",
    expand: "M4 4h16v16H4zM9 4v16m4-12 3 4-3 4",
    refresh: "M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15",
    close: "m6 6 12 12M6 18 18 6",
    shield: "m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5l8-3Zm-4 9 3 3 5-6",
    leaf: "M20 3C7 2 1 8 5 16s17 4 15-13ZM5 20 16 8",
    alert: "m12 3 10 18H2L12 3Zm0 5v6m0 3v1",
    appearance:
      "M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2a4 4 0 0 0 4-4C21 6.4 17 3 12 3ZM7 10h.01M10 7h.01M15 7h.01M17 10h.01",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5",
    moon: "M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z",
    system: "M3 4h18v13H3zM8 21h8m-4-4v4",
    // Local fusion icons (chart/pulse/bell/coin) and upstream's trend/storage icons
    // (down/up/cache/database) are disjoint names — union, no collisions.
    chart: "M4 20h16M7 20v-6M12 20V6M17 20v-10",
    pulse: "M2 12h4l3-8 4 16 3-8h6",
    bell: "M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10.3 21a2 2 0 0 0 3.4 0",
    coin: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
    down: "M12 3v12m0 0 4-4m-4 4-4-4M5 21h14",
    up: "M12 21V9m0 0 4 4m-4-4-4 4M5 3h14",
    cache:
      "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Zm8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6m16 6c0 1.7-3.6 3-8 3s-8-1.3-8-3",
    database:
      "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Zm-8 2v9c0 1.7 3.6 3 8 3s8-1.3 8-3v-9M4 14.5c0 1.7 3.6 3 8 3s8-1.3 8-3",
    // "Filtered, nothing matched": a magnifier, the universal "your query
    // returned nothing" glyph — distinct from the leaf used for "nothing here yet".
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4 4",
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.grid} />
    </svg>
  );
}
export function PageTitle({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  // The h1 is the only visible level-one heading on the page. It used to be srOnly on
  // the theory that the header breadcrumb named the page, but that crumb is 12px and
  // names the *area* — the largest type on every page ended up being a KPI number, so
  // nothing on screen said which page you were looking at. Description and actions stay
  // on the same row (title block left, controls right).
  return (
    <div className={s.pageTitle}>
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className={s.actions}>{actions}</div>
    </div>
  );
}
export function ErrorNotice({ message, retry }: { message: string | null; retry?: () => void }) {
  const t = useT();
  return message ? (
    <div className={s.error} role="alert">
      <Icon name="alert" />
      <span>{message}</span>
      {retry && <button onClick={retry}>{t("common.retry")}</button>}
    </div>
  ) : null;
}
/**
 * The two empty states are not the same message, so they must not look the same.
 *
 * "initial" means there is nothing yet (a first run, a page that has never had
 * data): the answer is a next step, so it keeps the leaf and offers a primary
 * action. "filtered" means the data exists but the current filter excludes it:
 * the answer is to widen the filter, so it gets a neutral search glyph and a
 * secondary "clear filters" action. Before this split every empty table said
 * "没有匹配的日志", including the one a failed request had just emptied.
 */
export type EmptyTone = "initial" | "filtered";
export function Empty({
  title,
  tone = "initial",
  action,
  onClear,
  children,
}: {
  title?: string;
  tone?: EmptyTone;
  /** Primary next step ("initial") or the way out of the filter ("filtered"). */
  action?: ReactNode;
  /**
   * Shortcut for the "filtered" tone: renders the standard clear-filters button.
   * The pages only pass their existing reset handler, so the button's copy and
   * markup live in one place instead of being retyped in every toolbar.
   */
  onClear?: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  const heading = title ?? t("common.empty");
  const slot =
    action ??
    (onClear ? (
      <button type="button" onClick={onClear}>
        {t("common.clearFilters")}
      </button>
    ) : undefined);
  return (
    <div className={s.empty} data-tone={tone}>
      <Icon name={tone === "filtered" ? "search" : "leaf"} />
      <h3>{heading}</h3>
      {children && <p>{children}</p>}
      {slot && <div className={s.emptyAction}>{slot}</div>}
    </div>
  );
}
export function ResourceState({
  loading,
  error,
  reload,
}: {
  loading: boolean;
  error: string | null;
  reload: () => void;
}) {
  const t = useT();
  return (
    <>
      {loading && (
        <div className={s.loading} role="status">
          <span />
          {t("common.loading")}
        </div>
      )}
      <ErrorNotice message={error} retry={reload} />
    </>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "good" | "bad" | "neutral" | "warn";
}) {
  return <span className={`${s.badge} ${s[tone]}`}>{children}</span>;
}
export function Panel({
  title,
  hint,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${s.panel} ${className}`}>
      <div className={s.panelHeading}>
        <h2>{title}</h2>
        {hint && <span>{hint}</span>}
      </div>
      {children}
    </section>
  );
}
export { Fields, DataValue, profileLabel } from "./values";
export function Drawer({
  title,
  children,
  onClose,
  dismissDisabled = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  dismissDisabled?: boolean;
  className?: string;
}) {
  const t = useT();
  const exiting = useExiting();
  const ref = useRef<HTMLDialogElement>(null);
  const outside = useRef(false);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const active = document.activeElement;
    dialog.showModal();
    const unlock = lockPage();
    return () => {
      dialog.close();
      unlock();
      if (active instanceof HTMLElement && active.isConnected)
        active.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      className={`${s.modalOverlay} ${exiting ? s.exiting : ""}`}
      data-phase={exiting ? "exiting" : "open"}
      ref={ref}
      aria-labelledby={id}
      onPointerDown={(e) => {
        outside.current = e.button === 0 && e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const dismiss = outside.current && e.target === e.currentTarget;
        outside.current = false;
        if (dismiss && !dismissDisabled && !exiting) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (!dismissDisabled && !exiting) onClose();
      }}
    >
      <section className={`${s.drawer} ${className}`} inert={exiting}>
        <div className={s.drawerHead}>
          <h2 id={id}>{title}</h2>
          <button
            type="button"
            aria-label={t("common.closeDrawer")}
            disabled={dismissDisabled}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className={s.drawerBody}>{children}</div>
      </section>
    </dialog>
  );
}
/** A skeleton cell shape, matching what the column will actually paint. */
export type SkeletonCell = "text" | "badge" | "twoLine";

const SKELETON_ROWS = 6;
/**
 * Width classes cycle so a column of skeletons does not read as one grey block.
 * Looked up through `s` on purpose: CSS Modules hashes the class name, so a raw
 * "skeleton-w-40" literal would never match the emitted "_skeleton-w-40_xxxx".
 */
const CELL_WIDTHS: Record<SkeletonCell, string[]> = {
  text: [s["skeleton-w-40"], s["skeleton-w-65"], s["skeleton-w-50"]],
  badge: [s["skeleton-w-pill"]],
  twoLine: [s["skeleton-w-50"], s["skeleton-w-40"]],
};

/**
 * Skeleton placeholders reserve the painted space so loading states never shift the
 * layout (no CLS, no spinner jump) — the shape users will see is the shape they get.
 *
 * The table variant takes the column shapes and the row height, because "a row of
 * four equal bars" was 44px tall against a real 87px row: the first payload moved
 * every row down by 43px. A skeleton that is the wrong height is a layout shift
 * with extra steps.
 */
export function Skeleton({
  variant = "line",
  label = "内容加载中",
  className = "",
  cells,
  rowHeight,
}: {
  variant?: "line" | "card" | "chart" | "table";
  label?: string;
  className?: string;
  /** Table only: the shape of each column, in column order. */
  cells?: SkeletonCell[];
  /** Table only: height of one skeleton row; must match the real row height. */
  rowHeight?: number;
}) {
  const shapes = cells?.length ? cells : (["text", "badge", "twoLine", "text"] as SkeletonCell[]);
  return (
    <div
      className={`${s.skeleton} ${s[`skeleton-${variant}`] ?? ""} ${className}`}
      role="status"
      aria-label={label}
      aria-busy="true"
    >
      {variant === "table" &&
        Array.from({ length: SKELETON_ROWS }, (_, row) => (
          <div
            className={s.skeletonRow}
            key={row}
            aria-hidden="true"
            // One column per real column: the old fixed four-column grid wrapped a
            // six-column table's cells onto a second line inside the same 87px row,
            // so the skeletons read as a jumble instead of as rows.
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
    </div>
  );
}

/**
 * Live ticking countdown for epoch-second (or epoch-ms) deadlines.
 *
 * The tick comes from the process-wide clock in hooks.ts, not from a per-instance
 * interval: a lock table renders two countdowns per row, and one timer each meant
 * 2N timers fighting over 2N independent re-render schedules. The absolute end
 * time stays available in a tooltip.
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
  // A countdown with no deadline has nothing to tick: subscribe only while live,
  // so a table full of finished cooldowns holds zero timers.
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
 * The shared snapshot layer answers a navigation inside its TTL without touching
 * the network (that is the point), so a page can legitimately show data that is a
 * few seconds old. Saying so out loud is the difference between "fast" and "stale".
 *
 * The tick comes from the shared clock, so this is one leaf span re-rendering per
 * second — not the page. It also unsubscribes once the age passes a minute, at
 * which point the exact second stops mattering and the hint goes static.
 */
export function FreshnessHint({ path }: { path: string }) {
  const age = snapshotAge(path);
  // Subscribing is conditional: a fresh page (or one with no snapshot yet) does not
  // need a timer, and neither does a snapshot old enough to be described coarsely.
  const now = useNow(age !== null && age.ageMs < 60_000);
  if (age === null) return null;
  void now;
  return (
    <span className={s.muted} title={new Date(age.fetchedAt).toLocaleString("zh-CN")}>
      数据更新于 {sinceText(age.fetchedAt)}
    </span>
  );
}

export const CLEAR_CONFIRMATION = "清空全部日志与统计";
export function ClearLogs({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [scope, setScope] = useState<"details" | "all">("details");
  const [confirmation, setConfirmation] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Drawer title={t("logs.clear")} onClose={onClose} dismissDisabled={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const currentKey = key;
          setKey("");
          void api
            .post("/logs/clear", {
              scope,
              confirmation: scope === "all" ? confirmation : "",
              ...(scope === "all" ? { api_key: currentKey } : {}),
            })
            .then((response) => {
              if (object(response.data).ok !== true) throw new Error(t("logs.clear.unconfirmed"));
              onDone();
              onClose();
            })
            .catch((err: unknown) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <label className={s.field}>
          {t("logs.clear.scope")}
          <select
            value={scope}
            onChange={(e) => {
              setScope(e.target.value as "details" | "all");
              setConfirmation("");
              setKey("");
            }}
          >
            <option value="details">{t("logs.clear.detailsOnly")}</option>
            <option value="all">{t("logs.clear.everything")}</option>
          </select>
        </label>
        <div className={s.warning}>
          <Icon name="alert" />
          <div>
            <strong>{scope === "all" ? CLEAR_CONFIRMATION : t("logs.clear.detailsStrong")}</strong>
            <p>{scope === "all" ? t("logs.clear.allWarning") : t("logs.clear.detailsWarning")}</p>
          </div>
        </div>
        {scope === "all" && (
          <>
            <label className={s.field}>
              输入“{CLEAR_CONFIRMATION}”
              <input
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className={s.field}>
              {t("common.currentApiKey")}
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                required
              />
            </label>
          </>
        )}
        <ErrorNotice message={error} />
        <button
          className={s.danger}
          disabled={busy || (scope === "all" && (confirmation !== CLEAR_CONFIRMATION || !key))}
        >
          {busy ? t("logs.clear.busy") : t("logs.clear.confirm")}
        </button>
      </form>
    </Drawer>
  );
}
