import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api, errorMessage, list, object, text, useResource, type RecordValue } from "../api";
// The generic record renderer lives in values.tsx; components.tsx only re-exports it, and
// that module is on its way out with the old stylesheet.
import { Fields } from "../values";
import { t } from "../i18n";
import {
  Badge,
  Button,
  Cluster,
  Drawer,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Field,
  Icon,
  Input,
  Page,
  Panel,
  Select,
  Skeleton,
  Stack,
  Switch,
  Toolbar,
} from "../ui";
import {
  CONFIRM_PHRASE,
  GROUPS,
  MANAGED_ELSEWHERE,
  RESTART_COMMAND,
  RESTART_HINT,
  RISK_LABEL,
  RISK_TONE,
  humanValue,
  isRetired,
  metaFor,
  pendingRestart,
  publishPendingRestart,
  type GroupKey,
} from "../settingsSchema";
import { AccountPanel } from "./Account";
import s from "./system.module.scss";
type Setting = {
  key: string;
  value: unknown;
  stored: unknown;
  source: string;
  mode: string;
  type: string;
  label: string;
  choices?: unknown[];
  min?: number;
  max?: number;
  locked: boolean;
  /** Environment variable that sets this key. Absent for secrets and unset keys. */
  env?: string;
};
const sourceLabels: Record<string, string> = {
  cli: "命令行",
  environment: "环境变量",
  env: "环境变量",
  dotenv: ".env 文件",
  generated: "本地默认密钥",
  management: "管理界面",
  default: "默认值",
  internal: "内置",
};
const modeLabels: Record<string, string> = {
  hot: "即时生效",
  restart: "重启后生效",
  startup: "启动时设置",
  readonly: "只读",
};
/** Why a value cannot be edited here. */
const lockReasons: Record<string, string> = {
  cli: "由启动命令行参数锁定，请在启动配置中修改后重启。",
  environment: "由环境变量锁定，请修改启动配置后重启。",
  env: "由环境变量锁定，请修改启动配置后重启。",
  dotenv: "由 .env 文件锁定，请修改该文件后重启。",
  internal: "运行时快照，随进程状态变化，不可修改。",
};

/**
 * The sentence shown for a locked row. Naming the variable is the whole point: "set by
 * the environment" leaves the operator hunting through compose files, while
 * "set by CODEBUDDY2API_MAX_CONCURRENT" is directly actionable.
 */
function lockReason(item: Setting): string {
  const base = lockReasons[item.source] ?? "请在启动配置中修改。";
  return item.env ? `由环境变量 ${item.env} 锁定，请修改启动配置后重启。` : base;
}
function displayValue(value: unknown) {
  return typeof value === "boolean" ? (value ? "开启" : "关闭") : text(value);
}
function normalize(value: unknown): {
  revision: number;
  items: Setting[];
  audit: RecordValue;
  session: RecordValue;
} {
  const d = object(value);
  if (typeof d.revision !== "number") throw new Error("设置响应缺少 revision");
  const items = list(d.items).map((item) => {
    if (
      typeof item.key !== "string" ||
      typeof item.locked !== "boolean" ||
      typeof item.type !== "string" ||
      typeof item.source !== "string" ||
      typeof item.mode !== "string" ||
      !("value" in item) ||
      !("stored" in item)
    )
      throw new Error("设置 schema 字段不完整");
    return {
      key: item.key,
      value: item.value,
      stored: item.stored,
      source: item.source,
      mode: item.mode,
      type: item.type,
      label: typeof item.label === "string" ? item.label : item.key,
      locked: item.locked,
      choices: Array.isArray(item.choices) ? item.choices : undefined,
      min: typeof item.min === "number" ? item.min : undefined,
      max: typeof item.max === "number" ? item.max : undefined,
      env: typeof item.env === "string" && item.env ? item.env : undefined,
    };
  });
  return {
    revision: d.revision,
    items,
    audit: object(d.audit, "审计状态"),
    session: object(d.session ?? {}, "会话存储状态"),
  };
}
type Entry = { item: Setting; section: string; risk: string };
type Bucket = { group: GroupKey; entries: Entry[] };

/**
 * Group every non-retired key by domain. Unknown keys land in "other" instead of
 * disappearing, so a backend that grows a new knob still shows it somewhere.
 */
function bucket(items: Setting[]): Bucket[] {
  const buckets: Bucket[] = GROUPS.map(({ key }) => ({ group: key, entries: [] }));
  const index = new Map(buckets.map((b) => [b.group, b]));
  for (const item of items) {
    if (isRetired(item.key)) continue;
    const meta = metaFor(item.key);
    index.get(meta.group)?.entries.push({ item, section: meta.section ?? "", risk: meta.risk });
  }
  return buckets.filter((b) => b.entries.length > 0);
}
function sectionsOf(entries: Entry[]): { title: string; entries: Entry[] }[] {
  const order: string[] = [];
  const grouped = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (!grouped.has(entry.section)) {
      grouped.set(entry.section, []);
      order.push(entry.section);
    }
    grouped.get(entry.section)?.push(entry);
  }
  return order.map((title) => ({ title, entries: grouped.get(title) ?? [] }));
}
function matches(item: Setting, query: string) {
  if (!query) return true;
  const meta = metaFor(item.key);
  const haystack = [item.key, item.label, meta.help ?? "", ...(meta.aliases ?? [])]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? "已复制" : "复制命令"}
    </Button>
  );
}

/**
 * One setting: what the key does on the left, its control on the right.
 *
 * The control is named through `aria-labelledby` pointing at the row's own title
 * rather than a wrapping Field: the visible title is already on screen, and repeating it
 * above the control would print the same words twice. A Field is the right shape when the
 * label belongs *on* the control (the confirmation phrase below); a settings row is a
 * definition list, so the title names the control and key/help/badges stay beside it.
 */
function SettingRow({
  entry,
  value,
  onChange,
}: {
  entry: Entry;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { item, risk } = entry;
  const meta = metaFor(item.key);
  const elsewhere = MANAGED_ELSEWHERE[item.key];
  const titleId = useId();
  const knownType = [
    "boolean",
    "bool",
    "integer",
    "int",
    "number",
    "float",
    "string",
    "str",
  ].includes(item.type);
  const numeric = ["integer", "int", "number", "float"].includes(item.type);
  const boolean = ["boolean", "bool"].includes(item.type);
  const concealed = item.locked && ["secret", "paths", "path"].includes(item.type);
  const pendingValue =
    item.stored !== null && item.stored !== undefined && item.stored !== item.value;
  const human = humanValue(meta.unit, item.locked ? item.value : value);

  let body: ReactNode;
  if (elsewhere) {
    body = (
      <>
        <p className={s.note}>
          当前值：{displayValue(item.value)}。这个开关属于模型域，改在这里会同时影响所有模型，
          所以只在模型页提供编辑。
        </p>
        <Link className={s.link} to={elsewhere.href}>
          {elsewhere.label}
        </Link>
      </>
    );
  } else if (item.locked) {
    body = <p className={s.note}>{lockReason(item)}</p>;
  } else if (!knownType && !item.choices) {
    body = <p className={s.note}>此项暂不支持编辑。</p>;
  } else {
    body = (
      <>
        {item.choices ? (
          <Select
            label={item.label}
            value={JSON.stringify(value)}
            onChange={(next) => onChange(JSON.parse(next) as unknown)}
          >
            {!item.choices.some((choice) => JSON.stringify(choice) === JSON.stringify(value)) && (
              <option value={JSON.stringify(value)} disabled>
                {text(value)}
              </option>
            )}
            {item.choices.map((choice) => (
              <option value={JSON.stringify(choice)} key={JSON.stringify(choice)}>
                {text(choice)}
              </option>
            ))}
          </Select>
        ) : boolean ? (
          <span className={s.switchRow}>
            <Switch label={item.label} checked={value === true} onChange={onChange} />
            <span className={s.switchLabel}>{displayValue(value === true)}</span>
          </span>
        ) : (
          <Input
            aria-labelledby={titleId}
            type={numeric ? "number" : "text"}
            value={value === null || value === undefined ? "" : text(value)}
            min={item.min}
            max={item.max}
            step={["int", "integer"].includes(item.type) ? 1 : "any"}
            required={numeric}
            onChange={(event) =>
              onChange(
                numeric
                  ? event.target.value === ""
                    ? ""
                    : Number(event.target.value)
                  : event.target.value,
              )
            }
          />
        )}
        {human && <span className={s.note}>{human}</span>}
      </>
    );
  }
  return (
    <div className={s.setting} data-key={item.key}>
      <div className={s.describe}>
        <strong className={s.name} id={titleId}>
          {item.label}
        </strong>
        <code className={s.key}>{item.key}</code>
        {meta.help && <small className={s.help}>{meta.help}</small>}
        <Cluster gap="1">
          <Badge>{sourceLabels[item.source] ?? "未知来源"}</Badge>
          <Badge tone={item.mode === "hot" ? "good" : "warn"}>
            {modeLabels[item.mode] ?? "生效方式未知"}
          </Badge>
          {risk !== "p2" && (
            <Badge tone={RISK_TONE[risk as "p0" | "p1"]}>{RISK_LABEL[risk as "p0" | "p1"]}</Badge>
          )}
          {item.locked && item.source !== "internal" && <Badge tone="warn">外部锁定</Badge>}
        </Cluster>
        {!concealed && (item.locked || pendingValue) && (
          <small className={s.note}>
            当前生效：{displayValue(item.value)}
            {human && `（${human}）`}
          </small>
        )}
        {!concealed && pendingValue && (
          <small className={s.note}>已保存：{displayValue(item.stored)}</small>
        )}
      </div>
      <div className={s.control}>{body}</div>
    </div>
  );
}
function ConfirmDanger({
  entries,
  values,
  onClose,
  onConfirm,
}: {
  entries: Entry[];
  values: RecordValue;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  const ready = phrase === CONFIRM_PHRASE;
  return (
    <Drawer
      title="确认修改高风险配置"
      closeLabel={t("common.closeDrawer")}
      onClose={onClose}
      footer={
        <Button variant="danger" disabled={!ready} onClick={onConfirm}>
          确认修改
        </Button>
      }
    >
      <div className={s.danger}>
        <div className={s.pendingHead}>
          <Icon name="alert" size="sm" />
          <strong>以下 {entries.length} 项会立刻改变线上行为</strong>
        </div>
        <p className={s.note}>保存后即时生效，不会二次确认，也没有撤销。请逐条核对新旧值。</p>
      </div>
      <ul className={s.list}>
        {entries.map(({ item }) => (
          <li key={item.key} className={s.listItem}>
            <div className={s.describe}>
              <strong className={s.name}>{item.label}</strong>
              <code className={s.key}>{item.key}</code>
              <span className={s.note}>
                {displayValue(item.stored ?? item.value)} → {displayValue(values[item.key])}
              </span>
              {metaFor(item.key).help && <small className={s.help}>{metaFor(item.key).help}</small>}
            </div>
          </li>
        ))}
      </ul>
      <Field label={`输入“${CONFIRM_PHRASE}”以继续`}>
        <Input
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          autoComplete="off"
          autoFocus
        />
      </Field>
    </Drawer>
  );
}
function SettingsForm({
  data,
  reload,
}: {
  data: ReturnType<typeof normalize>;
  reload: () => void;
}) {
  const [values, setValues] = useState<RecordValue>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<GroupKey | null>(null);
  /**
   * P3-1: the account tab is *derived* from the address instead of being read once from
   * `window.location` on mount. The bootstrap banner links to `?tab=account`;
   * the sidebar's 系统 link goes back to `/dashboard/system`, and the page used to stay
   * on 管理账户 while the address said otherwise, because nothing re-read the query.
   */
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const account = params.get("tab") === "account";
  const buckets = useMemo(() => bucket(data.items), [data.items]);
  // The admin account is a sibling of the settings domains, not a domain of its own: it
  // has no schema row to save, so it replaces the whole settings Panel below.
  const current = account ? undefined : (buckets.find((b) => b.group === tab) ?? buckets[0]);
  const count = Object.keys(values).length;
  const update = (item: Setting, value: unknown) => {
    setSaved(false);
    setValues((old) => {
      const next = { ...old };
      if (value === (item.stored ?? item.value)) delete next[item.key];
      else next[item.key] = value;
      return next;
    });
  };
  const submit = useCallback(() => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    void api
      .patch("/settings", { revision: data.revision, values })
      .then(() => {
        setValues({});
        setSaved(true);
        reload();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  }, [data.revision, reload, values]);
  const risky = useMemo(
    () =>
      Object.keys(values).length === 0
        ? []
        : buckets
            .flatMap((b) => b.entries)
            .filter((entry) => entry.risk === "p0" && Object.hasOwn(values, entry.item.key)),
    [buckets, values],
  );
  const search = query.trim();
  // An empty search filters the selected domain; a non-empty one searches every domain,
  // because "where is this knob" is exactly the question a user cannot answer yet.
  const hits = search
    ? buckets.flatMap((bucket) =>
        bucket.entries
          .filter((entry) => matches(entry.item, search))
          .map((entry) => ({ ...entry, group: bucket.group })),
      )
    : [];
  const filtered = current ? current.entries.filter((entry) => matches(entry.item, search)) : [];
  const restarting = pendingRestart(data.items);
  const total = buckets.reduce((sum, bucket) => sum + bucket.entries.length, 0);
  /**
   * Switching tabs is a navigation, not local state: 管理账户 lives in `?tab=account`,
   * so the address and the visible panel can never disagree. A domain tab clears that
   * parameter again (replace, so hopping between tabs does not stack history entries).
   */
  const selectTab = (next: GroupKey | "account") => {
    setQuery("");
    const target = new URLSearchParams(location.search);
    if (next === "account") {
      target.set("tab", "account");
      void navigate({ search: `?${target.toString()}` }, { replace: true });
      return;
    }
    setTab(next);
    if (!target.has("tab")) return;
    target.delete("tab");
    const rest = target.toString();
    void navigate({ search: rest ? `?${rest}` : "" }, { replace: true });
  };
  /* The domain tabs are the second level of navigation: the area switcher above them
     (?section=) addresses a section, these address a domain inside this page. The selected
     tab paints its own background and border — no indicator block over the label, which
     is what made P1-1's selected segment unreadable. */
  const tabBar = (
    <div className={s.tabs} role="tablist" aria-label="配置分组">
      {buckets.map((bucket) => {
        const title = GROUPS.find((g) => g.key === bucket.group)?.title ?? bucket.group;
        const dirty = bucket.entries.filter((entry) => Object.hasOwn(values, entry.item.key));
        return (
          <button
            key={bucket.group}
            type="button"
            role="tab"
            aria-selected={!account && current?.group === bucket.group}
            className={s.tab}
            onClick={() => selectTab(bucket.group)}
          >
            <span>
              {title}（{bucket.entries.length}）
            </span>
            {dirty.length > 0 && <span className={s.dirty}>· {dirty.length} 处改动</span>}
          </button>
        );
      })}
      <button
        type="button"
        role="tab"
        aria-selected={account}
        className={s.tab}
        onClick={() => selectTab("account")}
      >
        {t("account.title")}
      </button>
    </div>
  );
  // The account panel submits its own form, so it cannot live inside this one (a form
  // never nests in HTML): the tab swaps the whole settings form for that panel.
  if (account)
    return (
      <Stack gap="4">
        {tabBar}
        <AccountPanel />
      </Stack>
    );
  return (
    <Stack gap="4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!count) return;
          if (risky.length) {
            setConfirming(true);
            return;
          }
          submit();
        }}
      >
        <Stack gap="4">
          {restarting.length > 0 && (
            <div className={s.pending} role="status">
              <div className={s.pendingHead}>
                <Icon name="alert" size="sm" />
                <strong>{restarting.length} 项已保存但尚未生效：</strong>
              </div>
              <code className={s.key}>{restarting.join("、")}</code>
              <p className={s.note}>{RESTART_HINT}</p>
              <Toolbar split gap="2">
                <code className={s.code}>{RESTART_COMMAND}</code>
                <CopyCommand command={RESTART_COMMAND} />
              </Toolbar>
            </div>
          )}
          {tabBar}
          {current && (
            <Panel
              title={GROUPS.find((g) => g.key === current.group)?.title ?? current.group}
              hint={GROUPS.find((g) => g.key === current.group)?.description}
            >
              <Toolbar split gap="2">
                <Input
                  className={s.search}
                  type="search"
                  value={query}
                  placeholder="搜索配置：键名、名称或说明，如 并发 / 脱敏 / cooldown"
                  aria-label="搜索配置项"
                  onChange={(e) => setQuery(e.target.value)}
                />
                <span className={s.note}>
                  {search
                    ? `全部 ${total} 项中匹配 ${hits.length} 项`
                    : `共 ${current.entries.length} 项`}
                </span>
              </Toolbar>
              {search ? (
                hits.length ? (
                  hits.map((entry) => (
                    <div key={entry.item.key}>
                      <div className={s.sectionHead}>
                        <strong>
                          {GROUPS.find((group) => group.key === entry.group)?.title ?? entry.group}
                        </strong>
                        <span className={s.key}>{entry.item.key}</span>
                      </div>
                      <SettingRow
                        entry={entry}
                        value={
                          Object.hasOwn(values, entry.item.key)
                            ? values[entry.item.key]
                            : (entry.item.stored ?? entry.item.value)
                        }
                        onChange={(next) => update(entry.item, next)}
                      />
                    </div>
                  ))
                ) : (
                  <Empty title="没有匹配的配置项">换个关键词，或清空搜索。</Empty>
                )
              ) : (
                sectionsOf(filtered).map((section) => (
                  <div key={section.title || "root"}>
                    {section.title && (
                      <div className={s.sectionHead}>
                        <strong>{section.title}</strong>
                        <span>{section.entries.length}</span>
                      </div>
                    )}
                    {section.entries.map((entry) => {
                      const item = entry.item;
                      const value = Object.hasOwn(values, item.key)
                        ? values[item.key]
                        : (item.stored ?? item.value);
                      return (
                        <SettingRow
                          key={item.key}
                          entry={entry}
                          value={value}
                          onChange={(next) => update(item, next)}
                        />
                      );
                    })}
                  </div>
                ))
              )}
              {!search && !filtered.length && <Empty title="没有配置项" />}
            </Panel>
          )}
          <div className={s.saveBar}>
            <span className={s.note}>
              {count
                ? `${count} 项待保存${risky.length ? `（其中 ${risky.length} 项高风险，保存前需确认）` : ""}`
                : saved
                  ? "设置已保存"
                  : "没有待保存的更改"}
            </span>
            <Button variant="primary" type="submit" disabled={!count || busy}>
              {busy ? "正在保存…" : "保存更改"}
            </Button>
          </div>
          <ErrorNotice message={error} />
        </Stack>
      </form>
      <DrawerPresence>
        {confirming && (
          <ConfirmDanger
            entries={risky}
            values={values}
            onClose={() => setConfirming(false)}
            onConfirm={submit}
          />
        )}
      </DrawerPresence>
      {data.session.degraded === true && (
        <Panel title="会话存储">
          <div className={s.cardHead}>
            <Badge tone="bad">撤销未生效</Badge>
          </div>
          <p className={s.eventBody}>
            会话快照无法写入或清除，退出登录可能未真正生效。请检查管理目录权限后重试退出登录。
          </p>
          <details>
            <summary className={s.link}>查看存储详情</summary>
            <Fields data={data.session} />
          </details>
        </Panel>
      )}
    </Stack>
  );
}
export function Settings() {
  const resource = useResource("/settings", normalize);
  const restarting = resource.data ? pendingRestart(resource.data.items) : [];
  // Publish the derived set so the sidebar can show "a restart is pending" without
  // fetching the schema itself. Stable join keeps the effect from firing per render.
  const signature = restarting.join(",");
  useEffect(() => {
    publishPendingRestart(signature ? signature.split(",") : []);
  }, [signature]);
  return (
    <Page
      title="系统设置"
      description="按领域分组的网关配置。高风险项保存前会要求确认。"
      actions={
        <Button onClick={resource.reload} icon={<Icon name="refresh" spin={resource.refreshing} />}>
          重新读取
        </Button>
      }
    >
      {resource.loading && !resource.data && (
        <Skeleton variant="line" label={t("common.loading")} />
      )}
      <ErrorNotice
        message={resource.error}
        retry={{ label: t("common.retry"), onClick: resource.reload }}
      />
      {resource.data && <SettingsForm data={resource.data} reload={resource.reload} />}
    </Page>
  );
}
