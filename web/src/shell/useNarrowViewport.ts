import { useEffect, useState } from "react";

/**
 * The drawer breakpoint. It has to be the same query the stylesheet uses, otherwise
 * JS and CSS disagree about where the navigation turns into a drawer; design/ and
 * shell.module.scss both describe the same three ranges (>=1200 / 900-1199 / <900).
 */
export const NARROW_QUERY = "(max-width: 899px)";

function narrowQuery(): MediaQueryList | null {
  if (typeof window.matchMedia !== "function") return null;
  return window.matchMedia(NARROW_QUERY);
}

/**
 * Whether the shell is below the drawer breakpoint.
 *
 * matchMedia rather than a resize handler: the query is the contract, and a listener
 * on it fires exactly when the layout cross-fades instead of on every pixel of a drag.
 * Nothing in jsdom matches, which is the wide layout — the drawer cases stub matchMedia.
 */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(() => narrowQuery()?.matches === true);
  useEffect(() => {
    const media = narrowQuery();
    if (!media) return;
    const sync = () => setNarrow(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  return narrow;
}
