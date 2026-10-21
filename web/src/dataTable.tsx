import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  columnVisibilityFeature,
  constructSortFn,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type CellContext,
  type ColumnDef,
  type RowData,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import { Skeleton, type SkeletonCell } from "./components";
import s from "./ui.module.scss";

/** Re-exported so pages can type their sort state without importing the library. */
export type { SortingState } from "@tanstack/react-table";

/**
 * One table engine for every list in the admin UI.
 *
 * Five hand-written tables (models, credentials, logs, diagnostics, credits) had
 * each grown their own sorting, paging, selection and empty state, so the same
 * interaction behaved differently on every page. This module owns the parts that
 * must not diverge: the row model, sorting, column visibility, the tri-state
 * header checkbox, the sticky header and the loading/empty shells.
 *
 * The component carries no copy and no i18n dependency — every user-visible
 * string is a prop — so each page keeps its own vocabulary (the model table says
 * "全选当前列表", the log table has no selection at all).
 *
 * Only the features actually used are registered. TanStack v9 tree-shakes per
 * feature, which is why the whole dependency costs ~14 kB gz instead of the v8
 * monolith's ~40 kB: no pagination (our lists page on the server), no filtering
 * row model (pages pre-filter their rows), no grouping, no pinning.
 */
/**
 * One comparator for every column, because our sortable values are either counts
 * or identifiers. Numbers compare numerically (so "10" lands after "9"), strings
 * compare with localeCompare (so mixed-case model ids stay readable, which raw
 * codepoint order does not). Missing values sink to the bottom in both
 * directions — a model without a reported rate should not pose as the cheapest.
 */
function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  // Every sortable column declares a number or a string, so this narrows to the
  // two shapes the pages actually produce instead of stringifying arbitrary data.
  const left = typeof a === "number" ? `${a}` : typeof a === "string" ? a : "";
  const right = typeof b === "number" ? `${b}` : typeof b === "string" ? b : "";
  return left.localeCompare(right);
}
const compareMixed = constructSortFn({ sort: compareValues });

/**
 * Orders rows the page sorts itself (`manualSorting`).
 *
 * The credentials list pages on the client, so its sort has to run *before* the
 * slice: sorting inside the table would only reorder the visible page and then
 * reshuffle it on "next". This runs the exact comparator and `sortUndefined`
 * rule the table uses, so a page-level sort and a table-level sort never disagree.
 */
export function sortRows<T extends RowData>(
  rows: T[],
  sortValues: Record<string, ((row: T) => number | string | undefined) | undefined>,
  sorting: SortingState,
): T[] {
  const [active] = sorting;
  const value = active ? sortValues[active.id] : undefined;
  if (!active || !value) return rows;
  const direction = active.desc ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    // Unknown values sink to the bottom in both directions, matching the table.
    if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
    if (b === undefined || b === null) return -1;
    return direction * compareValues(a, b);
  });
}

/** Per-column metadata; the cell renderer is data, not an element type. */
type ColumnMeta = {
  render?: (row: unknown) => ReactNode;
  className?: string;
};

const features = tableFeatures({
  rowSortingFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { mixed: compareMixed },
  columnMeta: {} as ColumnMeta,
});

/**
 * The single cell component for every column.
 *
 * `flexRender` turns `columnDef.cell` into `React.createElement(cell, props)`, so the
 * function identity *is* the element type: a per-column arrow function makes React
 * treat every column as a different component and unmount/remount the whole cell
 * subtree whenever the column definitions are rebuilt. That is not a theoretical
 * concern — it detached the row buttons from the DOM mid-test ("element is not
 * attached to the DOM") and would silently drop focus and the scroll anchor.
 *
 * Reading the renderer out of `columnDef.meta` keeps this component type stable
 * forever; only the value it returns changes.
 */
function TableCell<T extends RowData>(context: CellContext<typeof features, T, unknown>) {
  const render = context.column.columnDef.meta?.render;
  return render ? render(context.row.original) : null;
}

export type DataTableColumn<T extends RowData> = {
  /** Stable id: it is the sort key, the visibility key and the persisted key. */
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /**
   * Comparable value for this column. A column without one is not sortable —
   * its header renders as plain text instead of a button that does nothing.
   */
  sortValue?: (row: T) => number | string | undefined;
  /** Numeric columns usually read best largest-first. */
  sortDescFirst?: boolean;
  /**
   * Where rows without a value go. Defaults to TanStack's behaviour (undefined is
   * passed to the comparator like any other value), which makes "no rate reported"
   * sort as the cheapest model. `last` keeps unknown rows at the bottom in both
   * directions, which is the honest reading for a column that may be missing.
   */
  sortUndefined?: "first" | "last";
  /** Appears in the column-visibility menu. */
  optional?: boolean;
  /**
   * Hidden by default below this viewport width. The model table forced a
   * horizontal scroll on narrow screens; axonhub solves the same problem by
   * dropping secondary columns at a breakpoint instead of making the user scroll.
   */
  hideBelow?: number;
  className?: string;
};

/** Viewport width, subscribed so breakpoint defaults follow a window resize. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function readHidden(storageKey: string): string[] | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((key): key is string => typeof key === "string");
  } catch {
    return null;
  }
}

function writeHidden(storageKey: string, hidden: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(hidden));
  } catch {
    /* A browser with storage disabled keeps the in-memory choice for this visit. */
  }
}

function defaultsFor<T extends RowData>(
  columns: DataTableColumn<T>[],
  defaultHidden: string[],
  width: number,
): string[] {
  const narrow = columns
    .filter((column) => column.hideBelow !== undefined && width < column.hideBelow)
    .map((column) => column.id);
  return [...new Set([...defaultHidden, ...narrow])];
}

export type ColumnVisibility = {
  hidden: string[];
  toggle: (id: string) => void;
};

/**
 * Persisted column visibility, owned by the page so it can render the menu inside
 * its own toolbar (the model page has a dense filter bar there already).
 *
 * An untouched table follows the page defaults plus the breakpoint rule, so a
 * narrow window hides secondary columns without the user doing anything. The
 * first explicit toggle freezes the resulting list as that browser's choice,
 * which is why the storage write happens only on toggle.
 */
export function useColumnVisibility<T extends RowData>({
  storageKey,
  columns,
  defaultHidden = [],
}: {
  storageKey: string;
  columns: DataTableColumn<T>[];
  defaultHidden?: string[];
}): ColumnVisibility {
  const width = useViewportWidth();
  const [hidden, setHidden] = useState<string[]>(() => {
    const saved = readHidden(storageKey);
    return saved ?? defaultsFor(columns, defaultHidden, width);
  });
  const touched = useRef(readHidden(storageKey) !== null);
  /**
   * The defaults are compared as a string, not by identity: callers pass a fresh
   * array literal on every render ("defaultHidden: ['context']"), and an effect
   * keyed on that identity would set state forever.
   */
  const wanted = defaultsFor(columns, defaultHidden, width).join("\u0000");
  useEffect(() => {
    if (touched.current) return;
    const next = wanted ? wanted.split("\u0000") : [];
    setHidden((old) => (old.join("\u0000") === wanted ? old : next));
  }, [wanted]);
  const toggle = (id: string) => {
    touched.current = true;
    setHidden((old) => {
      const next = old.includes(id) ? old.filter((value) => value !== id) : [...old, id];
      writeHidden(storageKey, next);
      return next;
    });
  };
  return { hidden, toggle };
}

/**
 * Column visibility menu. `<details>` is keyboard reachable but cannot close on
 * Escape or return focus, so this is a real button + menu with the drawer's
 * keyboard contract.
 */
export function ColumnMenu({
  label,
  columns,
  hidden,
  onToggle,
}: {
  label: string;
  columns: { id: string; header: string }[];
  hidden: string[];
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);
  if (!columns.length) return null;
  return (
    <div className={s.colVis}>
      <button
        type="button"
        ref={trigger}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && (
        <div className={s.colVisMenu} ref={menu} role="group" aria-label={label}>
          {columns.map((column) => (
            <label key={column.id}>
              <input
                type="checkbox"
                checked={!hidden.includes(column.id)}
                onChange={() => onToggle(column.id)}
              />
              {column.header}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── View state in the URL ──────────────────────────────────────────────────
 *
 * Sorting and filters belong to the address bar: they are the two things a user
 * wants to keep across a refresh and paste into a chat ("look at this filter").
 * The state lives in the query string rather than in react-router because these
 * hooks are also used by pages rendered without a router (every unit test mounts
 * the page bare), and a hook that throws outside a Router is not an option.
 *
 * replaceState, not pushState: a filter change is not a navigation, and polluting
 * the back button with one entry per keystroke-delimited keystroke is hostile.
 */
const urlListeners = new Set<() => void>();
function urlEmit() {
  for (const listener of urlListeners) listener();
}
function urlSubscribe(listener: () => void) {
  urlListeners.add(listener);
  // Back/forward still has to refresh the derived state even though we never push.
  window.addEventListener("popstate", urlEmit);
  return () => {
    urlListeners.delete(listener);
    window.removeEventListener("popstate", urlEmit);
  };
}
const urlSnapshot = () => (typeof window === "undefined" ? "" : window.location.search);
const urlServerSnapshot = () => "";

export type UrlParams = {
  /** The raw query string this snapshot was built from (identity for memo deps). */
  search: string;
  get: (key: string) => string | null;
  getAll: (key: string) => string[];
};

function makeParams(search: string): UrlParams {
  const params = new URLSearchParams(search);
  return {
    search,
    get: (key) => params.get(key),
    getAll: (key) => params.getAll(key),
  };
}

/**
 * Writes view state into the query string. An empty string (or null) removes the
 * key, so a reset leaves a clean, shareable URL instead of "?q=&region=".
 */
export function writeUrlParams(patch: Record<string, string | string[] | null>) {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(patch)) {
    params.delete(key);
    if (value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item) params.append(key, item);
    } else params.set(key, value);
  }
  const search = params.toString();
  if (search === window.location.search.replace(/^\?/, "")) return;
  const { pathname, hash } = window.location;
  window.history.replaceState(
    window.history.state,
    "",
    `${pathname}${search ? `?${search}` : ""}${hash}`,
  );
  urlEmit();
}

/** Drops every query parameter. Test seam: module state must not leak between cases. */
export function resetUrlState() {
  if (typeof window === "undefined") return;
  const { pathname, hash } = window.location;
  if (!window.location.search) return;
  window.history.replaceState(window.history.state, "", `${pathname}${hash}`);
  urlEmit();
}

/** Current query string as a stable snapshot; re-renders on write and on popstate. */
export function useUrlParams(): UrlParams {
  const search = useSyncExternalStore(urlSubscribe, urlSnapshot, urlServerSnapshot);
  return useMemo(() => makeParams(search), [search]);
}

export type DataTableProps<T extends RowData> = {
  rows: T[];
  columns: DataTableColumn<T>[];
  /** Column ids to hide; pair with useColumnVisibility(). */
  hidden?: string[];
  rowId: (row: T) => string;
  /** Controlled sorting, so the page can keep it in the URL. */
  sorting: SortingState;
  onSortingChange: (next: SortingState) => void;
  /** Renders a leading checkbox column when present. */
  selection?: {
    selected: ReadonlySet<string>;
    onChange: (next: ReadonlySet<string>) => void;
    /** Accessible name of a row checkbox: `选择 {label}`. */
    rowLabel: (row: T) => string;
    selectAllLabel: string;
    /**
     * Render the tri-state select-all box in the header. Defaults to true.
     *
     * The credentials list turns it off because its toolbar already carries a
     * select-all with a *different* meaning — every account in the pool, not the
     * rows of the current page. Two boxes that select different sets on one
     * screen is worse than one, so the page keeps its own and the table drops
     * its header box while still owning the row checkboxes and the highlight.
     */
    headerCheckbox?: boolean;
  };
  loading?: boolean;
  loadingLabel?: string;
  /**
   * The page's own load error.
   *
   * An empty table and a failed request are different facts, and the table cannot
   * tell them apart from `rows.length`: the failed fetch leaves `rows` empty too, so
   * every 500 used to paint the "no matching rows" empty state underneath the error
   * banner — the page said both "the audit store is down" and "your filter matched
   * nothing" at the same time. When this is set the table renders neither the rows
   * nor the empty slot: the page already shows the error with its retry button.
   */
  error?: string | null;
  /** Rendered instead of the table when the current filter leaves nothing. */
  empty?: ReactNode;
  /** Table skeleton row height in px; defaults to 87 (measured /dashboard/requests). */
  rowHeight?: number;
  /** Table skeleton column shapes, in column order. */
  skeletonCells?: SkeletonCell[];
  /** Own scroll box with a sticky header (long, interactive tables). */
  scroll?: boolean;
  /**
   * The page sorts `rows` itself.
   *
   * Lists that page on the client need this: sorting inside the table would only
   * reorder the visible page and then reshuffle it when the user presses "next".
   * The header interaction and `aria-sort` stay here — the table still owns the
   * sort state, it just does not apply it.
   */
  manualSorting?: boolean;
  className?: string;
};

export function DataTable<T extends RowData>({
  rows,
  columns,
  hidden = [],
  rowId,
  sorting,
  onSortingChange,
  selection,
  loading = false,
  loadingLabel,
  error = null,
  empty,
  rowHeight = 87,
  skeletonCells,
  scroll = false,
  manualSorting = false,
  className = "",
}: DataTableProps<T>) {
  const columnVisibility = useMemo(() => {
    const state: Record<string, boolean> = {};
    for (const column of columns) if (hidden.includes(column.id)) state[column.id] = false;
    return state;
  }, [columns, hidden]);

  const columnDefs = useMemo<ColumnDef<typeof features, T>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: column.header,
        // Every column gets an accessor because TanStack only treats a column as
        // sortable when it has one; `enableSorting` below is the real switch.
        // The value stays `undefined` (not null) so `sortUndefined` can route
        // "unknown" rows to the bottom instead of letting them sort as zero.
        accessorFn: (row: T) => column.sortValue?.(row),
        enableSorting: Boolean(column.sortValue),
        sortDescFirst: column.sortDescFirst ?? false,
        sortUndefined: column.sortUndefined,
        sortFn: "mixed",
        // `cell` stays the module-level TableCell for every column; the per-column
        // renderer travels in meta so the element type never changes identity.
        cell: TableCell as (context: CellContext<typeof features, T, unknown>) => ReactNode,
        meta: {
          render: (row: unknown) => column.cell(row as T),
          className: column.className,
        },
      })),
    [columns],
  );

  const table = useTable({
    features,
    columns: columnDefs,
    data: rows,
    getRowId: (row: T) => rowId(row),
    state: { sorting, columnVisibility },
    onSortingChange: (updater: Updater<SortingState>) =>
      onSortingChange(typeof updater === "function" ? updater(sorting) : updater),
    // A third click returns to ascending rather than to "unsorted": the catalog's
    // natural order is a data property, not a view the user can toggle into.
    enableSortingRemoval: false,
    enableMultiSort: false,
    manualSorting,
  });

  const classes = useMemo(
    () => new Map(columns.map((column) => [column.id, column.className])),
    [columns],
  );
  const headerGroups = table.getHeaderGroups();
  const modelRows = table.getRowModel().rows;
  const visibleIds = modelRows.map((row) => row.id);
  const selectedVisible = selection ? visibleIds.filter((id) => selection.selected.has(id)) : [];
  const allSelected =
    Boolean(selection) && visibleIds.length > 0 && selectedVisible.length === visibleIds.length;
  const someSelected = selectedVisible.length > 0 && !allSelected;
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // `indeterminate` is a DOM property, not a prop React can set on a checkbox.
    if (selectAll.current) selectAll.current.indeterminate = someSelected;
  }, [someSelected]);
  const showSelectAll = Boolean(selection) && selection?.headerCheckbox !== false;
  const toggleAll = () => {
    if (!selection) return;
    const next = new Set(selection.selected);
    // The header box means "every row the current filter leaves on screen" — never
    // the whole catalog, which is what the model page's bulk action must replay.
    if (allSelected) for (const id of visibleIds) next.delete(id);
    else for (const id of visibleIds) next.add(id);
    selection.onChange(next);
  };
  const toggleRow = (id: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  };

  // A failed load is not an empty result: the page renders the error and its retry
  // button, so the table must not add "no matching rows" underneath it. Checked
  // before the skeleton too — `loading` stays false after a rejection, but a page
  // that reloads after an error would otherwise flash the skeleton under the banner.
  //
  // Only the empty slot is suppressed, not the table: a reload that fails after a
  // successful load keeps its rows (useResource holds the previous payload), and
  // stale rows under an error banner beat a blank panel.
  if (error && !modelRows.length) return null;
  if (loading && !rows.length)
    return (
      <Skeleton variant="table" label={loadingLabel} rowHeight={rowHeight} cells={skeletonCells} />
    );
  if (!modelRows.length) return <>{empty}</>;

  return (
    <div className={className}>
      <div className={scroll ? `${s.tableWrap} ${s.tableScroll}` : s.tableWrap}>
        <table>
          <thead>
            {headerGroups.map((group) => (
              <tr key={group.id}>
                {selection && (
                  <th scope="col" className={s.selectCell}>
                    {showSelectAll && (
                      <input
                        ref={selectAll}
                        type="checkbox"
                        aria-label={selection.selectAllLabel}
                        checked={allSelected}
                        onChange={toggleAll}
                      />
                    )}
                  </th>
                )}
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const sortable = header.column.getCanSort();
                  const label = columns.find((column) => column.id === header.column.id)?.header;
                  return (
                    <th
                      key={header.id}
                      scope="col"
                      className={classes.get(header.column.id)}
                      // aria-sort belongs on the header cell, not on the button.
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                    >
                      {sortable ? (
                        <button
                          type="button"
                          className={sorted ? `${s.tableSort} ${s.tableSortActive}` : s.tableSort}
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {label}
                          <span className={s.tableSortArrow} aria-hidden="true">
                            {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}
                          </span>
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {modelRows.map((row) => (
              <tr
                key={row.id}
                className={selection?.selected.has(row.id) ? s.selectedRow : undefined}
              >
                {selection && (
                  <td className={s.selectCell}>
                    <input
                      type="checkbox"
                      aria-label={selection.rowLabel(row.original)}
                      checked={selection.selected.has(row.id)}
                      onChange={() => toggleRow(row.id)}
                    />
                  </td>
                )}
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className={classes.get(cell.column.id)}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
