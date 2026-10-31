import { useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { api, establishSession, errorMessage, list, object, useSession } from "./api";
import { ErrorNotice, Icon } from "./components";
import { CommandPalette, SIDEBAR_TOGGLE_EVENT, signOut } from "./commandPalette";
import { CreditsBadge, CreditsDot, useCreditsAlert } from "./insights";
import { areaForPath, navAreas, navGroups, sectionFor, sectionTarget } from "./navigation";
import { TaskArea } from "./taskArea";
import { Keys } from "./pages/Keys";
import { Media } from "./pages/Media";
import { Updates } from "./pages/Updates";
import { Appearance, LanguageToggle } from "./appearance";
import s from "./ui.module.scss";
import { LanguageProvider, chooseLanguage, serverPreference, useT } from "./i18n";

/** The five task areas are the navigation; the ten former pages are sections inside them. */
const legacyRoutes = navAreas.flatMap((area) =>
  area.legacy.map(({ segment, section }) => ({ segment, target: sectionTarget(area, section) })),
);

function Shell() {
  const t = useT();
  const location = useLocation();
  const bootstrap = useSession((state) => state.bootstrap);
  const [bootstrapDismissed, setBootstrapDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [palette, setPalette] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  useEffect(() => {
    // Cached server-side; the gateway checks releases in the background.
    void api
      .get<unknown>("/update")
      .then((response) => setUpdateAvailable(object(response.data).update_available === true))
      .catch(() => undefined);
  }, []);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("codebuddy.sidebar.collapsed") === "true";
    } catch {
      return false;
    }
  });
  const toggleSidebar = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("codebuddy.sidebar.collapsed", String(next));
      } catch {
        /* Session-only preference when storage is unavailable. */
      }
      return next;
    });
  };
  // Cmd+K / Ctrl+K opens the palette from anywhere in the shell; Escape closes it and
  // the palette itself handles its own keys once focused.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    const onToggle = () => toggleSidebar();
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
    };
  }, []);
  const area = areaForPath(location.pathname);
  // Shared credential snapshot: on a page that already loaded /admin/credentials
  // this is a TTL hit, and a write anywhere invalidates it — no polling involved.
  const creditsAlertData = useCreditsAlert();
  // The breadcrumb names the task area, then the section when the area holds several.
  // Reading ?section= keeps the crumb in step with the tabs without a second route.
  const crumb = useMemo(() => {
    if (!area) return [t("nav.overview")];
    const section = sectionFor(area, new URLSearchParams(location.search).get("section"));
    return area.sections.length > 1 ? [t(area.labelKey), t(section.labelKey)] : [t(area.labelKey)];
  }, [area, location.search, t]);
  return (
    <div className={`${s.app} ${collapsed ? s.collapsed : ""}`}>
      <a href="#main" className={s.skip}>
        {t("app.skip")}
      </a>
      <aside className={s.sidebar}>
        <div className={s.sidebarHead}>
          <NavLink className={s.brand} to="/dashboard" aria-label={t("app.brandAria")}>
            <span className={s.brandIcon}>
              <Icon name="leaf" />
            </span>
            <span className={s.brandText}>
              CodeBuddy<small>{t("app.brandSubtitle")}</small>
            </span>
          </NavLink>
        </div>
        <nav id="workspace-navigation" aria-label={t("app.primaryNav")}>
          {navGroups.map((group) => (
            <div key={group.key}>
              <p className={s.navLabel}>{t(group.labelKey)}</p>
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
                      title={collapsed ? label : undefined}
                      data-label={label}
                      // The area stays highlighted while any of its sections is open,
                      // so /dashboard/routing?section=credentials does not read as "off".
                      className={({ isActive }) =>
                        `${s.navItem} ${isActive || area?.key === candidate.key ? s.active : ""}`
                      }
                    >
                      <Icon name={candidate.icon} />
                      <span className={s.navText}>{label}</span>
                      {/* Credits expiring inside a week, on the area that owns the
                          credits page. Renders nothing when the snapshot has no
                          expiring account, so a healthy pool has no badge at all. */}
                      {candidate.key === "usage" &&
                        creditsAlertData &&
                        (collapsed ? (
                          // The collapsed strip is 76px wide: no room for a count, so the
                          // dot carries the signal (positioned by .collapsed .navDot).
                          <CreditsDot alert={creditsAlertData} />
                        ) : (
                          <CreditsBadge alert={creditsAlertData} />
                        ))}
                      <span className={s.navArrow}>
                        <Icon name="arrow" />
                      </span>
                    </NavLink>
                  );
                })}
            </div>
          ))}
        </nav>
        {/* Release updates are the one destination that is not a task area, so they sit
            beside the navigation rather than inside it: the landmark stays "five areas"
            (and the "is anything newer?" hint lives on this link). */}
        <NavLink
          to="/dashboard/updates"
          aria-label={
            updateAvailable ? `${t("nav.updates")} · ${t("updates.available")}` : t("nav.updates")
          }
          title={collapsed ? t("nav.updates") : undefined}
          data-label={t("nav.updates")}
          className={({ isActive }) => `${s.navItem} ${isActive ? s.active : ""}`}
        >
          <Icon name="up" />
          <span className={s.navText}>{t("nav.updates")}</span>
          {updateAvailable && <span className={s.navDot} />}
          <span className={s.navArrow}>
            <Icon name="arrow" />
          </span>
        </NavLink>
        <button
          className={s.sidebarBar}
          onClick={toggleSidebar}
          aria-label={collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
          aria-expanded={!collapsed}
          aria-controls="workspace-navigation"
          title={collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
        >
          <span className={s.sidebarBarText}>
            {collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
          </span>
          <Icon name={collapsed ? "expand" : "collapse"} />
        </button>
      </aside>
      <div className={s.workspace}>
        <header className={s.header}>
          <span>
            {t("app.workspace")} <span className={s.separator}>/</span> {crumb.join(" / ")}
          </span>
          <div className={s.actions}>
            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-label={t("command.open")}
              title={t("command.open")}
              aria-keyshortcuts="Meta+K Control+K"
            >
              ⌘K
            </button>
            <LanguageToggle />
            <Appearance />
            <span className={s.session}>
              <span />
              {t("app.sessionActive")}
            </span>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void signOut()
                  .catch((err: unknown) => setError(errorMessage(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("app.signOut")}
            </button>
          </div>
        </header>
        <main id="main" className={s.main}>
          <ErrorNotice message={error} />
          {/* The default admin password is still in place: the only way to clear this
              banner is to change it on the account tab of the settings area. */}
          {bootstrap && !bootstrapDismissed && (
            <div className={s.notice} role="status">
              <span>
                {t("app.bootstrapBanner")}{" "}
                <NavLink to="/dashboard/system?tab=account">{t("app.bootstrapAction")}</NavLink>
              </span>
              <button
                type="button"
                aria-label={t("common.dismissNotice")}
                onClick={() => setBootstrapDismissed(true)}
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          {/* Keyed by pathname so each navigation replays the enter transition; the
              animation is disabled under prefers-reduced-motion (see ui.module.scss). */}
          <div key={location.pathname} className={s.pageEnter}>
            <Outlet />
          </div>
        </main>
        <footer className={s.footer}>CodeBuddy2API</footer>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
function Login() {
  const t = useT();
  const status = useSession((state) => state.status);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [visible, setVisible] = useState(false);
  const [caps, setCaps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (status === "authenticated") return <Navigate to="/dashboard" replace />;
  return (
    <div className={s.login}>
      <div className={s.loginBackdrop} aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className={s.loginAppearance}>
        <LanguageToggle />
        <Appearance />
      </div>
      <section className={s.loginIntro}>
        <div className={s.brand}>
          <span className={s.brandIcon}>
            <Icon name="leaf" />
          </span>
          CodeBuddy
        </div>
        <h1>{t("login.subtitle")}</h1>
        <div className={s.loginOrbit} aria-hidden="true">
          <Icon name="leaf" />
        </div>
      </section>
      <section className={`${s.loginCard} ${shake ? s.loginShake : ""}`}>
        <Icon name="shield" />
        <h2>{t("login.title")}</h2>
        <form
          method="post"
          action="/admin/session"
          onSubmit={(e) => {
            e.preventDefault();
            const passwordInput = e.currentTarget.elements.namedItem(
              "password",
            ) as HTMLInputElement;
            setBusy(true);
            setShake(false);
            setError(null);
            void establishSession({ username, password, remember })
              .then(() => {
                const Credential = (
                  window as unknown as {
                    PasswordCredential?: new (options: {
                      id: string;
                      password: string;
                    }) => Credential;
                  }
                ).PasswordCredential;
                if (Credential && navigator.credentials) {
                  try {
                    const credential = new Credential({ id: username, password });
                    void navigator.credentials.store(credential).catch(() => undefined);
                  } catch {
                    // Native autocomplete remains available when credential storage is rejected.
                  }
                }
              })
              .catch((err: unknown) => {
                setPassword("");
                setError(errorMessage(err));
                setShake(true);
                passwordInput.focus();
              })
              .finally(() => setBusy(false));
          }}
        >
          <label className={s.field}>
            {t("login.username")}
            <span className={s.inputGroup}>
              <Icon name="user" />
              <input
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
              />
            </span>
          </label>
          <label className={s.field}>
            {t("login.password")}
            <span className={s.inputGroup}>
              <Icon name="lock" />
              <input
                name="password"
                type={visible ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("login.passwordPlaceholder")}
                aria-describedby={caps ? "login-caps" : undefined}
                aria-invalid={error ? true : undefined}
                onKeyDown={(e) => setCaps(e.getModifierState("CapsLock"))}
                onKeyUp={(e) => setCaps(e.getModifierState("CapsLock"))}
              />
              <button
                type="button"
                className={s.inputAction}
                onMouseDown={(e) => e.preventDefault()}
                aria-label={visible ? t("login.hidePassword") : t("login.showPassword")}
                aria-pressed={visible}
                onClick={() => setVisible((value) => !value)}
              >
                <Icon name={visible ? "eyeOff" : "eye"} />
              </button>
            </span>
          </label>
          {caps && (
            <span id="login-caps" className={s.capsHint} role="status">
              <Icon name="alert" />
              {t("login.capsLock")}
            </span>
          )}
          <label className={s.check}>
            <input
              type="checkbox"
              name="remember"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {t("login.remember")}
          </label>
          <ErrorNotice message={error} />
          <button
            className={s.primary}
            disabled={busy || !username.trim() || !password}
            aria-busy={busy}
          >
            {busy ? t("login.verifying") : t("login.enter")}
            <Icon name={busy ? "refresh" : "arrow"} />
          </button>
        </form>
      </section>
    </div>
  );
}
export function Guard() {
  const t = useT();
  const { status, error } = useSession();
  if (status === "checking")
    return (
      <div className={s.center} role="status">
        {t("app.verifying")}
      </div>
    );
  if (status === "error")
    return (
      <div className={s.center}>
        <ErrorNotice
          message={error}
          retry={() => {
            void establishSession();
          }}
        />
        <NavLink to="/dashboard/login">{t("app.backToSignIn")}</NavLink>
      </div>
    );
  return status === "authenticated" ? <Outlet /> : <Navigate to="/dashboard/login" replace />;
}
export function AppRoutes() {
  const { search } = useLocation();
  return (
    <Routes>
      <Route path="/dashboard/login" element={<Login />} />
      <Route element={<Guard />}>
        <Route path="/dashboard" element={<Shell />}>
          <Route index element={<TaskArea areaKey="overview" />} />
          {navAreas
            .filter((area) => area.path !== "/dashboard")
            .map((area) => (
              <Route
                key={area.key}
                path={area.path.replace("/dashboard/", "")}
                element={<TaskArea areaKey={area.key} />}
              />
            ))}
          {/* Old URLs keep working: they redirect into the task area that absorbed
              them, so bookmarks and shared links never hit a 404. */}
          {legacyRoutes.map(({ segment, target }) => (
            <Route
              key={segment}
              path={segment}
              // A retired URL that carried its own query (e.g. /dashboard/settings?tab=account)
              // keeps it: the target forwards the search unless it sets one itself.
              element={<Navigate to={target.includes("?") ? target : target + search} replace />}
            />
          ))}
          {/* Pages the consolidated sidebar does not list yet keep their own route, so
              their URLs (e2e suites, shared links) resolve instead of bouncing home. */}
          <Route path="keys" element={<Keys />} />
          <Route path="media" element={<Media />} />
          <Route path="updates" element={<Updates />} />
          <Route path="updates/:tag" element={<Updates />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
export default function App() {
  useEffect(() => {
    void establishSession();
  }, []);
  const status = useSession((state) => state.status);
  useEffect(() => {
    if (status !== "authenticated") return;
    // The stored language wins over the browser cache once the session is known.
    void api
      .get<unknown>("/settings")
      .then((response) => {
        const data = object(response.data);
        const stored = list(data.items).find((item) => item.key === "language");
        if (stored) chooseLanguage(serverPreference(stored.value));
      })
      .catch(() => undefined);
  }, [status]);
  return (
    <LanguageProvider>
      <AppRoutes />
    </LanguageProvider>
  );
}
