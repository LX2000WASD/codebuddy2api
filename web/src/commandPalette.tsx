import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { api, errorMessage, useSession } from "./api";
import { chooseAppearance, useAppearance } from "./appearance";
import { Icon } from "./components";
import { chooseLanguage, languagePreference, useT } from "./i18n";
import { navAreas, sectionTarget } from "./navigation";
import s from "./ui.module.scss";

/**
 * Signing out is reachable from two places (the header button and the command
 * palette); both call this so the session state can never diverge between them.
 */
export function signOut() {
  return api.delete("/session").then(() => {
    useSession.setState({ status: "anonymous", csrf: null, error: null });
  });
}

/** Shell listens for this so the palette can fold the sidebar without owning its state. */
export const SIDEBAR_TOGGLE_EVENT = "codebuddy:sidebar-toggle";

type Command = {
  id: string;
  group: "go" | "action";
  label: string;
  hint?: string;
  icon: string;
  /** Extra search terms: the Chinese label, the English label, and the old page name. */
  keywords?: string;
  run: () => void;
};

const optionId = (id: string) => `command-option-${id}`;

/**
 * A "jump + act" palette (Cmd+K). Jumping alone would be a slower sidebar, so the
 * action group carries the things that otherwise need a navigation first: language,
 * theme, sidebar, sign-out, copy-link.
 *
 * Rendered through a portal onto document.body: .pageEnter carries a transform for
 * the route transition, which would otherwise become the containing block of the
 * fixed-position backdrop and clip the overlay to the page area.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const appearance = useAppearance();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const go: Command[] = [];
    for (const area of navAreas) {
      const areaLabel = t(area.labelKey);
      for (const section of area.sections) {
        const label = t(section.labelKey);
        go.push({
          id: `go-${area.key}-${section.key}`,
          group: "go",
          // A single-section area and its only section share a name; do not print it twice.
          label: area.sections.length > 1 ? label : areaLabel,
          hint: area.sections.length > 1 ? areaLabel : undefined,
          icon: area.icon,
          keywords: `${area.key} ${section.key} ${areaLabel} ${label}`,
          run: () => navigate(sectionTarget(area, section.key)),
        });
      }
    }
    const lang = languagePreference();
    const actions: Command[] = [
      {
        id: "lang-zh",
        group: "action",
        label: t("command.langZh"),
        hint: lang === "zh" ? t("command.current") : undefined,
        icon: "system",
        keywords: "language 语言 chinese 中文",
        run: () => chooseLanguage("zh"),
      },
      {
        id: "lang-en",
        group: "action",
        label: t("command.langEn"),
        hint: lang === "en" ? t("command.current") : undefined,
        icon: "system",
        keywords: "language 语言 english",
        run: () => chooseLanguage("en"),
      },
      {
        id: "mode-system",
        group: "action",
        label: t("command.modeSystem"),
        hint: appearance.mode === "system" ? t("command.current") : undefined,
        icon: "appearance",
        keywords: "theme 主题 外观 system 跟随",
        run: () => chooseAppearance({ mode: "system" }),
      },
      {
        id: "mode-light",
        group: "action",
        label: t("command.modeLight"),
        hint: appearance.mode === "light" ? t("command.current") : undefined,
        icon: "sun",
        keywords: "theme 主题 外观 light 浅色",
        run: () => chooseAppearance({ mode: "light" }),
      },
      {
        id: "mode-dark",
        group: "action",
        label: t("command.modeDark"),
        hint: appearance.mode === "dark" ? t("command.current") : undefined,
        icon: "moon",
        keywords: "theme 主题 外观 dark 深色",
        run: () => chooseAppearance({ mode: "dark" }),
      },
      {
        id: "sidebar",
        group: "action",
        label: t("command.sidebar"),
        icon: "collapse",
        keywords: "sidebar 侧栏 收起 展开",
        run: () => window.dispatchEvent(new CustomEvent(SIDEBAR_TOGGLE_EVENT)),
      },
      {
        id: "copy-link",
        group: "action",
        label: t("command.copyLink"),
        icon: "cache",
        keywords: "copy 复制 链接 url share 分享",
        run: () => {
          // Clipboard access is denied in insecure contexts and in jsdom; report the
          // failure instead of pretending the copy worked.
          void navigator.clipboard
            ?.writeText(window.location.href)
            .then(() => setStatus(t("command.copied")))
            .catch(() => setStatus(t("command.copyFailed")));
        },
      },
      {
        id: "sign-out",
        group: "action",
        label: t("command.signOut"),
        icon: "shield",
        keywords: "logout 退出 登出",
        run: () => {
          void signOut().catch((error: unknown) => setStatus(errorMessage(error)));
        },
      },
    ];
    return [...go, ...actions];
  }, [t, navigate, appearance.mode]);

  const matched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, query]);

  // A shorter result list must not keep a highlight past its end.
  const cursor = Math.min(active, Math.max(0, matched.length - 1));

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setStatus(null);
    setActive(0);
    // Focus after paint: the input does not exist until the portal is mounted.
    const frame = window.requestAnimationFrame(() => input.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open) return null;

  const runAt = (index: number) => {
    const command = matched[index];
    if (!command) return;
    command.run();
    // "Copy" reports its own result, so it keeps the panel open to show it.
    if (command.id !== "copy-link") onClose();
  };

  const groups: {
    key: Command["group"];
    label: string;
    items: { command: Command; index: number }[];
  }[] = [
    { key: "go", label: t("command.groupGo"), items: [] },
    { key: "action", label: t("command.groupAction"), items: [] },
  ];
  matched.forEach((command, index) => {
    groups.find((group) => group.key === command.group)!.items.push({ command, index });
  });

  return createPortal(
    <div
      className={s.commandBackdrop}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={s.commandPanel}
        role="dialog"
        aria-modal="true"
        aria-label={t("command.title")}
      >
        <input
          ref={input}
          className={s.commandInput}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-list"
          aria-activedescendant={matched.length ? optionId(matched[cursor].id) : undefined}
          aria-autocomplete="list"
          placeholder={t("command.placeholder")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              if (!matched.length) return;
              setActive((cursor + step + matched.length) % matched.length);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              runAt(cursor);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        {status && (
          <p className={s.commandEmpty} role="status">
            {status}
          </p>
        )}
        {matched.length === 0 ? (
          <p className={s.commandEmpty}>{t("command.empty")}</p>
        ) : (
          <ul
            className={s.commandList}
            id="command-list"
            role="listbox"
            aria-label={t("command.title")}
          >
            {groups
              .filter((group) => group.items.length > 0)
              .map((group) => (
                <li key={group.key} role="group" aria-label={group.label}>
                  <div className={s.commandGroup} aria-hidden="true">
                    {group.label}
                  </div>
                  {group.items.map(({ command, index }) => (
                    <div
                      key={command.id}
                      id={optionId(command.id)}
                      role="option"
                      aria-selected={index === cursor}
                      className={s.commandItem}
                      // Activation is a click so assistive tech and synthetic events
                      // work; pointerdown only stops the input from losing focus.
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => runAt(index)}
                      onPointerMove={() => setActive(index)}
                    >
                      <Icon name={command.icon} />
                      <span>{command.label}</span>
                      {command.hint && <span className={s.commandItemHint}>{command.hint}</span>}
                    </div>
                  ))}
                </li>
              ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
