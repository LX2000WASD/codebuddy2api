import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { api, errorMessage, list, object, text, useResource, type RecordValue } from "../api";
import {
  Badge,
  Drawer,
  Empty,
  ErrorNotice,
  Fields,
  Icon,
  PageTitle,
  Panel,
  ResourceState,
} from "../components";
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
import s from "../ui.module.scss";
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
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? "已复制" : "复制命令"}
    </button>
  );
}
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
  return (
    <div className={s.setting} data-key={item.key} data-risk={risk}>
      <div className={s.settingDescription}>
        <strong title={item.key}>{item.label}</strong>
        <small className={s.mono}>{item.key}</small>
        {meta.help && <small>{meta.help}</small>}
        <div className={s.actions}>
          <Badge>{sourceLabels[item.source] ?? "未知来源"}</Badge>
          <Badge tone={item.mode === "hot" ? "good" : "warn"}>
            {modeLabels[item.mode] ?? "生效方式未知"}
          </Badge>
          {risk !== "p2" && (
            <Badge tone={RISK_TONE[risk as "p0" | "p1"]}>{RISK_LABEL[risk as "p0" | "p1"]}</Badge>
          )}
          {item.locked && item.source !== "internal" && <Badge tone="warn">外部锁定</Badge>}
        </div>
        {!concealed && (item.locked || pendingValue) && (
          <small>
            当前生效：{displayValue(item.value)}
            {human && `（${human}）`}
          </small>
        )}
        {!concealed && pendingValue && <small>已保存：{displayValue(item.stored)}</small>}
      </div>
      <div className={s.settingControl}>
        {elsewhere ? (
          <>
            <p className={s.note}>
              当前值：{displayValue(item.value)}。这个开关属于模型域，改在这里会同时影响所有模型，
              所以只在模型页提供编辑。
            </p>
            <Link className={s.linkButton} to={elsewhere.href}>
              {elsewhere.label}
            </Link>
          </>
        ) : item.locked ? (
          <p className={s.note}>{lockReason(item)}</p>
        ) : !knownType && !item.choices ? (
          <p className={s.note}>此项暂不支持编辑。</p>
        ) : (
          <label className={s.field}>
            {item.choices ? (
              <select
                aria-label={item.label}
                value={JSON.stringify(value)}
                onChange={(e) => onChange(JSON.parse(e.target.value) as unknown)}
              >
                {!item.choices.some(
                  (choice) => JSON.stringify(choice) === JSON.stringify(value),
                ) && (
                  <option value={JSON.stringify(value)} disabled>
                    {text(value)}
                  </option>
                )}
                {item.choices.map((choice) => (
                  <option value={JSON.stringify(choice)} key={JSON.stringify(choice)}>
                    {text(choice)}
                  </option>
                ))}
              </select>
            ) : boolean ? (
              <span className={s.check}>
                <input
                  type="checkbox"
                  aria-label={item.label}
                  checked={value === true}
                  onChange={(e) => onChange(e.target.checked)}
                />
                {value === true ? "开启" : "关闭"}
              </span>
            ) : (
              <input
                type={numeric ? "number" : "text"}
                aria-label={item.label}
                value={value === null || value === undefined ? "" : text(value)}
                min={item.min}
                max={item.max}
                step={["int", "integer"].includes(item.type) ? 1 : "any"}
                required={numeric}
                onChange={(e) =>
                  onChange(
                    numeric
                      ? e.target.value === ""
                        ? ""
                        : Number(e.target.value)
                      : e.target.value,
                  )
                }
              />
            )}
            {human && <small>{human}</small>}
          </label>
        )}
      </div>
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
    <Drawer title="确认修改高风险配置" onClose={onClose}>
      <div className={s.warning}>
        <Icon name="alert" />
        <div>
          <strong>以下 {entries.length} 项会立刻改变线上行为</strong>
          <p>保存后即时生效，不会二次确认，也没有撤销。请逐条核对新旧值。</p>
        </div>
      </div>
      <ul className={s.bulkList}>
        {entries.map(({ item }) => (
          <li key={item.key}>
            <div className={s.bulkListItem}>
              <strong>{item.label}</strong>
              <code>{item.key}</code>
              <span>
                {displayValue(item.stored ?? item.value)} → {displayValue(values[item.key])}
              </span>
            </div>
            {metaFor(item.key).help && (
              <small className={s.settingDescription}>{metaFor(item.key).help}</small>
            )}
          </li>
        ))}
      </ul>
      <label className={s.field}>
        输入“{CONFIRM_PHRASE}”以继续
        <input
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          autoComplete="off"
          autoFocus
        />
      </label>
      <button className={s.danger} disabled={!ready} onClick={onConfirm}>
        确认修改
      </button>
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
  const buckets = useMemo(() => bucket(data.items), [data.items]);
  const current = buckets.find((b) => b.group === tab) ?? buckets[0];
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
  return (
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
      {restarting.length > 0 && (
        <div className={s.pendingRestart} role="status">
          <Icon name="alert" />
          <div>
            <strong>{restarting.length} 项已保存但尚未生效：</strong>
            <span className={s.mono}>{restarting.join("、")}</span>
            <p>{RESTART_HINT}</p>
          </div>
          <code>{RESTART_COMMAND}</code>
          <CopyCommand command={RESTART_COMMAND} />
        </div>
      )}
      <div className={s.sectionNav} role="tablist" aria-label="配置分组">
        {buckets.map((bucket) => {
          const title = GROUPS.find((g) => g.key === bucket.group)?.title ?? bucket.group;
          const dirty = bucket.entries.filter((entry) => Object.hasOwn(values, entry.item.key));
          return (
            <button
              key={bucket.group}
              type="button"
              role="tab"
              aria-selected={current?.group === bucket.group}
              className={current?.group === bucket.group ? s.sectionActive : ""}
              onClick={() => {
                setTab(bucket.group);
                setQuery("");
              }}
            >
              {title}（{bucket.entries.length}）
              {dirty.length > 0 && <span className={s.chipOn}> · {dirty.length} 处改动</span>}
            </button>
          );
        })}
      </div>
      {current && (
        <Panel
          title={GROUPS.find((g) => g.key === current.group)?.title ?? current.group}
          hint={GROUPS.find((g) => g.key === current.group)?.description}
        >
          <div className={s.toolbar}>
            <input
              type="search"
              value={query}
              placeholder="搜索配置：键名、名称或说明，如 并发 / 脱敏 / cooldown"
              aria-label="搜索配置项"
              onChange={(e) => setQuery(e.target.value)}
            />
            <small>
              {search
                ? `全部 ${buckets.reduce((total, bucket) => total + bucket.entries.length, 0)} 项中匹配 ${hits.length} 项`
                : `共 ${current.entries.length} 项`}
            </small>
          </div>
          {search
            ? !hits.length && <Empty title="没有匹配的配置项">换个关键词，或清空搜索。</Empty>
            : !filtered.length && <Empty title="没有配置项" />}
          {search
            ? hits.map((entry) => (
                <div key={entry.item.key}>
                  <div className={s.storageSectionHead}>
                    <strong>
                      {GROUPS.find((group) => group.key === entry.group)?.title ?? entry.group}
                    </strong>
                    <span>{entry.item.key}</span>
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
            : sectionsOf(filtered).map((section) => (
                <div key={section.title || "root"}>
                  {section.title && (
                    <div className={s.storageSectionHead}>
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
              ))}
        </Panel>
      )}
      <div className={s.saveBar}>
        <span>
          {count
            ? `${count} 项待保存${risky.length ? `（其中 ${risky.length} 项高风险，保存前需确认）` : ""}`
            : saved
              ? "设置已保存"
              : "没有待保存的更改"}
        </span>
        <button className={s.primary} disabled={!count || busy}>
          {busy ? "正在保存…" : "保存更改"}
        </button>
      </div>
      <ErrorNotice message={error} />
      {confirming && (
        <ConfirmDanger
          entries={risky}
          values={values}
          onClose={() => setConfirming(false)}
          onConfirm={submit}
        />
      )}
      {data.session.degraded === true && (
        <Panel title="会话存储">
          <Badge tone="bad">撤销未生效</Badge>
          <p>会话快照无法写入或清除，退出登录可能未真正生效。请检查管理目录权限后重试退出登录。</p>
          <details className={s.chartData}>
            <summary>查看存储详情</summary>
            <Fields data={data.session} />
          </details>
        </Panel>
      )}
    </form>
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
    <>
      <PageTitle
        title="系统设置"
        description="按领域分组的网关配置。高风险项保存前会要求确认。"
        actions={
          <button onClick={resource.reload}>
            <Icon name="refresh" />
            重新读取
          </button>
        }
      />
      <ResourceState {...resource} />
      {resource.data && <SettingsForm data={resource.data} reload={resource.reload} />}
    </>
  );
}
