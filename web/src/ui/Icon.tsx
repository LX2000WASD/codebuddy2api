import type { SVGProps } from "react";
import s from "./Icon.module.scss";

/**
 * Every glyph the console draws, in one 24x24 stroke set.
 *
 * The set is data, not markup: a page names a glyph and the shared attributes (stroke
 * width, cap, join, currentColor) come from the stylesheet, so a new icon cannot arrive
 * with a different line weight than its neighbours.
 */
const PATHS = {
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  model: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  key: "M14 4a6 6 0 1 1-3 11l-6 6H2v-3l6-6a6 6 0 0 1 6-8Z M16 8h.01",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  lock: "M6 10V7a6 6 0 0 1 12 0v3m-13 0h14v11H5V10Zm7 5v3",
  eye: "M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff:
    "m3 3 18 18M10.6 5.4A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a18 18 0 0 1-3.1 3.7M6.1 6.1C3.9 7.6 2.5 12 2.5 12s3.5 7 9.5 7c1.4 0 2.7-.4 3.8-.9",
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
  chart: "M4 20h16M7 20v-6M12 20V6M17 20v-10",
  pulse: "M2 12h4l3-8 4 16 3-8h6",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10.3 21a2 2 0 0 0 3.4 0",
  coin: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  down: "M12 3v12m0 0 4-4m-4 4-4-4M5 21h14",
  up: "M12 21V9m0 0 4 4m-4-4-4 4M5 3h14",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4.5V12l3 2",
  restore: "M3 12a9 9 0 1 0 2.6-6.4L3 8m0-5v5h5",
  globe:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c2.3 2.4 3.5 5.4 3.5 9s-1.2 6.6-3.5 9c-2.3-2.4-3.5-5.4-3.5-9s1.2-6.6 3.5-9Z",
  // Feather's "github" mark (MIT), drawn in the same stroke style as the rest of the set.
  github:
    "M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22",
  cache:
    "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3Zm8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6m16 6c0 1.7-3.6 3-8 3s-8-1.3-8-3",
  database:
    "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Zm-8 2v9c0 1.7 3.6 3 8 3s8-1.3 8-3v-9M4 14.5c0 1.7 3.6 3 8 3s8-1.3 8-3",
  // "Filtered, nothing matched": a magnifier, distinct from the leaf used for "nothing here yet".
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4 4",
  image:
    "M3 5.5h18v13H3v-13Zm3.5 10 3-3.5 2.5 3 3.5-4.5 3.5 5M8.8 9.2a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z",
  play: "M8 5.5v13l11-6.5-11-6.5Z",
  chevron: "m6 9 6 6 6-6",
  check: "m5 12.5 4.5 4.5L19 7.5",
  menu: "M4 7h16M4 12h16M4 17h16",
  more: "M6 12h.01M12 12h.01M18 12h.01",
} as const;

export type IconName = keyof typeof PATHS;

export type IconProps = {
  name?: IconName;
  /**
   * Accessible name. A glyph standing alone (an icon button) passes its label here or on
   * the button; a decorative glyph inside labelled text leaves this out and is hidden
   * from the accessibility tree instead of reading as an unlabelled graphic.
   */
  label?: string;
  size?: "xs" | "sm" | "md" | "lg";
  /** Turns the glyph while the state it tracks settles (refresh). Off in reduced motion. */
  spin?: boolean;
  className?: string;
} & Omit<SVGProps<SVGSVGElement>, "name" | "children" | "ref">;

export function Icon({
  name = "grid",
  label,
  size = "md",
  spin = false,
  className = "",
  ...rest
}: IconProps) {
  const decorative = label === undefined;
  return (
    <svg
      className={className ? `${s.icon} ${className}` : s.icon}
      data-size={size}
      data-spin={spin ? "true" : undefined}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={decorative ? undefined : "img"}
      aria-label={label}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name] ?? PATHS.grid} />
    </svg>
  );
}
