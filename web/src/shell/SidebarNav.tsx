import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { useT } from "../i18n";
import { CreditsBadge, CreditsDot, type CreditsAlert } from "../insights";
import { navAreas, navGroups } from "../navigation";
import { Button, Icon } from "../ui";
import s from "./shell.module.scss";

/**
 * The navigation itself: brand, the five task areas in two groups, the updates link
 * and the rail toggle. The same component renders inside the fixed rail and inside the
 * narrow drawer — one markup, so a destination cannot exist in one and be missing from
 * the other.
 *
 * `onNavigate` lets the drawer close itself after a jump; the wide rail passes a no-op.
 */
export function SidebarNav({
  collapsed,
  activeAreaKey,
  updateAvailable,
  creditsAlert,
  onToggle,
  showToggle,
  brandAction,
  onNavigate,
}: {
  /** Icon rail: labels are dropped and the targets keep their hit area. */
  collapsed: boolean;
  activeAreaKey?: string;
  updateAvailable: boolean;
  creditsAlert: CreditsAlert | null;
  onToggle: () => void;
  showToggle: boolean;
  /** Trailing control of the brand row (the drawer's close button). */
  brandAction?: ReactNode;
  onNavigate: () => void;
}) {
  const t = useT();
  const itemClass = (active: boolean) => (active ? `${s.navItem} ${s.active}` : s.navItem);
  return (
    <>
      <div className={s.brandRow}>
        <NavLink
          className={s.brand}
          to="/dashboard"
          aria-label={t("app.brandAria")}
          onClick={onNavigate}
        >
          <span className={s.brandMark}>
            <Icon name="leaf" />
          </span>
          <span className={s.brandText}>
            <span className={s.brandName}>CodeBuddy</span>
            <span className={s.brandSub}>{t("app.brandSubtitle")}</span>
          </span>
        </NavLink>
        {brandAction && <div className={s.brandAction}>{brandAction}</div>}
      </div>
      <nav id="workspace-navigation" className={s.navScroll} aria-label={t("app.primaryNav")}>
        {navGroups.map((group) => (
          <div key={group.key} className={s.navGroup}>
            <p className={s.navLegend}>{t(group.labelKey)}</p>
            <div className={s.navList}>
              {navAreas
                .filter((candidate) => candidate.group === group.key)
                .map((candidate) => {
                  const label = t(candidate.labelKey);
                  return (
                    <NavLink
                      key={candidate.key}
                      to={candidate.path}
                      end={candidate.path === "/dashboard"}
                      aria-label={label}
                      // A folded rail shows the icon alone, so the label moves to the
                      // native tooltip instead of disappearing with the text.
                      title={collapsed ? label : undefined}
                      className={({ isActive }) =>
                        itemClass(isActive || activeAreaKey === candidate.key)
                      }
                      onClick={onNavigate}
                    >
                      <Icon name={candidate.icon} />
                      <span className={s.navText}>{label}</span>
                      {/* Credits expiring inside a week, on the area that owns the
                          credits section. Nothing renders when the snapshot has no
                          expiring account, so a healthy pool has no badge at all. */}
                      {candidate.key === "usage" && creditsAlert && (
                        <span className={s.navBadge}>
                          {collapsed ? (
                            <CreditsDot alert={creditsAlert} />
                          ) : (
                            <CreditsBadge alert={creditsAlert} />
                          )}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
            </div>
          </div>
        ))}
      </nav>
      {/* Release updates are the one destination that is not a task area, so it sits
          beside the navigation rather than inside it: the landmark stays "five areas"
          and the "is anything newer?" hint lives on this link. */}
      <div className={s.navFooter}>
        <NavLink
          to="/dashboard/updates"
          aria-label={
            updateAvailable ? `${t("nav.updates")} · ${t("updates.available")}` : t("nav.updates")
          }
          title={collapsed ? t("nav.updates") : undefined}
          className={({ isActive }) => itemClass(isActive)}
          onClick={onNavigate}
        >
          <Icon name="up" />
          <span className={s.navText}>{t("nav.updates")}</span>
          {updateAvailable && (
            <span className={s.navBadge}>
              <span className={s.updateDot} aria-hidden="true" />
            </span>
          )}
        </NavLink>
        {showToggle && (
          <Button
            block
            icon={collapsed ? "expand" : "collapse"}
            onClick={onToggle}
            aria-label={collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
            aria-expanded={!collapsed}
            aria-controls="workspace-navigation"
          >
            {/* The rail hides the label and keeps the glyph, so the button never has to
                ask for its name twice: aria-label above stays the accessible one. */}
            <span className={s.sidebarBarText}>
              {collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
            </span>
          </Button>
        )}
      </div>
    </>
  );
}
