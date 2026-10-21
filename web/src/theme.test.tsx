import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compileString } from "sass";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

/**
 * The 8 themes are 4 palettes × 2 modes, and they only stay 8 because the two axes are
 * orthogonal: a palette may only move the accent hue, a mode may only move lightness,
 * chroma and the neutral/semantic scales. Before the split the palette rules were
 * written as [data-theme="light"][data-palette="x"] while @mixin dark hard-coded
 * --accent, so all four dark palettes rendered the same green. Nothing caught it
 * because no test ever looked at the resolved custom properties.
 *
 * The stylesheet is compiled here and injected as a <style> element instead of being
 * imported: the test config does not enable css processing, so an import of
 * theme.scss resolves to an empty module and jsdom would compute nothing. jsdom does
 * run the cascade for custom properties, but it does not evaluate oklch() or
 * color-mix(), so --accent reads back as the literal token stream
 * "oklch(var(--accent-l) var(--accent-c) var(--palette-hue))". substitute() expands
 * those var() references by hand, which is enough to tell whether two themes resolve
 * to the same accent: identical text means identical color.
 */

const THEME_SCSS = [
  resolve(dirname(fileURLToPath(import.meta.url)), "theme.scss"),
  resolve(process.cwd(), "src/theme.scss"),
  resolve(process.cwd(), "web/src/theme.scss"),
].find((path) => existsSync(path));
if (!THEME_SCSS) throw new Error("theme.scss not found next to theme.test.tsx or under the cwd");

const PALETTES = ["green", "blue", "rose", "amber"] as const;
const MODES = ["light", "dark"] as const;
/** §2.9.2: the palette layer owns only the hue seed, so these four values are the contract. */
const HUE: Record<(typeof PALETTES)[number], number> = {
  green: 145,
  blue: 255,
  rose: 350,
  amber: 70,
};

type Mode = (typeof MODES)[number];
type Palette = (typeof PALETTES)[number];

const style = document.createElement("style");
style.dataset.themeUnderTest = "true";
style.textContent = compileString(readFileSync(THEME_SCSS, "utf8")).css;

const root = document.documentElement;
let savedTheme: string | undefined;
let savedPalette: string | undefined;

beforeAll(() => {
  savedTheme = root.dataset.theme;
  savedPalette = root.dataset.palette;
  document.head.append(style);
});
afterAll(() => {
  style.remove();
  if (savedTheme === undefined) delete root.dataset.theme;
  else root.dataset.theme = savedTheme;
  if (savedPalette === undefined) delete root.dataset.palette;
  else root.dataset.palette = savedPalette;
});
afterEach(() => {
  delete root.dataset.theme;
  delete root.dataset.palette;
});

function readToken(name: string) {
  return getComputedStyle(root).getPropertyValue(name).trim();
}

/** Expands var(--x) recursively so an unevaluated color function still compares by value. */
function substitute(value: string, seen: string[] = []): string {
  return value.replace(/var\(\s*(--[\w-]+)\s*(?:,[^()]*)?\)/g, (_, name: string) => {
    if (seen.includes(name)) return "var(" + name + ")";
    const resolved = readToken(name);
    return resolved ? substitute(resolved, [...seen, name]) : "var(" + name + ")";
  });
}

function theme(mode: Mode, palette: Palette) {
  root.dataset.theme = mode;
  root.dataset.palette = palette;
  return {
    hue: readToken("--palette-hue"),
    accent: substitute(readToken("--accent")),
    page: readToken("--n1"),
    success: readToken("--success-fg"),
  };
}

function distinct(values: string[], label: string) {
  for (const value of values) expect(value, label + " is unset").not.toBe("");
  return new Set(values).size;
}

describe("theme matrix invariants", () => {
  it("gives every palette its own hue seed in both modes", () => {
    // Reading the seed rather than the composed color is what keeps this independent of
    // how the accent is built. A palette that forgets a mode inherits the previous
    // palette's seed and fails here.
    for (const mode of MODES)
      for (const palette of PALETTES)
        expect(theme(mode, palette).hue, mode + "/" + palette + " --palette-hue").toBe(
          String(HUE[palette]),
        );
  });

  it("resolves a distinct accent for all four palettes within each mode", () => {
    for (const mode of MODES) {
      const accents = PALETTES.map((palette) => theme(mode, palette).accent);
      expect(distinct(accents, mode + " --accent"), mode + ": " + accents.join(" | ")).toBe(
        PALETTES.length,
      );
    }
  });

  // §2.9.5 states invariants 3 and 4 as "identical across all eight themes". Taken
  // literally that contradicts §2.7.2, where --page is #f3f4f7 in light and #0b0c0d in
  // dark, and §2.7.4, where --success-fg is #054744 / #a1e7e2. What the invariants
  // actually protect is orthogonality: neutrals and semantics must not move with the
  // *palette*, because then every contrast ratio measured for an accent would have to
  // be re-measured per palette. So the assertion is per-mode stability, which is the
  // property that can hold — and it is the one that fails when a palette selector
  // accidentally carries neutral or semantic values.
  it("keeps the neutral page color independent of the palette", () => {
    for (const mode of MODES) {
      const pages = PALETTES.map((palette) => [palette, theme(mode, palette).page] as const);
      expect(
        distinct(
          pages.map(([, page]) => page),
          mode + " --n1",
        ),
        JSON.stringify(pages),
      ).toBe(1);
    }
  });

  it("keeps the semantic success color independent of the palette", () => {
    for (const mode of MODES) {
      const colors = PALETTES.map((palette) => [palette, theme(mode, palette).success] as const);
      expect(
        distinct(
          colors.map(([, color]) => color),
          mode + " --success-fg",
        ),
        JSON.stringify(colors),
      ).toBe(1);
    }
  });
});
