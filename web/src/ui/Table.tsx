import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import s from "./Table.module.scss";

export type TableColumn<T> = {
  /** Stable id: it keys the column, and it is the identity a sort toggle reports. */
  id: string;
  /** Column heading, and the label of the same value in the card layout. */
  header: string;
  /** Render one cell. The value is the row, not a formatted string. */
  cell: (row: T) => ReactNode;
  /** Overrides `header` as the card-layout label. */
  label?: string;
  /** Extra class for the header cell and every body cell of the column. */
  className?: string;
  /** Render the heading as a sort toggle. Needs `onSort`. */
  sortable?: boolean;
  /**
   * The row actions live here. In the table layout the column is pinned to the right edge
   * so scrolling sideways can never hide the only way to act on a row (P1-2); in the card
   * layout it becomes the last pair of the `dl`.
   */
  actions?: boolean;
  /** Leave the column out of the card layout (a redundant id, a decorative glyph). */
  cardHidden?: boolean;
};

/** `desc: true` is descending; a column that has never been sorted is not in the state. */
export type TableSort = { id: string; desc: boolean } | null;

export type TableSelection<T> = {
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /** Accessible name of one row's checkbox ("选择 模型 X"). */
  rowLabel: (row: T) => string;
  /** Accessible name of the header checkbox ("全选当前列表"). */
  selectAllLabel: string;
  /** Render the tri-state header box. Defaults to true. */
  headerCheckbox?: boolean;
};

export type TableProps<T> = {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Accessible name of the table — or of the card list when the viewport is narrow. */
  label: string;
  sort?: TableSort;
  onSort?: (columnId: string) => void;
  /**
   * Accessible name of a sort toggle in the card layout, where there is no header cell to
   * carry `aria-sort`. Defaults to the column label, which loses the direction.
   */
  sortName?: (label: string, direction: "ascending" | "descending" | "none") => string;
  selection?: TableSelection<T>;
  /** Own the vertical scroll box, and with it the sticky header. Defaults to true. */
  scroll?: boolean;
  /** Card layout below this viewport width. Pass 0 to keep rows at every width. */
  cardBelow?: number;
  className?: string;
};

/** The width below which rows become cards (contract §3.5; the shell's $md). */
const CARD_BELOW = 900;

/** Viewport width, subscribed so the layout follows a resize (the same rule dataTable uses). */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

const NOT_OVERFLOWING = { overflowing: false, width: 0 };

function join(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * One table for every list in the console.
 *
 * It owns the three things that keep a wide list usable, because they are the three that
 * were wrong in the old stylesheet:
 *
 * 1. the header sticks inside the scroll box, so the column meaning never scrolls away;
 * 2. the actions column is `position: sticky; right: 0`, so the row's only entry point is
 *    on screen at every horizontal offset — the old table put it last and let it be clipped;
 * 3. the scroll box repeats its horizontal scrollbar as a strip pinned to the *top* of the
 *    table. The scrollbar at the bottom of a 72vh box sat below the fold, which is the
 *    second half of P1-2; the top strip is visible the moment the table is.
 *
 * Below 900px it renders cards instead: one `dl` per row, every column as a dt/dd pair and
 * the actions as the last pair, so a phone shows the operations instead of a clipped column.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  label,
  sort = null,
  onSort,
  sortName,
  selection,
  scroll = true,
  cardBelow = CARD_BELOW,
  className = "",
}: TableProps<T>) {
  const width = useViewportWidth();
  const cards = cardBelow > 0 && width < cardBelow;
  const scroller = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(NOT_OVERFLOWING);

  // The strip only exists while the table really is wider than its box: an empty track
  // under a table that fits would be a permanent line with nothing to drag.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || cards || !scroll) {
      setMeasured((current) => (current.overflowing ? NOT_OVERFLOWING : current));
      return;
    }
    const measure = () =>
      setMeasured((current) => {
        const overflowing = element.scrollWidth > element.clientWidth + 1;
        const contentWidth = element.scrollWidth;
        return current.overflowing === overflowing && current.width === contentWidth
          ? current
          : { overflowing, width: contentWidth };
      });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (table.current) observer?.observe(table.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [cards, scroll, rows.length, columns.length]);

  // The strip is a second viewport onto one scroll offset. The comparison makes the echo
  // terminate: the follower's scroll event finds nothing left to copy and stops there.
  useEffect(() => {
    const element = scroller.current;
    const bar = strip.current;
    if (!element || !bar) return;
    bar.scrollLeft = element.scrollLeft;
    const follow = (from: HTMLElement, to: HTMLElement) => {
      if (Math.abs(to.scrollLeft - from.scrollLeft) < 1) return;
      to.scrollLeft = from.scrollLeft;
    };
    const fromTable = () => follow(element, bar);
    const fromStrip = () => follow(bar, element);
    element.addEventListener("scroll", fromTable, { passive: true });
    bar.addEventListener("scroll", fromStrip, { passive: true });
    return () => {
      element.removeEventListener("scroll", fromTable);
      bar.removeEventListener("scroll", fromStrip);
    };
  }, [measured.overflowing]);

  const ids = rows.map(rowKey);
  const selectedVisible = selection ? ids.filter((id) => selection.selected.has(id)) : [];
  const allSelected = Boolean(selection) && ids.length > 0 && selectedVisible.length === ids.length;
  const someSelected = selectedVisible.length > 0 && !allSelected;
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // `indeterminate` is a DOM property, not something React can set from a prop.
    if (selectAll.current) selectAll.current.indeterminate = someSelected;
  }, [someSelected]);
  const toggleAll = () => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (allSelected) for (const id of ids) next.delete(id);
    else for (const id of ids) next.add(id);
    selection.onChange(next);
  };
  const toggleRow = (id: string) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  };

  const directionOf = (column: TableColumn<T>): "ascending" | "descending" | "none" =>
    sort?.id === column.id ? (sort.desc ? "descending" : "ascending") : "none";
  const arrow = (column: TableColumn<T>) =>
    directionOf(column) === "ascending" ? "▲" : directionOf(column) === "descending" ? "▼" : "↕";

  if (cards) {
    // Actions last even if the page declared that column in the middle: the card reads
    // identity first and the way to act on it at the end.
    const pairs = columns
      .filter((column) => !column.cardHidden)
      .sort((left, right) => Number(left.actions ?? false) - Number(right.actions ?? false));
    return (
      <ul className={join(s.cards, className)} aria-label={label}>
        {rows.map((row) => {
          const id = rowKey(row);
          const selected = selection?.selected.has(id) ?? false;
          return (
            <li key={id} className={s.card} data-selected={selected ? "true" : undefined}>
              {selection && (
                <div className={s.cardHead}>
                  <input
                    type="checkbox"
                    aria-label={selection.rowLabel(row)}
                    checked={selected}
                    onChange={() => toggleRow(id)}
                  />
                </div>
              )}
              <dl className={s.pairs}>
                {pairs.map((column) => {
                  const columnLabel = column.label ?? column.header;
                  const direction = directionOf(column);
                  return (
                    <div
                      key={column.id}
                      className={column.actions ? s.pairActions : s.pair}
                      data-column={column.id}
                    >
                      <dt className={s.cardLabel}>
                        {column.sortable && onSort ? (
                          <button
                            type="button"
                            className={s.cardSort}
                            aria-pressed={direction !== "none"}
                            aria-label={sortName ? sortName(columnLabel, direction) : columnLabel}
                            onClick={() => onSort(column.id)}
                          >
                            {columnLabel}
                            <span className={s.sortArrow} aria-hidden="true">
                              {arrow(column)}
                            </span>
                          </button>
                        ) : (
                          columnLabel
                        )}
                      </dt>
                      <dd className={join(s.cardValue, column.className)}>{column.cell(row)}</dd>
                    </div>
                  );
                })}
              </dl>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className={join(s.wrap, className)} data-scroll={scroll ? "true" : "false"}>
      {scroll && measured.overflowing && (
        <div className={s.strip} ref={strip} aria-hidden="true" tabIndex={-1}>
          <div className={s.stripTrack} style={{ width: measured.width }} />
        </div>
      )}
      <div className={s.scroller} ref={scroller}>
        <table className={s.table} aria-label={label} ref={table}>
          <thead>
            <tr>
              {selection && (
                <th scope="col" className={join(s.headCell, s.selectCell)}>
                  {selection.headerCheckbox === false ? null : (
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
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  className={join(s.headCell, column.actions && s.actionsCell, column.className)}
                  data-column={column.id}
                  aria-sort={directionOf(column) === "none" ? undefined : directionOf(column)}
                >
                  {column.sortable && onSort ? (
                    <button type="button" className={s.sort} onClick={() => onSort(column.id)}>
                      {column.header}
                      <span className={s.sortArrow} aria-hidden="true">
                        {arrow(column)}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const id = rowKey(row);
              const selected = selection?.selected.has(id) ?? false;
              return (
                <tr key={id} className={s.row} data-selected={selected ? "true" : undefined}>
                  {selection && (
                    <td className={join(s.cell, s.selectCell)}>
                      <input
                        type="checkbox"
                        aria-label={selection.rowLabel(row)}
                        checked={selected}
                        onChange={() => toggleRow(id)}
                      />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={join(s.cell, column.actions && s.actionsCell, column.className)}
                      data-column={column.id}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
