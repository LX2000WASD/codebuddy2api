import { useState, type ReactNode } from "react";
import { api, errorMessage, list, number, object, text } from "./api";
import { useT } from "./i18n";
import { Badge, Button, Drawer, ErrorNotice, Icon, Input } from "./ui";
import s from "./MirrorDrawer.module.scss";

type Probe = {
  mirror: string;
  ok: boolean;
  latency: number | null;
  speed: number | null;
  error: string | null;
};

function host(mirror: string): string {
  try {
    const url = new URL(mirror);
    return url.host + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return mirror;
  }
}

function rate(speed: number): string {
  return speed >= 1024 ? `${(speed / 1024).toFixed(1)} MB/s` : `${Math.round(speed)} KB/s`;
}

// The server stores prefixes with a trailing slash; match that so a typed prefix finds its result.
function prefix(value: string): string {
  const trimmed = value.trim();
  return trimmed && !trimmed.endsWith("/") ? `${trimmed}/` : trimmed;
}

/** The fourth overview card: the source in use, opening the drawer to switch and test. */
export function MirrorCard({ mirror, onOpen }: { mirror: string; onOpen: () => void }) {
  const t = useT();
  const label = mirror ? host(mirror) : t("updates.mirrorDirect");
  return (
    <button type="button" className={s.mirrorCard} onClick={onOpen}>
      <span className={s.mirrorHead}>
        <span className={s.mirrorLabel}>{t("updates.mirror")}</span>
        <span className={s.mirrorIcon} aria-hidden="true">
          <Icon name="down" size="sm" />
        </span>
      </span>
      <strong className={s.mirrorValue} title={label}>
        {label}
      </strong>
      <small className={s.mirrorHint}>{t("updates.mirrorCardHint")}</small>
    </button>
  );
}

export function MirrorDrawer({
  mirror,
  mirrors,
  custom,
  locked,
  githubToken,
  onSaved,
  onClose,
}: {
  mirror: string;
  mirrors: string[];
  custom: string;
  locked: boolean;
  githubToken: boolean;
  onSaved: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(custom);
  const [results, setResults] = useState<Record<string, Probe>>({});
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenSaving, setTokenSaving] = useState(false);
  // Sources under test; "*" while every source is being tested at once.
  const [testing, setTesting] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const test = (key: string, target?: string) => {
    setTesting((current) => [...current, key]);
    setError(null);
    void api
      .post<unknown>(
        "/update/mirrors/test",
        target === undefined ? undefined : { mirror: target },
        { timeout: 60000 },
      )
      .then((response) => {
        const probes = list(object(response.data).results, t("updates.mirror")).map(
          (item): Probe => ({
            mirror: typeof item.mirror === "string" ? item.mirror : "",
            ok: item.ok === true,
            latency: number(item.latency_ms),
            speed: number(item.speed),
            error: item.error ? text(item.error) : null,
          }),
        );
        // A single test keeps only its own row, even if an older server answers for every source.
        const kept = target === undefined ? probes : probes.filter((probe) => probe.mirror === key);
        setResults((current) => ({
          ...current,
          ...Object.fromEntries(kept.map((probe) => [probe.mirror, probe])),
        }));
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setTesting((current) => current.filter((item) => item !== key)));
  };
  const use = (target: string, remember: boolean) => {
    setSaving(true);
    setError(null);
    void api
      .post("/update/mirror", remember ? { mirror: target, custom: target } : { mirror: target })
      .then(onSaved)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setSaving(false));
  };
  // The token authenticates release listings only, so it is saved on its own: it is not a
  // download source and must not reload the mirror selection when it changes.
  const saveToken = () => {
    setTokenSaving(true);
    setError(null);
    void api
      .post("/update/mirror", { github_token: tokenDraft.trim() })
      .then(() => {
        setTokenDraft("");
        onSaved();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setTokenSaving(false));
  };
  const everything = testing.includes("*");
  const fastest = Object.values(results)
    .filter((probe) => probe.ok && probe.speed !== null)
    .sort((a, b) => (b.speed ?? 0) - (a.speed ?? 0))[0]?.mirror;
  const row = (key: string, label: string, name: ReactNode, remember = false) => {
    const probe = results[key];
    const empty = remember && !key;
    const inUse = !empty && key === mirror;
    const running = everything || testing.includes(key);
    return (
      <li
        key={remember ? "custom" : key || "direct"}
        className={s.row}
        data-current={inUse ? "true" : undefined}
      >
        <span className={s.rowName}>
          {name}
          {!empty && key === fastest && <Badge tone="good">{t("updates.mirrorFastest")}</Badge>}
          {inUse && <Badge>{t("updates.mirrorInUse")}</Badge>}
        </span>
        <span className={s.rowStats}>
          {!probe ? (
            <small className={s.subtle}>{t("updates.mirrorUntested")}</small>
          ) : probe.ok && probe.speed !== null ? (
            `${probe.latency ?? "—"} ms · ${rate(probe.speed)}`
          ) : (
            <Badge tone="bad">{probe.error ?? "—"}</Badge>
          )}
        </span>
        <span className={s.rowActions}>
          <Button
            size="sm"
            aria-label={`${t("updates.mirrorTestOne")} ${label}`}
            disabled={running || empty}
            icon={<Icon name="refresh" size="sm" spin={running} />}
            onClick={() => test(key, remember ? draft.trim() : key)}
          >
            {t("updates.mirrorTestOne")}
          </Button>
          <Button
            size="sm"
            aria-label={`${t("updates.mirrorUse")} ${label}`}
            disabled={locked || saving || inUse || empty || probe?.ok === false}
            onClick={() => use(remember ? draft.trim() : key, remember)}
          >
            {inUse ? t("updates.mirrorInUse") : t("updates.mirrorUse")}
          </Button>
        </span>
      </li>
    );
  };
  return (
    <Drawer title={t("updates.mirror")} closeLabel={t("common.closeDrawer")} onClose={onClose}>
      <p className={s.lead}>{t("updates.mirrorDesc")}</p>
      {locked && <small className={s.subtle}>{t("updates.mirrorLocked")}</small>}
      <div>
        <Button
          icon={<Icon name="refresh" size="sm" spin={everything} />}
          disabled={everything}
          onClick={() => test("*")}
        >
          {everything ? t("updates.mirrorTesting") : t("updates.mirrorTestAll")}
        </Button>
      </div>
      <ErrorNotice message={error} />
      <ul className={s.list} aria-label={t("updates.mirrorResults")}>
        {row("", t("updates.mirrorDirect"), t("updates.mirrorDirect"))}
        {mirrors.map((candidate) => row(candidate, host(candidate), host(candidate)))}
        {row(
          prefix(draft),
          t("updates.mirrorCustomSlot"),
          <Input
            className={s.slot}
            aria-label={t("updates.mirrorCustomSlot")}
            placeholder={t("updates.mirrorCustomPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />,
          true,
        )}
      </ul>
      <div className={s.tokenRow}>
        <Input
          type="password"
          autoComplete="off"
          aria-label={t("updates.mirrorToken")}
          placeholder={
            githubToken ? t("updates.mirrorTokenSet") : t("updates.mirrorTokenPlaceholder")
          }
          value={tokenDraft}
          onChange={(e) => setTokenDraft(e.target.value)}
        />
        <Button
          disabled={tokenSaving || !tokenDraft.trim()}
          onClick={saveToken}
          // A placeholder is not a value: the button says whether a token is stored.
          aria-label={t("updates.mirrorTokenSave")}
        >
          {t("updates.mirrorTokenSave")}
        </Button>
      </div>
      <small className={s.subtle}>{t("updates.mirrorTokenHint")}</small>
    </Drawer>
  );
}
