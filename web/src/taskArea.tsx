import { useNavigate, useSearchParams } from "react-router";
import { useT } from "./i18n";
import { navAreas, sectionFor, sectionTarget } from "./navigation";
import s from "./ui.module.scss";

/**
 * Renders one task area: a section switcher (only where the area holds more than one
 * former page) above the active section. The page components themselves are untouched
 * — consolidation moved navigation, not features.
 *
 * The active section lives in `?section=` rather than the path so the backend page
 * whitelist (app/gateway_management.py) stays at one entry per area and a deep link
 * cannot 302 before the SPA boots.
 */
export function TaskArea({ areaKey }: { areaKey: string }) {
  const t = useT();
  const navigate = useNavigate();
  const area = navAreas.find((candidate) => candidate.key === areaKey)!;
  const [params] = useSearchParams();
  const section = sectionFor(area, params.get("section"));
  const Section = section.component;
  return (
    <>
      {area.sections.length > 1 && (
        // A landmark, not role="tab": these buttons change the URL, and pages inside
        // the area carry tablists of their own — two tab roles on one screen would be
        // ambiguous for both assistive tech and the e2e queries.
        <nav
          className={s.sectionNav}
          aria-label={t("app.areaSections", { area: t(area.labelKey) })}
        >
          {area.sections.map((candidate) => {
            const active = candidate.key === section.key;
            return (
              <button
                key={candidate.key}
                type="button"
                aria-current={active ? "page" : undefined}
                className={active ? s.sectionActive : undefined}
                onClick={() => {
                  // replace: switching sections inside one area should not stack
                  // history entries the back button has to unwind one at a time.
                  // sectionTarget is the only place that decides how a section is
                  // addressed, so the tabs and the legacy redirects cannot drift.
                  void navigate(sectionTarget(area, candidate.key), { replace: true });
                }}
              >
                {t(candidate.labelKey)}
              </button>
            );
          })}
        </nav>
      )}
      <Section />
    </>
  );
}
