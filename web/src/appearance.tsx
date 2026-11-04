import { useEffect, useState, type CSSProperties } from "react";
import { create } from "zustand";
import { api, object } from "./api";
import { chooseLanguage, languagePreference, useT, type LangPref } from "./i18n";
import { Drawer, DrawerPresence, Icon, IconButton } from "./ui";
import s from "./appearance.module.scss";
import "./theme.scss";

export type Mode = "system" | "light" | "dark";
export type Palette = "green" | "blue" | "rose" | "amber";
const key = "codebuddy.appearance";
const modes: Mode[] = ["system", "light", "dark"];
const palettes: Palette[] = ["green", "blue", "rose", "amber"];
export function parseAppearance(raw: string | null): { mode: Mode; palette: Palette } {
  try {
    const value = JSON.parse(raw ?? "null") as { mode?: Mode; palette?: Palette } | null;
    return {
      mode: modes.includes(value?.mode as Mode) ? value!.mode! : "system",
      palette: palettes.includes(value?.palette as Palette) ? value!.palette! : "green",
    };
  } catch {
    return { mode: "system", palette: "green" };
  }
}
function savedAppearance() {
  try {
    return parseAppearance(localStorage.getItem(key));
  } catch {
    return parseAppearance(null);
  }
}
export const useAppearance = create(() => ({ ...savedAppearance(), dark: false, persisted: true }));
export function initializeAppearance() {
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const apply = () => {
    const { mode, palette } = useAppearance.getState();
    const dark = mode === "dark" || (mode === "system" && !!media?.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.documentElement.dataset.palette = palette;
    if (dark !== useAppearance.getState().dark) useAppearance.setState({ dark });
  };
  apply();
  media?.addEventListener("change", apply);
  const unsubscribe = useAppearance.subscribe(apply);
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null)
      useAppearance.setState({ ...savedAppearance(), persisted: true });
  };
  window.addEventListener("storage", storage);
  return () => {
    media?.removeEventListener("change", apply);
    unsubscribe();
    window.removeEventListener("storage", storage);
  };
}
export function chooseAppearance(value: Partial<{ mode: Mode; palette: Palette }>) {
  const next = {
    mode: useAppearance.getState().mode,
    palette: useAppearance.getState().palette,
    ...value,
  };
  let persisted = true;
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    persisted = false;
  }
  useAppearance.setState({ ...next, persisted });
}
const LANGUAGE_CYCLE: LangPref[] = ["system", "zh", "en"];
/** Save through the API as well, so the CLI and other browsers share the choice. */
function persistLanguage(value: LangPref) {
  void api
    .get<unknown>("/settings")
    .then((response) =>
      api.patch("/settings", {
        values: { language: value === "system" ? "auto" : value },
        revision: object(response.data).revision,
      }),
    )
    .catch(() => undefined);
} /** One click moves to the next interface language: system, Chinese, English. */
export function LanguageToggle({ onChoose }: { onChoose?: () => void } = {}) {
  const t = useT();
  const [pref, setPref] = useState(languagePreference);
  const name = { system: t("appearance.lang.system"), zh: "中文", en: "English" }[pref];
  const label = t("appearance.languageIs", { lang: name });
  return (
    <IconButton
      icon={
        pref === "system" ? (
          "globe"
        ) : (
          <span className={s.langGlyph}>{pref === "zh" ? "中" : "EN"}</span>
        )
      }
      label={label}
      onClick={() => {
        const next = LANGUAGE_CYCLE[(LANGUAGE_CYCLE.indexOf(pref) + 1) % LANGUAGE_CYCLE.length]!;
        chooseLanguage(next);
        setPref(next);
        persistLanguage(next);
        onChoose?.();
      }}
    />
  );
}

/**
 * The two independent appearance axes: mode (system / light / dark) and the light-mode palette.
 *
 * The swatches are the four palette seeds from theme.scss. CSS cannot resolve another
 * element's accent, so the seed hue is the one value that has to be repeated here; the
 * lightness and chroma still come from the theme tokens, so a change to either moves every
 * swatch with the real theme.
 */
const SWATCH_HUE: Record<Palette, number> = { green: 145, blue: 255, rose: 350, amber: 70 };

export function Appearance({ onOpen }: { onOpen?: () => void } = {}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { mode, palette, dark, persisted } = useAppearance();
  // main.tsx also calls initializeAppearance() at startup; this is the idempotent
  // re-run for a client that mounts the control on its own (tests, storybook).
  useEffect(initializeAppearance, []);
  return (
    <>
      <IconButton
        icon="appearance"
        label="外观设置"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      />
      <DrawerPresence>
        {open && (
          <Drawer
            title="外观设置"
            closeLabel={t("common.closeDrawer")}
            onClose={() => setOpen(false)}
          >
            <fieldset className={s.choices}>
              <legend>显示模式</legend>
              {(
                [
                  ["system", "跟随系统", "system"],
                  ["light", "浅色", "sun"],
                  ["dark", "深色", "moon"],
                ] as const
              ).map(([value, label, icon]) => (
                <label key={value} className={s.choice}>
                  <input
                    type="radio"
                    name="appearance-mode"
                    value={value}
                    checked={mode === value}
                    onChange={() => chooseAppearance({ mode: value })}
                  />
                  <Icon name={icon} size="sm" />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            <fieldset className={s.choices} disabled={dark}>
              <legend>浅色配色</legend>
              {(
                [
                  ["green", "青叶"],
                  ["blue", "雾蓝"],
                  ["rose", "蔷薇"],
                  ["amber", "暖砂"],
                ] as const
              ).map(([value, label]) => (
                <label key={value} className={s.choice}>
                  <input
                    type="radio"
                    name="appearance-palette"
                    value={value}
                    checked={palette === value}
                    onChange={() => chooseAppearance({ palette: value })}
                  />
                  <span
                    className={s.swatch}
                    style={{ "--swatch-hue": SWATCH_HUE[value] } as CSSProperties}
                    aria-hidden="true"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </fieldset>
            <p className={s.note}>
              {dark
                ? "深色使用固定配色；浅色偏好会保留，切回浅色后生效。"
                : "配色只应用于浅色界面，不改变状态颜色。"}
            </p>
            {!persisted && <p role="status">浏览器无法保存偏好，本次会话内仍然生效。</p>}
          </Drawer>
        )}
      </DrawerPresence>
    </>
  );
}
