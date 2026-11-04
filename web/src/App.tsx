import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from "react-router";
import { api, establishSession, errorMessage, list, object, useSession } from "./api";
import { Button, ErrorNotice, Field, Icon, IconButton } from "./ui";
import { CommandPalette, SIDEBAR_TOGGLE_EVENT, signOut } from "./commandPalette";
import { useCreditsAlert } from "./insights";
import { areaForPath, navAreas, sectionFor, sectionTarget } from "./navigation";
import { TaskArea } from "./taskArea";
import { Keys } from "./pages/Keys";
import { Media } from "./pages/Media";
import { Updates } from "./pages/Updates";
import { Appearance, LanguageToggle } from "./appearance";
import { HeaderBar } from "./shell/HeaderBar";
import { NavigationDrawer } from "./shell/NavigationDrawer";
import { SidebarNav } from "./shell/SidebarNav";
import { useNarrowViewport } from "./shell/useNarrowViewport";
import sh from "./shell/shell.module.scss";
import s from "./app.module.scss";
import { LanguageProvider, chooseLanguage, serverPreference, useT } from "./i18n";

/** The five task areas are the navigation; the ten former pages are sections inside them. */
const legacyRoutes = navAreas.flatMap((area) =>
  area.legacy.map(({ segment, section }) => ({ segment, target: sectionTarget(area, section) })),
);

const noop = () => undefined;

function Shell() {
  const t = useT();
  const location = useLocation();
  const bootstrap = useSession((state) => state.bootstrap);
  const [bootstrapDismissed, setBootstrapDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [palette, setPalette] = useState(false);
  // Below the drawer breakpoint the navigation is a sheet over the page instead of a
  // column beside it; the shell never renders the wide rail in that range, so a
  // narrow viewport cannot end up with a full-width nav block above the data.
  const narrow = useNarrowViewport();
  const [navOpen, setNavOpen] = useState(false);
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
  const toggleRail = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("codebuddy.sidebar.collapsed", String(next));
      } catch {
        /* Session-only preference when storage is unavailable. */
      }
      return next;
    });
  }, []);
  // Leaving the drawer range with the sheet open would keep a modal (and the page
  // scroll lock) behind a layout that has no trigger to close it any more.
  useEffect(() => {
    if (!narrow) setNavOpen(false);
  }, [narrow]);
  // Cmd+K / Ctrl+K opens the palette from anywhere in the shell; Escape closes it and
  // the palette itself handles its own keys once focused. The palette's own "sidebar"
  // action goes through the same handler, so it folds the rail on a wide viewport and
  // opens the navigation sheet on a narrow one instead of doing nothing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((current) => !current);
      }
    };
    const onToggle = () => {
      if (narrow) setNavOpen((current) => !current);
      else toggleRail();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
    };
  }, [narrow, toggleRail]);
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
  const closeNav = useCallback(() => setNavOpen(false), []);
  const signOutNow = () => {
    setBusy(true);
    void signOut()
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  const navigation = (drawer: boolean) => (
    <SidebarNav
      // The rail collapse is a wide-viewport affordance: the sheet is always labelled.
      collapsed={!drawer && collapsed}
      activeAreaKey={area?.key}
      updateAvailable={updateAvailable}
      creditsAlert={creditsAlertData}
      onToggle={toggleRail}
      showToggle={!drawer}
      onNavigate={drawer ? closeNav : noop}
      brandAction={
        drawer ? (
          <IconButton icon="close" label={t("common.closeDrawer")} onClick={closeNav} />
        ) : undefined
      }
    />
  );
  const navMode = narrow ? "drawer" : collapsed ? "rail" : "fixed";
  return (
    <div className={sh.shell} data-nav={navMode}>
      <a href="#main" className={sh.skip}>
        {t("app.skip")}
      </a>
      {narrow ? (
        <NavigationDrawer open={navOpen} onClose={closeNav}>
          {navigation(true)}
        </NavigationDrawer>
      ) : (
        <aside className={sh.sidebar}>{navigation(false)}</aside>
      )}
      <div className={sh.workspace}>
        <HeaderBar
          crumb={crumb}
          narrow={narrow}
          navOpen={navOpen}
          onOpenNav={() => setNavOpen(true)}
          onOpenPalette={() => setPalette(true)}
          busy={busy}
          onSignOut={signOutNow}
        />
        <main id="main" className={sh.main}>
          <div className={sh.content}>
            <ErrorNotice message={error} />
            {/* The default admin password is still in place: the only way to clear this
              banner is to change it on the account tab of the settings area. */}
            {bootstrap && !bootstrapDismissed && (
              <div className={sh.notice} role="status">
                <span>
                  {t("app.bootstrapBanner")}{" "}
                  <NavLink to="/dashboard/system?tab=account">{t("app.bootstrapAction")}</NavLink>
                </span>
                {/* Not an IconButton: the dismiss glyph inherits the banner's own
                    warning colour, which a generic control cannot express. */}
                <button
                  type="button"
                  className={sh.noticeDismiss}
                  aria-label={t("common.dismissNotice")}
                  onClick={() => setBootstrapDismissed(true)}
                >
                  <Icon name="close" />
                </button>
              </div>
            )}
            {/* Keyed by pathname so each navigation replays the enter transition; the
              same class carries the vertical rhythm between sibling blocks. */}
            <div key={location.pathname} className={s.enter}>
              <Outlet />
            </div>
          </div>
        </main>
        <footer className={sh.footer}>
          <div className={sh.content}>CodeBuddy2API</div>
        </footer>
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
      <div className={s.backdrop} aria-hidden="true" />
      <div className={s.appearance}>
        <LanguageToggle />
        <Appearance />
      </div>
      <section className={s.intro}>
        <div className={s.brand}>
          <span className={s.brandIcon}>
            <Icon name="leaf" />
          </span>
          CodeBuddy
        </div>
        <h1>{t("login.subtitle")}</h1>
        <div className={s.orbit} aria-hidden="true">
          <Icon name="leaf" />
        </div>
      </section>
      <section className={shake ? `${s.card} ${s.loginShake}` : s.card}>
        <Icon name="shield" />
        <h2>{t("login.title")}</h2>
        <form
          className={s.form}
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
          <Field label={t("login.username")}>
            <span className={s.inputGroup}>
              <Icon name="user" size="sm" />
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
          </Field>
          <Field label={t("login.password")}>
            <span className={s.inputGroup}>
              <Icon name="lock" size="sm" />
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
              <IconButton
                icon={visible ? "eyeOff" : "eye"}
                label={visible ? t("login.hidePassword") : t("login.showPassword")}
                aria-pressed={visible}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setVisible((value) => !value)}
              />
            </span>
          </Field>
          {caps && (
            <span id="login-caps" className={s.capsHint} role="status">
              <Icon name="alert" size="sm" />
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
          <Button
            type="submit"
            variant="primary"
            block
            disabled={busy || !username.trim() || !password}
            aria-busy={busy}
          >
            {busy ? t("login.verifying") : t("login.enter")}
            <Icon name={busy ? "refresh" : "arrow"} size="sm" spin={busy} />
          </Button>
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
          retry={{
            label: t("common.retry"),
            onClick: () => {
              void establishSession();
            },
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
