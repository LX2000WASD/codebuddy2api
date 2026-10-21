import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * P0 regression guard: 4 palettes × 2 modes have to stay 8 *real* themes.
 *
 * The pre-fix theme.scss scoped every palette rule to [data-theme="light"] and hard-coded
 * --accent: #79bd9f inside @mixin dark, so all four dark palettes rendered the same green
 * and the palette control did nothing in dark mode. Nothing caught it because no test ever
 * looked at a resolved custom property.
 *
 * theme.test.tsx already asserts the invariants against the compiled stylesheet in jsdom.
 * This spec re-asserts them on the running app, where the browser has to actually resolve
 * oklch() and color-mix() — the step jsdom skips, and the one that decides what a user sees.
 *
 * §2.9.5 states invariants 3 and 4 as "identical across all eight themes", which cannot
 * hold: --page is a light grey in light mode and near-black in dark mode by design. What
 * they protect is orthogonality — neutrals and semantics must not move with the *palette*,
 * because then every contrast ratio measured for an accent would need re-measuring per
 * palette. So they are asserted per mode, the same reading theme.test.tsx uses.
 */

const PALETTES = ["green", "blue", "rose", "amber"] as const;
const MODES = ["light", "dark"] as const;
type Palette = (typeof PALETTES)[number];
type Mode = (typeof MODES)[number];

/** §2.9.2: the palette layer owns the hue seed and nothing else, so these four numbers are the contract. */
const HUE: Record<Palette, number> = { green: 145, blue: 255, rose: 350, amber: 70 };

/** The accent @mixin dark used to hard-code. Every dark palette rendered exactly this. */
const LEGACY_DARK_ACCENT = "rgb(121, 189, 159)";

const CREDENTIALS = [
  {
    id: "one",
    name: "one.info",
    enabled: true,
    profile: "cn-cli",
    health: "ready",
    credits: { credits: 40 },
  },
];

/** Just enough fixture for the shell to render; the theme layer is global, not per page. */
const DASHBOARD = {
  summary: { requests: 17, success_rate: 15 / 17, total_tokens: 500, credit: 1 },
  series: [1, 5, 3, 8].map((requests, i) => ({
    date: `2026-09-14 0${i}:00`,
    bucket: 1789344000 + i * 3600,
    requests,
    success: requests - (i % 2),
    error: i % 2,
  })),
  models: [],
  profiles: [],
  health: { credentials: CREDENTIALS },
  storage: { degraded: false },
  range: { granularity: "hour" },
};

type Tokens = {
  theme: string;
  palette: string;
  /** The seed. A palette that forgets a mode inherits the previous palette's seed. */
  hue: string;
  /** Composed accent as the browser reports it; oklch() survives in this field. */
  accent: string;
  /** The same accent flattened to sRGB, so two themes compare by the color a user sees. */
  accentSrgb: string;
  /** The page role (--n1 in light, --n12 in dark): the neutral that must ignore the palette. */
  page: string;
  pageSrgb: string;
  /** The literal neutral step, identical in every theme by construction. */
  neutral: string;
  success: string;
  successSrgb: string;
};

async function route(page: Page) {
  await page.route("**/admin/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/session")
      return route.fulfill({ json: { authenticated: true, csrf_token: "theme-matrix" } });
    if (path === "/admin/credentials") return route.fulfill({ json: { credentials: CREDENTIALS } });
    if (path === "/admin/dashboard") return route.fulfill({ json: DASHBOARD });
    return route.fulfill({
      status: 404,
      json: { error: { message: "Unmocked fixture endpoint" } },
    });
  });
}

async function readTokens(page: Page): Promise<Tokens> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    // fillStyle silently keeps its previous value on an unparsable color, so seed a
    // sentinel and report anything that comes back unchanged instead of guessing.
    const sentinel = "#010203";
    const toSrgb = (value: string) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = sentinel;
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return r === 1 && g === 2 && b === 3
        ? "unparsed(" + value + ")"
        : "rgb(" + r + ", " + g + ", " + b + ")";
    };
    const probe = (name: string) => {
      const element = document.createElement("span");
      element.style.color = "var(" + name + ")";
      document.body.append(element);
      const raw = getComputedStyle(element).color;
      element.remove();
      return { raw, srgb: toSrgb(raw) };
    };
    const accent = probe("--accent");
    const page = probe("--page");
    const success = probe("--success-fg");
    return {
      theme: document.documentElement.dataset.theme ?? "",
      palette: document.documentElement.dataset.palette ?? "",
      hue: getComputedStyle(document.documentElement).getPropertyValue("--palette-hue").trim(),
      accent: accent.raw,
      accentSrgb: accent.srgb,
      page: page.raw,
      pageSrgb: page.srgb,
      neutral: probe("--n1").raw,
      success: success.raw,
      successSrgb: success.srgb,
    };
  });
}

/** Loads one combination and reads back what the browser resolved. */
async function theme(browser: Browser, baseURL: string, mode: Mode, palette: Palette) {
  const context = await browser.newContext({
    baseURL,
    locale: "zh-CN",
    viewport: { width: 1440, height: 1050 },
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Opposite OS preference on purpose: an explicit choice must win over
    // prefers-color-scheme, which is the one branch initializeAppearance() takes.
    await page.emulateMedia({ colorScheme: mode === "dark" ? "light" : "dark" });
    await page.addInitScript(
      ([chosenMode, chosenPalette]) => {
        localStorage.setItem(
          "codebuddy.appearance",
          JSON.stringify({ mode: chosenMode, palette: chosenPalette }),
        );
      },
      [mode, palette],
    );
    await route(page);
    await page.goto("/dashboard");
    await page.waitForSelector("html[data-theme][data-palette]");
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
    return { tokens: await readTokens(page), errors };
  } finally {
    await context.close();
  }
}

let rows: { mode: Mode; palette: Palette; tokens: Tokens }[] = [];
let pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  const baseURL = test.info().project.use.baseURL!;
  for (const mode of MODES)
    for (const palette of PALETTES) {
      const { tokens, errors } = await theme(browser, baseURL, mode, palette);
      rows.push({ mode, palette, tokens });
      pageErrors = pageErrors.concat(errors.map((error) => `${mode}/${palette}: ${error}`));
    }
});

function tokens(mode: Mode, palette: Palette) {
  const row = rows.find((candidate) => candidate.mode === mode && candidate.palette === palette);
  if (!row) throw new Error("theme matrix is missing " + mode + "/" + palette);
  return row.tokens;
}

function inMode(mode: Mode, pick: (value: Tokens) => string) {
  return PALETTES.map((palette) => [palette, pick(tokens(mode, palette))] as const);
}

function distinct(entries: readonly (readonly [string, string])[], label: string) {
  for (const [palette, value] of entries)
    expect(value, `${label} is unset on ${palette}`).not.toBe("");
  return new Set(entries.map(([, value]) => value)).size;
}

test("renders all eight combinations without a page error", () => {
  expect(rows).toHaveLength(MODES.length * PALETTES.length);
  expect(pageErrors).toEqual([]);
});

test("marks the document with the requested mode and palette", () => {
  for (const mode of MODES)
    for (const palette of PALETTES) {
      const value = tokens(mode, palette);
      expect(value.theme, `${mode}/${palette} data-theme`).toBe(mode);
      expect(value.palette, `${mode}/${palette} data-palette`).toBe(palette);
    }
});

test("gives every palette its own hue seed in both modes", () => {
  // Reading the seed rather than the composed color keeps this independent of how the
  // accent is built. The old stylesheet is exactly what fails here in dark mode: the
  // palette rules never matched, so every dark palette kept the default seed.
  for (const mode of MODES)
    for (const palette of PALETTES)
      expect(tokens(mode, palette).hue, `${mode}/${palette} --palette-hue`).toBe(
        String(HUE[palette]),
      );
});

test("resolves a distinct accent for all four palettes within each mode", () => {
  for (const mode of MODES) {
    const accents = inMode(mode, (value) => value.accentSrgb);
    for (const [, srgb] of accents)
      expect(srgb, `${mode} --accent did not resolve`).not.toMatch(/^unparsed/);
    expect(distinct(accents, `${mode} --accent`), `${mode}: ${JSON.stringify(accents)}`).toBe(
      PALETTES.length,
    );
    // The composed value has to differ too: two palettes that flatten to the same sRGB
    // while claiming different oklch() would be a gamut bug, not a passing theme.
    expect(
      distinct(
        inMode(mode, (value) => value.accent),
        `${mode} --accent source`,
      ),
    ).toBe(PALETTES.length);
  }
});

test("never renders the pre-fix hard-coded dark accent", () => {
  // The exact symptom of the P0: #79bd9f in every dark palette.
  for (const palette of PALETTES)
    expect(tokens("dark", palette).accentSrgb, `dark/${palette} --accent`).not.toBe(
      LEGACY_DARK_ACCENT,
    );
});

test("keeps the neutral page color independent of the palette", () => {
  for (const mode of MODES) {
    const pages = inMode(mode, (value) => value.pageSrgb);
    for (const [, srgb] of pages)
      expect(srgb, `${mode} --page did not resolve`).not.toMatch(/^unparsed/);
    expect(distinct(pages, `${mode} --page`), `${mode}: ${JSON.stringify(pages)}`).toBe(1);
    // --n1 is a fixed neutral step, so it must not move with the palette either.
    expect(
      distinct(
        inMode(mode, (value) => value.neutral),
        `${mode} --n1`,
      ),
    ).toBe(1);
  }
});

test("keeps the semantic success color independent of the palette", () => {
  for (const mode of MODES) {
    const colors = inMode(mode, (value) => value.successSrgb);
    for (const [, srgb] of colors)
      expect(srgb, `${mode} --success-fg did not resolve`).not.toMatch(/^unparsed/);
    expect(distinct(colors, `${mode} --success-fg`), `${mode}: ${JSON.stringify(colors)}`).toBe(1);
  }
});

test("keeps the mode axis real: light and dark are not the same theme", () => {
  // Without this, collapsing the whole matrix onto one mode would still satisfy every
  // per-mode invariant above.
  for (const palette of PALETTES) {
    const light = tokens("light", palette);
    const dark = tokens("dark", palette);
    expect(dark.accentSrgb, `${palette} accent is mode-independent`).not.toBe(light.accentSrgb);
    expect(dark.pageSrgb, `${palette} page is mode-independent`).not.toBe(light.pageSrgb);
    expect(dark.successSrgb, `${palette} success is mode-independent`).not.toBe(light.successSrgb);
  }
});
