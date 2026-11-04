import { useT } from "./i18n";
import {
  Badge as UiBadge,
  Button,
  Drawer as UiDrawer,
  Empty as UiEmpty,
  ErrorNotice as UiErrorNotice,
  Icon as UiIcon,
  Page,
  Skeleton as UiSkeleton,
  type BadgeTone,
  type EmptyTone as UiEmptyTone,
  type IconName,
  type IconProps,
  type SkeletonCell as UiSkeletonCell,
} from "./ui";

/**
 * Legacy surface, now a set of adapters.
 *
 * Every implementation moved to ui/ (contract §2: the old modules become thin shells). What
 * is left here is only what the old signatures need and the primitives cannot express without
 * carrying copy: the localized labels. An adapter exists where a primitive's props differ, so
 * the ~40 call sites in pages that have not migrated yet keep compiling unchanged.
 */

export { DrawerPresence } from "./presence";
export {
  ClearLogs,
  CLEAR_CONFIRMATION,
  Countdown,
  FreshnessHint,
  Panel,
  RefreshIcon,
  ResourceState,
} from "./ui";
export { Fields, DataValue, profileLabel } from "./values";

export type { BadgeTone };

/** The shared badge, with the old tone union that pages already pass. */
export const Badge = UiBadge;

/**
 * The glyph set, still accepting a plain string: pages typed their names as `string` before
 * the icon set became a literal union, and narrowing them is each page's own change.
 */
export function Icon({ name, ...rest }: { name?: string } & Omit<IconProps, "name">) {
  return <UiIcon name={(name ?? "grid") as IconName} {...rest} />;
}

/**
 * Retired. It was an absolutely positioned block painted on top of the segment the user had
 * just selected, and it hid that segment's label on every viewport (P1-1) — the bar had no
 * z-index, so the opaque block simply drew over the inline text.
 *
 * The selected segment now paints itself, and `ui/Segmented` does the same with
 * `[aria-pressed="true"]`. The export stays as a no-op while pages still render it.
 */
export function SegmentThumb() {
  return null;
}

/** The page heading: one h1, its description, its controls, and the toast host. */
export function PageTitle({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <Page title={title} description={description} actions={actions}>
      {null}
    </Page>
  );
}

export type EmptyTone = UiEmptyTone;
export type SkeletonCell = UiSkeletonCell;

export function ErrorNotice({ message, retry }: { message: string | null; retry?: () => void }) {
  const t = useT();
  return message ? (
    <UiErrorNotice
      message={message}
      retry={retry && { label: t("common.retry"), onClick: retry }}
    />
  ) : null;
}

export function Empty({
  title,
  tone = "initial",
  action,
  onClear,
  children,
}: {
  title?: string;
  tone?: EmptyTone;
  action?: React.ReactNode;
  onClear?: () => void;
  children?: React.ReactNode;
}) {
  const t = useT();
  return (
    <UiEmpty
      title={title ?? t("common.empty")}
      tone={tone}
      action={
        action ??
        (onClear ? (
          <Button type="button" onClick={onClear}>
            {t("common.clearFilters")}
          </Button>
        ) : undefined)
      }
    >
      {children}
    </UiEmpty>
  );
}

export function Drawer({
  title,
  children,
  onClose,
  dismissDisabled = false,
  className = "",
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  dismissDisabled?: boolean;
  className?: string;
}) {
  const t = useT();
  return (
    <UiDrawer
      title={title}
      closeLabel={t("common.closeDrawer")}
      onClose={onClose}
      dismissDisabled={dismissDisabled}
      className={className}
    >
      {children}
    </UiDrawer>
  );
}

export function Skeleton({
  variant = "line",
  label,
  className = "",
  cells,
  rowHeight,
}: {
  variant?: "line" | "card" | "chart" | "table";
  label?: string;
  className?: string;
  cells?: SkeletonCell[];
  rowHeight?: number;
}) {
  const t = useT();
  return (
    <UiSkeleton
      variant={variant}
      label={label ?? t("common.loading")}
      className={className}
      cells={cells}
      rowHeight={rowHeight}
    />
  );
}
