import { useEffect, useId, useRef, type ReactNode } from "react";
import { lockPage } from "../modal";
import { useExiting } from "../presence";
import { IconButton } from "./IconButton";
import { ToastRegion } from "./Toast";
import s from "./Overlay.module.scss";

export { DrawerPresence } from "../presence";

export type OverlayProps = {
  title: string;
  children: ReactNode;
  onClose: () => void;
  /** Accessible name of the close button; also names it in the drawer's toast region. */
  closeLabel: string;
  /** Actions under the scrollable body. */
  footer?: ReactNode;
  /** Refuse Escape and backdrop dismissal while a request is in flight. */
  dismissDisabled?: boolean;
  className?: string;
};

/**
 * A modal surface on the platform's own terms: a native `<dialog>` opened with
 * `showModal()`, so the browser supplies the top layer, the focus containment and the
 * `:modal` behaviour we would otherwise re-implement badly.
 *
 * Reused rather than rewritten: the enter/exit retention comes from presence.tsx (render
 * it inside `DrawerPresence`) and the background scroll lock from modal.ts (reference
 * counted, restored on unmount). Escape is handled here as well as in `onCancel`: the
 * native cancel event is what a browser fires, and jsdom never fires it.
 */
function Overlay({
  title,
  children,
  onClose,
  closeLabel,
  footer,
  dismissDisabled = false,
  variant,
  className = "",
}: OverlayProps & { variant: "drawer" | "dialog" }) {
  const exiting = useExiting();
  const ref = useRef<HTMLDialogElement>(null);
  const outside = useRef(false);
  const escaped = useRef(false);
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    const unlock = lockPage();
    return () => {
      dialog.close();
      unlock();
      // Focus returns to the control that opened the overlay, if it is still on the page.
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);

  const requestClose = () => {
    if (dismissDisabled || exiting) return;
    onClose();
  };

  const classes = [s.overlay, className].filter(Boolean).join(" ");
  return (
    <dialog
      ref={ref}
      className={classes}
      data-variant={variant}
      data-phase={exiting ? "exiting" : "open"}
      aria-labelledby={id}
      aria-modal="true"
      onPointerDown={(event) => {
        // Only a press that starts on the backdrop may dismiss: a drag that begins inside
        // the sheet and ends outside must not close it.
        outside.current = event.button === 0 && event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const dismiss = outside.current && event.target === event.currentTarget;
        outside.current = false;
        if (dismiss) requestClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        escaped.current = true;
        requestClose();
      }}
      onCancel={(event) => {
        // Keep the browser from tearing the dialog down itself: the exit animation and the
        // scroll-lock bookkeeping both live in the React tree.
        event.preventDefault();
        if (!escaped.current) requestClose();
        escaped.current = false;
      }}
    >
      <section className={s.surface} inert={exiting}>
        <header className={s.head}>
          <h2 id={id} className={s.title}>
            {title}
          </h2>
          <IconButton
            icon="close"
            label={closeLabel}
            disabled={dismissDisabled}
            onClick={requestClose}
          />
        </header>
        <div className={s.body}>{children}</div>
        {footer === undefined ? null : <footer className={s.footer}>{footer}</footer>}
        {/* A toast raised while the sheet is open has to sit above its backdrop, and a
            closing sheet hands the job back to the page's own region. */}
        {exiting ? null : <ToastRegion />}
      </section>
    </dialog>
  );
}

export function Drawer(props: OverlayProps) {
  return <Overlay {...props} variant="drawer" />;
}

export function Dialog(props: OverlayProps) {
  return <Overlay {...props} variant="dialog" />;
}
