import type { ComponentType } from "react";
import { Dashboard } from "./pages/Dashboard";
import { Models } from "./pages/Models";
import { Credentials } from "./pages/Credentials";
import { Logs } from "./pages/Logs";
import { Trends } from "./pages/Trends";
import { Credits } from "./pages/Credits";
import { Settings } from "./pages/Settings";
import { Storage } from "./pages/Storage";
import { Alerts } from "./pages/Alerts";
import { Diagnostics } from "./pages/Diagnostics";

/**
 * One table drives the sidebar, the breadcrumb, the in-page section tabs and the
 * command palette, so a destination cannot exist in one of them and be missing from
 * another. The ten former top-level pages survive as *sections* of five task areas:
 * navigation was consolidated, no feature was removed.
 *
 * `legacy` keeps every pre-consolidation URL alive: those routes redirect instead of
 * 404ing, which is what stops bookmarks and shared links from breaking. The set must
 * stay in step with the backend page whitelist (app/gateway_management.py:263) —
 * a path missing there is bounced to /dashboard before the SPA ever loads.
 */
export type NavSection = {
  /** Stable key; also the `?section=` value for areas that hold more than one page. */
  key: string;
  labelKey: string;
  component: ComponentType;
};

export type NavArea = {
  key: string;
  /** Canonical path of the area. */
  path: string;
  labelKey: string;
  icon: string;
  group: NavGroupKey;
  sections: NavSection[];
  /** Old first-level paths that now resolve into this area. */
  legacy: { segment: string; section: string }[];
};

export type NavGroupKey = "run" | "configure";

export const navGroups: { key: NavGroupKey; labelKey: string }[] = [
  { key: "run", labelKey: "nav.groupRun" },
  { key: "configure", labelKey: "nav.groupConfigure" },
];

export const navAreas: NavArea[] = [
  {
    key: "overview",
    path: "/dashboard",
    labelKey: "nav.overview",
    icon: "grid",
    group: "run",
    sections: [{ key: "overview", labelKey: "nav.overview", component: Dashboard }],
    legacy: [],
  },
  {
    key: "requests",
    path: "/dashboard/requests",
    labelKey: "nav.requests",
    icon: "logs",
    group: "run",
    sections: [{ key: "requests", labelKey: "nav.logs", component: Logs }],
    legacy: [{ segment: "logs", section: "requests" }],
  },
  {
    key: "usage",
    path: "/dashboard/usage",
    labelKey: "nav.usage",
    icon: "chart",
    group: "run",
    sections: [
      { key: "trends", labelKey: "nav.trends", component: Trends },
      { key: "credits", labelKey: "nav.credits", component: Credits },
    ],
    legacy: [
      { segment: "trends", section: "trends" },
      { segment: "credits", section: "credits" },
    ],
  },
  {
    key: "routing",
    path: "/dashboard/routing",
    labelKey: "nav.routing",
    icon: "model",
    group: "configure",
    sections: [
      { key: "models", labelKey: "nav.models", component: Models },
      { key: "credentials", labelKey: "nav.credentials", component: Credentials },
    ],
    legacy: [
      { segment: "models", section: "models" },
      { segment: "credentials", section: "credentials" },
    ],
  },
  {
    key: "system",
    path: "/dashboard/system",
    labelKey: "nav.system",
    icon: "settings",
    group: "configure",
    sections: [
      { key: "settings", labelKey: "nav.settings", component: Settings },
      { key: "storage", labelKey: "nav.storage", component: Storage },
      { key: "alerts", labelKey: "nav.alerts", component: Alerts },
      { key: "diagnostics", labelKey: "nav.diagnostics", component: Diagnostics },
    ],
    legacy: [
      { segment: "settings", section: "settings" },
      { segment: "storage", section: "storage" },
      { segment: "alerts", section: "alerts" },
      { segment: "diagnostics", section: "diagnostics" },
    ],
  },
];

/**
 * The area owning a pathname. The longest match wins so /dashboard/routing beats
 * /dashboard; the overview area is the shell root and therefore matches exactly,
 * otherwise every unknown /dashboard/* path would read as "overview".
 */
export function areaForPath(pathname: string): NavArea | undefined {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return [...navAreas]
    .sort((a, b) => b.path.length - a.path.length)
    .find(
      (area) =>
        path === area.path || (area.path !== "/dashboard" && path.startsWith(`${area.path}/`)),
    );
}

/** The section a `?section=` value resolves to; unknown or missing values fall back to the first. */
export function sectionFor(area: NavArea, requested: string | null): NavSection {
  return area.sections.find((section) => section.key === requested) ?? area.sections[0];
}

/**
 * Canonical URL for a section. The first section of an area is the bare area path so
 * the common case has no query string; the others carry `?section=`.
 */
export function sectionTarget(area: NavArea, sectionKey: string): string {
  return area.sections[0]?.key === sectionKey
    ? area.path
    : `${area.path}?section=${encodeURIComponent(sectionKey)}`;
}
