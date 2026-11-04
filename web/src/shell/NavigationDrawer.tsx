import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { lockPage } from "../modal";
import { useT } from "../i18n";
import s from "./shell.module.scss";

/**
 * The navigation sheet below the drawer breakpoint.
 *
 * A modal <dialog> rather than a hand-rolled fixed panel: the top layer owns the
 * stacking order, the browser traps focus inside the sheet, ESC arrives as a cancel
 * event, and the rest of the page becomes inert for assistive tech. The page scroll
 * lock is the shared reference-counted one from modal.ts, so it composes with any
 * dialog a page opens on top.
 *
 * The sheet is rendered only while open, so a wide viewport never keeps a second,
 * hidden copy of the navigation in the DOM (duplicate landmark / duplicate links).
 */
export function NavigationDrawer({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const outside = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element || !open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showModal();
    const unlock = lockPage();
    // Focus moves into the sheet after paint: it exists only in this branch. The
    // sheet itself takes focus rather than its first link, so neither "brand"
    // (a jump home) nor a close button is pre-armed for a stray Enter; Tab then
    // walks the destinations from the top.
    const frame = window.requestAnimationFrame(() => panel.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      element.close();
      unlock();
      const previous = opener.current;
      opener.current = null;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <dialog
      ref={dialog}
      className={s.drawerOverlay}
      aria-label={t("app.primaryNav")}
      onKeyDown={(event) => {
        // The browser also reports ESC as the dialog's cancel event; handling the key
        // as well keeps the sheet closable where that event never arrives (jsdom, and
        // any embed that swallows cancel). Closing twice is a no-op: the state closes.
        if (event.key === "Escape") onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        outside.current = event.button === 0 && event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Dragging from inside the sheet must not dismiss it (same rule as Drawer).
        const dismiss = outside.current && event.target === event.currentTarget;
        outside.current = false;
        if (dismiss) onClose();
      }}
    >
      <div ref={panel} className={s.drawerPanel} tabIndex={-1}>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}
