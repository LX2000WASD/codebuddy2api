/**
 * The design system's public surface: pages and the shell import from "./ui" and nowhere
 * else inside this directory.
 *
 * The stylesheet import is a side effect on purpose. design/base.scss declares the
 * structural tokens (hairlines, control heights, the table's scroll budget) and the three
 * globals the primitives assume (box model, focus ring, thin scrollbars). It is loaded once
 * here instead of being @use'd by every module, which would duplicate the :root block in
 * the bundle. Colour, type size, spacing, radius, motion and z-order stay in theme.scss.
 */
import "../design/base.scss";

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from "./Button";
export {
  Badge,
  Empty,
  ErrorNotice,
  Skeleton,
  type BadgeProps,
  type BadgeTone,
  type EmptyProps,
  type EmptyTone,
  type ErrorNoticeProps,
  type SkeletonCell,
  type SkeletonProps,
} from "./Feedback";
export { Field, type FieldProps } from "./Field";
export { Icon, type IconName, type IconProps } from "./Icon";
export { IconButton, type IconButtonProps } from "./IconButton";
export { Input, type InputProps } from "./Input";
export {
  Cluster,
  Grid,
  Page,
  Split,
  Stack,
  Toolbar,
  type ClusterProps,
  type GridProps,
  type PageProps,
  type SpaceGap,
  type SplitProps,
  type StackProps,
  type ToolbarProps,
} from "./Layout";
export { Dialog, Drawer, DrawerPresence, type OverlayProps } from "./Overlay";
export { Panel, type PanelProps } from "./Panel";
export { Segmented, type SegmentedOption, type SegmentedProps } from "./Segmented";
export { Select, type SelectProps } from "./Select";
export { Switch, type SwitchProps } from "./Switch";
export {
  Table,
  type TableColumn,
  type TableProps,
  type TableSelection,
  type TableSort,
} from "./Table";
export { Textarea, type TextareaProps } from "./Textarea";
export {
  clearToasts,
  dismiss,
  notify,
  ToastRegion,
  type ToastInput,
  type ToastTone,
} from "./Toast";
