import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Appearance, LanguageToggle } from "../appearance";
import { useT } from "../i18n";
import { popoverHost, usePopover } from "../popover";
import { Button, IconButton } from "../ui";
import s from "./shell.module.scss";

/**
 * The shell header: where you are, and everything that acts on the whole console.
 *
 * Two shapes, one set of actions. Wide: breadcrumb, palette shortcut, language,
 * appearance, session state, sign out. Below the drawer breakpoint the row would have
 * to clip or squeeze its labels, so the text actions move into one overflow panel and
 * the row keeps icon-sized targets only — nothing becomes half a word.
 */
export function HeaderBar({
  crumb,
  narrow,
  navOpen,
  onOpenNav,
  onOpenPalette,
  busy,
  onSignOut,
}: {
  /** Area, then section for areas that hold several former pages. */
  crumb: string[];
  narrow: boolean;
  navOpen: boolean;
  onOpenNav: () => void;
  onOpenPalette: () => void;
  busy: boolean;
  onSignOut: () => void;
}) {
  const t = useT();
  const tail = crumb.join(" / ");
  return (
    <header className={s.header}>
      <div className={s.content}>
        <div className={s.headerInner}>
          <div className={s.headerStart}>
            {narrow && (
              <IconButton
                icon="menu"
                label={t("app.openNav")}
                aria-expanded={navOpen}
                aria-haspopup="dialog"
                onClick={onOpenNav}
              />
            )}
            {/* The trailing crumb is one text run on purpose: the location reads as a
                sentence ("Workspace / Routing / Credentials") and the full value is in
                the tooltip when the row gets tight. */}
            <nav className={s.breadcrumb} aria-label={t("app.breadcrumb")}>
              {!narrow && (
                <>
                  <span className={s.crumbRoot}>{t("app.workspace")}</span>
                  <span className={s.crumbSep} aria-hidden="true">
                    /
                  </span>
                </>
              )}
              <span className={s.crumb} aria-current="page" title={tail}>
                {tail}
              </span>
            </nav>
          </div>
          <div className={s.headerActions}>
            <Button
              size="sm"
              onClick={onOpenPalette}
              aria-label={t("command.open")}
              title={t("command.open")}
              aria-keyshortcuts="Meta+K Control+K"
            >
              ⌘K
            </Button>
            {narrow ? (
              <OverflowMenu busy={busy} onSignOut={onSignOut} />
            ) : (
              <>
                <LanguageToggle />
                <Appearance />
                <span className={s.session}>
                  <span className={s.sessionDot} aria-hidden="true" />
                  {t("app.sessionActive")}
                </span>
                <Button size="sm" disabled={busy} onClick={onSignOut}>
                  {t("app.signOut")}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

/**
 * Below the drawer breakpoint: language, appearance, session state and sign-out in
 * one panel behind a single trigger. Positioned by popover.ts (it flips above the
 * trigger when the viewport bottom is close) and portaled to <body> so no page
 * container can clip it.
 */
function OverflowMenu({ busy, onSignOut }: { busy: boolean; onSignOut: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // The popover measures its trigger and tests presses against it; a wrapper element
  // gives it something stable to measure, since IconButton owns its own <button>.
  const trigger = useRef<HTMLSpanElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const placement = usePopover(open, close, trigger, panel, "end");
  return (
    <>
      <span ref={trigger} className={s.trigger}>
        <IconButton
          icon="more"
          label={t("app.moreActions")}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls="shell-overflow"
          onClick={() => setOpen((current) => !current)}
        />
      </span>
      {open &&
        createPortal(
          <div
            ref={panel}
            id="shell-overflow"
            className={s.menu}
            aria-label={t("app.moreActions")}
            style={
              placement ? { top: placement.top, left: placement.left } : { visibility: "hidden" }
            }
          >
            <div className={s.menuRow}>
              <LanguageToggle onChoose={close} />
              <Appearance onOpen={close} />
            </div>
            <span className={s.menuStatus}>
              <span className={s.sessionDot} aria-hidden="true" />
              {t("app.sessionActive")}
            </span>
            <span className={s.menuDivider} aria-hidden="true" />
            <Button
              variant="ghost"
              icon="shield"
              block
              disabled={busy}
              onClick={() => {
                close();
                onSignOut();
              }}
            >
              {t("app.signOut")}
            </Button>
          </div>,
          popoverHost(trigger.current),
        )}
    </>
  );
}
