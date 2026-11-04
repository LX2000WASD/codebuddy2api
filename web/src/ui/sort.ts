import type { TableSort } from "./Table";

/**
 * Sorting state, comparison and the header click rule — the part every sortable list shares.
 *
 * Table owns the header interaction (it reports `onSort(columnId)`) but not the row order:
 * pages that sort a server page or keep sorting in the URL must apply it themselves. Without
 * this module each page re-implements "numbers numerically, strings by locale, missing values
 * sink, first click is descending for numeric columns" and the five lists drift apart.
 */

/**
 * One comparator for every column. Numbers compare numerically (so "10" lands after "9"),
 * strings compare with localeCompare (so mixed-case model ids stay readable, which raw
 * codepoint order does not). Missing values sink to the bottom in both directions — a model
 * without a reported rate must not pose as the cheapest.
 */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = typeof a === "number" ? `${a}` : typeof a === "string" ? a : "";
  const right = typeof b === "number" ? `${b}` : typeof b === "string" ? b : "";
  return left.localeCompare(right);
}

/** The value a column sorts by; a column without one is not sortable. */
export type SortValue<T> = ((row: T) => number | string | undefined) | undefined;

/**
 * Orders rows the page sorts itself.
 *
 * A list that pages on the client has to sort *before* it slices, otherwise the sort only
 * reorders the visible page and everything reshuffles on "next". This runs the same
 * comparator as the table, so a page-level sort and a header sort never disagree.
 */
export function sortRows<T>(rows: T[], values: Record<string, SortValue<T>>, sort: TableSort): T[] {
  const value = sort ? values[sort.id] : undefined;
  if (!sort || !value) return rows;
  const direction = sort.desc ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    // Unknown values sink to the bottom in both directions, matching the header sort.
    if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
    if (b === undefined || b === null) return -1;
    return direction * compareValues(a, b);
  });
}

/**
 * What a header click means: a new column starts at its own first direction (descending for
 * counts, ascending for identifiers), and clicking the active column flips it. It never
 * returns to "unsorted" — the natural order of a catalog is a data property, not a view the
 * user can toggle into.
 */
export function nextSort(
  sort: TableSort,
  columnId: string,
  descFirst = false,
): NonNullable<TableSort> {
  if (!sort || sort.id !== columnId) return { id: columnId, desc: descFirst };
  return { id: columnId, desc: !sort.desc };
}
