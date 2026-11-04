/**
 * Legacy surface, now a shell.
 *
 * Both controls live in ui/ (contract §2): `ui/Select` is the WAI-ARIA select-only combobox
 * with the same popover placement, and `ui/SearchInput` is the recessed search field. The
 * signatures are unchanged — `Select` still takes `<option>` children and an `aria-label`,
 * `SearchInput` still takes `value`/`onChange`/`aria-label` — so every call site in the pages
 * that have not migrated yet keeps compiling.
 */
export { SearchInput, Select } from "./ui";
export type { SearchInputProps, SelectProps } from "./ui";
