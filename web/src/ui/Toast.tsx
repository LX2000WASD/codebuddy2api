import {
  useEffect,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./Icon";
import s from "./Toast.module.scss";

export type ToastTone = "good" | "warn" | "bad";

export type ToastInput = {
  tone: ToastTone;
  title: string;
  /** Short supporting line; keep it to one sentence. */
  body?: ReactNode;
  /** A notice with the same key replaces the previous one instead of stacking. */
  key?: string;
};

type ToastRecord = ToastInput & { id: number; born: number; leaving?: boolean };

/**
 * Notices live outside React so any callback can raise one, and a reload drops them.
 *
 * The queue is the one from toast.tsx, kept verbatim: same life times, same four-notice
 * cap, same "newest host wins" rule that lets a notice raised inside an open sheet paint
 * above its backdrop. Only the presentation is new.
 */
let state: { toasts: ToastRecord[]; hosts: string[] } = { toasts: [], hosts: [] };
const listeners = new Set<() => void>();
let serial = 0;
const update = (next: Partial<typeof state>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => state;
const remove = (id: number) => update({ toasts: state.toasts.filter((toast) => toast.id !== id) });

// Warnings stay long enough to read; hovering or focusing a notice holds it.
const LIFE: Record<ToastTone, number> = { good: 5000, warn: 10000, bad: 10000 };
const LIMIT = 4;
const GLYPH: Record<ToastTone, IconName> = { good: "check", warn: "alert", bad: "alert" };

/** Raise a passing notice at the top of the page; it fades on its own, or sooner when clicked. */
export function notify(toast: ToastInput) {
  const kept = toast.key ? state.toasts.filter((old) => old.key !== toast.key) : state.toasts;
  update({ toasts: [...kept, { ...toast, id: ++serial, born: Date.now() }].slice(-LIMIT) });
}

export function dismiss(id: number) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches !== false) {
    remove(id);
    return;
  }
  update({
    toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)),
  });
  window.setTimeout(() => remove(id), 180);
}

/** Drop every notice at once, as a page reload does. */
export function clearToasts() {
  update({ toasts: [] });
}

function ToastItem({ toast }: { toast: ToastRecord }) {
  const [held, setHeld] = useState(false);
  // The clock runs from when the notice was raised, so opening a drawer does not restart
  // it; letting go of a held notice gives it a full life again.
  const [since, setSince] = useState(toast.born);
  useEffect(() => {
    if (held || toast.leaving) return;
    const left = since + LIFE[toast.tone] - Date.now();
    const timer = window.setTimeout(() => dismiss(toast.id), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [held, since, toast]);
  const release = () => {
    setHeld(false);
    setSince(Date.now());
  };
  return (
    // A notice is not a control: it is announced politely, expires, and the pointer may
    // dismiss it early. Nothing inside it takes focus, so an expiring notice can never
    // steal focus from the page.
    <div
      className={s.toast}
      data-tone={toast.tone}
      data-leaving={toast.leaving ? "true" : undefined}
      onClick={() => dismiss(toast.id)}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={release}
    >
      <span className={s.icon} aria-hidden="true">
        <Icon name={GLYPH[toast.tone]} size="sm" />
      </span>
      <div className={s.text}>
        <strong className={s.title}>{toast.title}</strong>
        {toast.body === undefined ? null : <div className={s.body}>{toast.body}</div>}
      </div>
    </div>
  );
}

/**
 * Where notices render. A page header and each open drawer mount one; only the newest host
 * paints them, so a notice raised from a sheet stays above the sheet.
 */
export function ToastRegion() {
  const id = useId();
  const { toasts, hosts } = useSyncExternalStore(subscribe, snapshot);
  useLayoutEffect(() => {
    update({ hosts: [...state.hosts, id] });
    return () => update({ hosts: state.hosts.filter((host) => host !== id) });
  }, [id]);
  if (hosts.at(-1) !== id) return null;
  return (
    <div className={s.toasts} aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
