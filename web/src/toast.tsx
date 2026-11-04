/**
 * Legacy surface, now a shell over ui/Toast.
 *
 * The queue (life times, the four-notice cap, "a key replaces its predecessor", the newest
 * host wins) lives in ui/Toast.tsx, unchanged from this file. `notify`, `dismiss`,
 * `clearToasts` and `ToastRegion` keep their names and signatures, so pages, drawers and
 * test-setup.ts keep working without touching a call site.
 */
export { clearToasts, dismiss, notify, ToastRegion } from "./ui";
export type { ToastInput as Toast, ToastTone } from "./ui";
