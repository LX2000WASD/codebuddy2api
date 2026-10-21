import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  credentialResponse,
  errorMessage,
  list,
  modelResponse,
  normalizeModelLocks,
  object,
  statusOf,
  useResource,
  type Credential,
  type ModelLock,
  type ModelRule,
  type RecordValue,
} from "../api";
import {
  Badge,
  DataValue,
  Drawer,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Icon,
  PageTitle,
  Panel,
  ResourceState,
  Skeleton,
  profileLabel,
} from "../components";
import {
  ColumnMenu,
  DataTable,
  useColumnVisibility,
  type DataTableColumn,
  type SortingState,
} from "../dataTable";
import {
  CapabilityChips,
  EffortChips,
  ModelMetadata,
  SpecValue,
  effortSummary,
  formatRate,
  modelDisplayName,
  modelSearchText,
  rateOf,
  specRange,
} from "../modelMetadata";
import { useFusionResource } from "../fusion/client";
import {
  HealthSparkline,
  ModelHealthCell,
  SPARKLINE_LIMIT,
  healthFor,
  sparklineKeys,
  useModelHealth,
  useModelSparklines,
  type ModelHealth,
  type SparklineEntry,
} from "../insights";
import { t } from "../i18n";
import s from "../ui.module.scss";
export const profiles = ["cn-cli", "cn-work", "intl-cli", "intl-work"];
const validId = (id: string) => /^[A-Za-z0-9_.:/@-]{1,160}$/.test(id) && ![".", ".."].includes(id);
export function validateRule(rule: ModelRule, models: ModelRule[]): string | null {
  if (!rule.public_id.trim()) return "对外 ID 不能为空";
  if (rule.public_id !== rule.public_id.trim() || /\s/.test(rule.public_id))
    return "对外 ID 不能包含空白字符";
  if (!validId(rule.public_id)) return "对外 ID 只允许 1–160 位字母、数字及 _ . : / @ -";
  if (!validId(rule.upstream_id ?? rule.id)) return "上游 ID 不能为空，且须为有效模型标识";
  if (
    models.some(
      (m) => m.id !== rule.id && (m.id === rule.public_id || m.public_id === rule.public_id),
    )
  )
    return "对外 ID 与已有模型或别名冲突";
  if (rule.credential_ids.length && (rule.region || rule.profile))
    return "指定账号与区域/产品范围只能选择一种";
  if (rule.region && !["cn", "intl"].includes(rule.region)) return "区域无效";
  if (rule.profile && !profiles.includes(rule.profile)) return "产品无效";
  if (rule.region && rule.profile && !rule.profile.startsWith(`${rule.region}-`))
    return "区域与产品不匹配";
  return null;
}
type Mode = "auto" | "accounts" | "region" | "legacy";
function bindingMode(rule: ModelRule): Mode {
  if (rule.credential_ids.length) return rule.region || rule.profile ? "legacy" : "accounts";
  return rule.region || rule.profile ? "region" : "auto";
}
type Preview = { candidates: RecordValue[]; excluded: RecordValue[] } & Pick<
  ModelRule,
  "capabilities" | "limits" | "metadata_by_profile"
>;
function RoutePreview({ preview }: { preview: Preview }) {
  return (
    <Panel
      title="路由预览"
      hint={`${preview.candidates.length} 个候选 · ${preview.excluded.length} 个不可用`}
    >
      <div className={s.routePreview}>
        {!preview.candidates.length && (
          <p className={s.note}>当前没有可用候选。保存不会授权范围外的账号，也不会绕过账号目录。</p>
        )}
        {[
          ...preview.candidates.map((row) => ({ row, allowed: true })),
          ...preview.excluded.map((row) => ({ row, allowed: false })),
        ].map(({ row, allowed }, i) => (
          <div className={s.routeCandidate} key={i}>
            <div>
              <strong>{typeof row.name === "string" ? row.name : "未命名账号"}</strong>
              <small>
                {typeof row.profile === "string" ? profileLabel(row.profile) : "产品未知"}
              </small>
            </div>
            <Badge tone={allowed ? "good" : "warn"}>
              {allowed ? "候选" : typeof row.reason === "string" ? row.reason : "不可用"}
            </Badge>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RateCell({ model }: { model: ModelRule }) {
  const rate = rateOf(model.credits);
  if (rate === null)
    return (
      <>
        <DataValue value={model.credits} />
        <small className={s.specNote}>产品倍率未知</small>
      </>
    );
  const perProfile =
    model.credits_by_profile &&
    typeof model.credits_by_profile === "object" &&
    !Array.isArray(model.credits_by_profile)
      ? Object.entries(model.credits_by_profile)
      : [];
  const rows = perProfile.filter(([, price]) => perProfile.length > 1 || rateOf(price) !== rate);
  return (
    <div className={s.rateStack}>
      <span className={rate === 0 ? `${s.rateChip} ${s.rateFree}` : s.rateChip}>
        {rate === 0 ? "限时免费 0x" : formatRate(rate)}
      </span>
      {rows.map(([profile, price]) => (
        <small className={s.rateProfile} key={profile}>
          {profileLabel(profile)}{" "}
          {rateOf(price) === null ? "未知" : formatRate(rateOf(price) as number)}
        </small>
      ))}
    </div>
  );
}
/**
 * Locks are grouped by (profile, model) in the backend (app/diagnostic.py:93-150), so one
 * model can hit several rows at once — a cn-cli rate limit next to an intl-work backend
 * block. The cell shows the most severe lock and keeps the rest in the tooltip.
 */
const LOCK_SEVERITY: Record<string, number> = { model_block: 2, rate_limit: 1 };
export function locksForModel(locks: ModelLock[], model: ModelRule): ModelLock[] {
  const names = new Set([model.id, model.upstream_id ?? model.id]);
  return locks.filter((lock) => names.has(lock.model));
}
export function worstLock(locks: ModelLock[]): ModelLock | null {
  let worst: ModelLock | null = null;
  for (const lock of locks)
    if (!worst || (LOCK_SEVERITY[lock.kind] ?? 0) > (LOCK_SEVERITY[worst.kind] ?? 0)) worst = lock;
  return worst;
}
function lockLabel(lock: ModelLock): string {
  return lock.kind === "model_block" ? t("models.locks.modelBlock") : t("models.locks.rateLimit");
}
function lockTitle(locks: ModelLock[]): string {
  return locks
    .map((lock) => {
      const parts = [
        profileLabel(lock.profile),
        lockLabel(lock),
        t("models.locks.count", { count: lock.locked_accounts }),
      ];
      if (lock.reason) parts.push(lock.reason);
      return parts.join(" · ");
    })
    .join("\n");
}

/**
 * "N/M accounts" is the number that answers "can this model serve right now".
 * available_credentials is the backend's own routing preview, so the badge never
 * re-derives eligibility in the browser.
 */
export function AvailabilityCell({
  model,
  total,
  locks,
}: {
  model: ModelRule;
  total: number | null;
  locks: ModelLock[];
}) {
  const available = model.available_credentials;
  const disabled = !model.enabled;
  const tone = disabled
    ? s.availMuted
    : available === undefined
      ? s.availMuted
      : available > 0
        ? s.availGood
        : s.availBad;
  const label = disabled
    ? t("models.avail.disabled")
    : available === undefined
      ? t("models.avail.unknown")
      : available > 0
        ? total === null
          ? t("models.avail.accountsOnly", { available })
          : t("models.avail.accounts", { available, total })
        : t("models.avail.none");
  const title = disabled
    ? t("models.avail.reason.disabled")
    : available === undefined
      ? t("models.avail.reason.unknown")
      : available > 0
        ? t("models.avail.hint", { available, total: total ?? "?" })
        : t("models.avail.reason.noAccounts");
  const worst = worstLock(locks);
  return (
    <div className={s.availStack}>
      <span className={`${s.availBadge} ${tone}`} title={title}>
        {label}
      </span>
      {worst && (
        <span
          className={`${s.availBadge} ${worst.kind === "model_block" ? s.availBad : s.availWarn}`}
          title={lockTitle(locks)}
        >
          {lockLabel(worst)}
          {locks.length > 1 ? ` +${locks.length - 1}` : ""}
        </span>
      )}
    </div>
  );
}

export function ModelEditor({
  model,
  models,
  credentials,
  revision,
  onClose,
  onSaved,
  creating = false,
}: {
  model: ModelRule;
  models: ModelRule[];
  credentials: Credential[] | null;
  revision: number;
  onClose: () => void;
  onSaved: () => void;
  creating?: boolean;
}) {
  const [rule, setRule] = useState({
    ...model,
    upstream_id: model.upstream_id ?? model.id,
    region:
      model.region ||
      (!model.credential_ids.length && profiles.includes(model.profile)
        ? model.profile.split("-")[0]
        : ""),
  });
  const [mode, setMode] = useState<Mode>(() => bindingMode(model));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const request = useRef<AbortController | null>(null);
  const suggestions = useId();
  useEffect(() => () => request.current?.abort(), []);
  const update = <K extends keyof ModelRule>(key: K, value: ModelRule[K]) => {
    setRule((old) => ({ ...old, [key]: value }));
    setPreview(null);
  };
  const chooseMode = (next: Mode) => {
    setMode(next);
    setPreview(null);
    setError(null);
    setRule((old) => ({
      ...old,
      credential_ids: next === "accounts" ? old.credential_ids : [],
      region:
        next === "region" ? old.region || (old.profile.startsWith("intl-") ? "intl" : "cn") : "",
      profile: next === "region" ? old.profile : "",
    }));
  };
  const run = (save: boolean) => {
    const invalid =
      validateRule(rule, models) ??
      (mode === "accounts" && !rule.credential_ids.length ? "请选择至少一个账号" : null);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setBusy(true);
    const controller = new AbortController();
    request.current = controller;
    const payload = {
      revision,
      public_id: rule.public_id,
      upstream_id: rule.upstream_id,
      enabled: rule.enabled,
      keep_original: rule.keep_original,
      region: rule.region || null,
      profile: rule.profile || null,
      credential_ids: rule.credential_ids,
    };
    const path = creating ? "/models" : `/models/${encodeURIComponent(model.id)}`;
    const config = { signal: controller.signal };
    void (
      save
        ? creating
          ? api.post(path, payload, config)
          : api.put(path, payload, config)
        : api.post(`${path}/preview`, payload, config)
    )
      .then((response) => {
        if (controller.signal.aborted) return;
        if (save) {
          const result = object(response.data);
          if (!Number.isInteger(result.revision) || Number(result.revision) <= revision)
            throw new Error("后端未确认模型保存，请刷新后核验");
          onSaved();
          onClose();
        } else {
          const data = object(response.data);
          setPreview({
            candidates: list(data.candidates),
            excluded: list(data.excluded),
            capabilities: data.capabilities,
            limits: data.limits,
            metadata_by_profile: data.metadata_by_profile,
          });
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
  };
  return (
    <Drawer title={creating ? "新增模型" : "编辑模型规则"} onClose={onClose} dismissDisabled={busy}>
      <p className={s.note}>
        对外 ID 供客户端使用，上游 ID
        是发送给官方后端的模型名称。两者独立，账号能力与额度校验仍然生效。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(true);
        }}
      >
        <fieldset className={s.formFields} disabled={busy}>
          <div className={s.formGrid}>
            <label className={s.field}>
              对外 ID
              <input
                value={rule.public_id}
                required
                maxLength={160}
                placeholder="例如 my-coding-model"
                onChange={(e) => update("public_id", e.target.value)}
              />
            </label>
            <label className={s.field}>
              上游 ID
              <input
                value={rule.upstream_id}
                required
                maxLength={160}
                list={suggestions}
                placeholder="实际调用的模型 ID"
                onChange={(e) => update("upstream_id", e.target.value)}
              />
            </label>
            <datalist id={suggestions}>
              {[...new Set(models.map((m) => m.upstream_id ?? m.id))].map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
          </div>
          <div className={s.actions}>
            <label className={s.check}>
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => update("enabled", e.target.checked)}
              />
              启用模型
            </label>
            {!creating && !model.custom && (
              <label className={s.check}>
                <input
                  type="checkbox"
                  checked={rule.keep_original}
                  onChange={(e) => update("keep_original", e.target.checked)}
                />
                同时保留原模型 ID
              </label>
            )}
          </div>
          <fieldset className={s.fieldset}>
            <legend>选择路由方式</legend>
            <div className={s.routeModes}>
              {(
                [
                  ["auto", "自动选择", "按现有账号能力选路"],
                  ["accounts", "指定账号", "只使用选中的账号"],
                  ["region", "指定区域", "仅从该区域中选择"],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  className={`${s.modeOption} ${mode === value ? s.modeSelected : ""}`}
                  key={value}
                >
                  <input
                    type="radio"
                    name={`route-${suggestions}`}
                    value={value}
                    checked={mode === value}
                    onChange={() => chooseMode(value)}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </span>
                </label>
              ))}
            </div>
            <p>账号与区域二选一，切换方式会清除另一种绑定；不可用时不越界回退。</p>
          </fieldset>
          {mode === "legacy" && (
            <div className={s.warning}>
              旧规则同时设置了账号和区域。当前仍按原交集执行，请明确选择一种路由方式后再保存。
            </div>
          )}
          {mode === "region" && (
            <div className={s.formGrid}>
              <label className={s.field}>
                区域
                <select
                  value={rule.region || (rule.profile.startsWith("intl-") ? "intl" : "cn")}
                  onChange={(e) => {
                    const region = e.target.value;
                    setRule((old) => ({
                      ...old,
                      region,
                      profile: old.profile.startsWith(`${region}-`) ? old.profile : "",
                    }));
                    setPreview(null);
                  }}
                >
                  <option value="cn">中国大陆 · CN</option>
                  <option value="intl">国际 · INTL</option>
                </select>
              </label>
              <label className={s.field}>
                产品
                <select value={rule.profile} onChange={(e) => update("profile", e.target.value)}>
                  <option value="">不限产品</option>
                  {profiles
                    .filter((p) => !rule.region || p.startsWith(`${rule.region}-`))
                    .map((p) => (
                      <option key={p} value={p}>
                        {profileLabel(p)}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          )}
          {mode === "accounts" && (
            <fieldset className={s.fieldset}>
              <legend>指定凭证</legend>
              {credentials === null ? (
                <p>凭证列表未加载，现有绑定保持不变。</p>
              ) : !credentials.length ? (
                <p>暂无账号，请先在凭证管理添加。</p>
              ) : (
                credentials.map((c) => (
                  <label className={s.accountChoice} key={c.id}>
                    <input
                      type="checkbox"
                      checked={rule.credential_ids.includes(c.id)}
                      onChange={(e) =>
                        update(
                          "credential_ids",
                          e.target.checked
                            ? [...rule.credential_ids, c.id]
                            : rule.credential_ids.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <span>
                      <strong>{c.name ?? c.id}</strong>
                      <small>
                        {typeof c.profile === "string" ? profileLabel(c.profile) : "产品未知"}
                      </small>
                    </span>
                    {c.enabled === false && <Badge tone="warn">已停用</Badge>}
                  </label>
                ))
              )}
              {rule.credential_ids
                .filter((id) => !credentials?.some((c) => c.id === id))
                .map((id) => (
                  <label className={s.check} key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        update(
                          "credential_ids",
                          rule.credential_ids.filter((v) => v !== id),
                        )
                      }
                    />
                    {id} · 未在当前列表中
                  </label>
                ))}
            </fieldset>
          )}
        </fieldset>
        <ErrorNotice message={error} />
        <div className={s.actions}>
          <button type="button" disabled={busy} onClick={() => run(false)}>
            预览候选路由
          </button>
          <button className={s.primary} disabled={busy}>
            {busy ? "处理中…" : creating ? "创建模型" : "保存规则"}
          </button>
        </div>
      </form>
      {preview && (
        <>
          <RoutePreview preview={preview} />
          <ModelMetadata model={preview} />
        </>
      )}
    </Drawer>
  );
}
const emptyRule: ModelRule = {
  id: "",
  public_id: "",
  upstream_id: "",
  enabled: true,
  keep_original: false,
  region: "",
  profile: "",
  credential_ids: [],
};
type CatalogFilter = { region: string; capability: string; effort: string; price: string };
const emptyFilter: CatalogFilter = { region: "", capability: "", effort: "", price: "" };
const EFFORT_FILTERS = ["low", "medium", "high", "xhigh", "max"];
/** Unknown rates sort last: "not reported" must not read as the cheapest model. */
function rateValue(model: ModelRule): number | undefined {
  return rateOf(model.credits) ?? undefined;
}
function widestWindow(model: ModelRule, kind: "input" | "output"): number | undefined {
  return specRange(model, kind === "input" ? "maxInputTokens" : "maxOutputTokens").at(-1);
}
function matchesCatalog(model: ModelRule, query: string, filter: CatalogFilter): boolean {
  if (query) {
    const text = modelSearchText(model);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.every((term) => text.includes(term))) return false;
  }
  if (filter.region) {
    if (filter.region === "auto") {
      if (bindingMode(model) !== "auto") return false;
    } else if (model.region !== filter.region) return false;
  }
  if (filter.capability) {
    const declared =
      model.capabilities && typeof model.capabilities === "object"
        ? (model.capabilities as RecordValue)
        : {};
    if (declared[filter.capability] !== "supported") return false;
  }
  if (filter.effort) {
    const efforts = effortSummary(model);
    if (filter.effort === "off" ? !efforts.closable : !efforts.options.includes(filter.effort))
      return false;
  }
  if (filter.price === "free" && rateOf(model.credits) !== 0) return false;
  if (filter.price === "paid" && (rateOf(model.credits) ?? 0) <= 0) return false;
  return true;
}
/**
 * Optional columns start hidden: eight columns already forced a horizontal scroll at
 * 1280px, so identity, rate, capability, availability, route boundary and actions win.
 * The choice persists per browser, like the credential page's page size. Below
 * 900px the rate and capability columns drop out too — a phone should show the
 * identity and whether the model can serve, not a horizontal scrollbar.
 */
const COLUMNS_KEY = "codebuddy.models.columns";
type ColumnKey =
  | "rate"
  | "capability"
  | "availability"
  | "context"
  | "output"
  | "effort"
  | "boundary";
const DEFAULT_HIDDEN: ColumnKey[] = ["context", "output", "effort"];

type BulkAction = "enable" | "disable";
/**
 * PUT /admin/models/{id} rewrites the whole rule: a body carrying only
 * {revision, enabled} silently drops public_id, keep_original, the region/profile scope
 * and every account binding, and still answers 200. Bulk writes replay the full rule.
 */
export function bulkPayload(model: ModelRule, enabled: boolean, revision: number) {
  return {
    revision,
    public_id: model.public_id,
    upstream_id: model.upstream_id ?? model.id,
    enabled,
    keep_original: model.keep_original,
    region: model.region || null,
    profile: model.profile || null,
    credential_ids: model.credential_ids,
  };
}
/** Legacy rows mix an account list with a region/profile scope; replaying them is rejected. */
export function legacyScope(model: ModelRule): boolean {
  return model.credential_ids.length > 0 && Boolean(model.region || model.profile);
}

/**
 * The catalog's columns. `id` doubles as the DataTable sort key and the
 * localStorage visibility key, so it must stay stable across releases.
 *
 * Built per render rather than at module scope because the cells read live page
 * state (account total, diagnostic locks, the row actions' callbacks).
 */
function modelColumns({
  totalAccounts,
  locks,
  health,
  sparks,
  onDetails,
  onEdit,
  onDelete,
  actionsDisabled,
}: {
  totalAccounts: number | null;
  locks: ModelLock[];
  health: Map<string, ModelHealth>;
  sparks: Map<string, SparklineEntry>;
  onDetails: (model: ModelRule) => void;
  onEdit: (model: ModelRule) => void;
  onDelete: (model: ModelRule) => void;
  actionsDisabled: boolean;
}): DataTableColumn<ModelRule>[] {
  return [
    {
      id: "id",
      header: t("models.col.id"),
      cell: (m) => (
        <div className={s.modelCell}>
          <div className={s.modelIdLine}>
            <strong className={s.modelName}>{m.public_id}</strong>
            {!m.enabled && <Badge tone="neutral">{t("models.avail.disabled")}</Badge>}
            {m.custom && <Badge>自建</Badge>}
          </div>
          <small className={s.mono}>{m.upstream_id ?? m.id}</small>
          {modelDisplayName(m) && <small>{modelDisplayName(m)}</small>}
          {m.keep_original && <small>同时保留 {m.id}</small>}
        </div>
      ),
      sortValue: (m) => m.public_id,
    },
    {
      id: "rate",
      header: t("models.col.rate"),
      cell: (m) => <RateCell model={m} />,
      sortValue: rateValue,
      sortUndefined: "last",
      optional: true,
      hideBelow: 900,
    },
    {
      id: "capability",
      header: t("models.col.capability"),
      cell: (m) => <CapabilityChips model={m} />,
      className: s.capCell,
      optional: true,
      hideBelow: 900,
    },
    {
      id: "availability",
      header: t("models.avail.title"),
      cell: (m) => (
        <AvailabilityCell model={m} total={totalAccounts} locks={locksForModel(locks, m)} />
      ),
    },
    {
      // Seven-day health: the aggregate badge is available for every row (one shared
      // dimensions query), the sparkline only for the busiest rows in the current
      // view (one series request each, capped — see insights.tsx).
      id: "health",
      header: t("models.health.column"),
      cell: (m) => {
        // Aggregates are keyed by the requested model name (public_id); the rule id
        // is only a local handle and would match nothing in the audit store.
        const spark = sparks.get(m.public_id) ?? sparks.get(m.id);
        return (
          <ModelHealthCell
            name={m.public_id}
            health={healthFor(health, m)}
            spark={
              spark?.rows ? (
                <HealthSparkline name={m.public_id} rows={spark.rows} />
              ) : spark?.loading ? (
                <span className={s.sparklineEmpty}>{t("models.health.loading")}</span>
              ) : undefined
            }
          />
        );
      },
      optional: true,
      // The same breakpoint the rate and capability columns use: a phone shows
      // identity, availability and health, and drops the rest.
      hideBelow: 900,
    },
    {
      id: "context",
      header: t("models.col.context"),
      cell: (m) => <SpecValue model={m} kind="input" />,
      className: s.specCell,
      sortValue: (m) => widestWindow(m, "input"),
      sortDescFirst: true,
      sortUndefined: "last",
      optional: true,
    },
    {
      id: "output",
      header: t("models.col.output"),
      cell: (m) => <SpecValue model={m} kind="output" />,
      className: s.specCell,
      sortValue: (m) => widestWindow(m, "output"),
      sortDescFirst: true,
      sortUndefined: "last",
      optional: true,
    },
    {
      id: "effort",
      header: t("models.col.effort"),
      cell: (m) => <EffortChips model={m} />,
      optional: true,
    },
    {
      id: "boundary",
      header: t("models.col.boundary"),
      cell: (m) => (
        <>
          {m.credential_ids.length
            ? `${m.credential_ids.length} 个指定账号`
            : m.region
              ? profileLabel(m.region)
              : "自动选择"}
          <small>
            {m.profile
              ? profileLabel(m.profile)
              : m.credential_ids.length
                ? "严格绑定，不越界回退"
                : "按账号能力选择"}
          </small>
          {bindingMode(m) === "legacy" && <Badge tone="warn">旧联合范围</Badge>}
        </>
      ),
      optional: true,
    },
    {
      id: "actions",
      header: t("models.col.actions"),
      cell: (m) => (
        <div className={s.rowActions}>
          <button onClick={() => onDetails(m)}>模型详情</button>
          <button disabled={actionsDisabled} onClick={() => onEdit(m)}>
            编辑规则
          </button>
          {m.custom && (
            <button className={s.textDanger} disabled={actionsDisabled} onClick={() => onDelete(m)}>
              删除
            </button>
          )}
        </div>
      ),
    },
  ];
}

export function Models() {
  const resource = useResource("/models", modelResponse, { cache: true });
  const credentials = useResource("/credentials", credentialResponse, { cache: true });
  // Advisory only: without the diagnostic endpoint the table still shows the account
  // counts the model catalog itself reports.
  const diagnostic = useFusionResource("/admin/diagnostic", null, normalizeModelLocks);
  // Stable identity matters: a fresh `[]` on every render rebuilds the column
  // definitions, which makes TanStack rebuild every row and replace the row DOM
  // nodes. That is exactly the e2e "element is not attached to the DOM" failure,
  // and it would also throw away focus and the scroll anchor on every render.
  const locks = useMemo(() => diagnostic.data?.model_locks ?? [], [diagnostic.data]);
  const totalAccounts = credentials.data?.length ?? null;
  const [query, setQuery] = useState("");
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const detailed = resource.data?.models.find((model) => model.id === detailsId);
  const [editing, setEditing] = useState<ModelRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [editorRevision, setEditorRevision] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<ModelRule | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardNotice, setGuardNotice] = useState<string | null>(null);
  const toggleGuard = (key: "model_guard" | "model_capability_guard", next: boolean) => {
    if (!resource.data || busy) return;
    setBusy(true);
    setError(null);
    setGuardNotice(null);
    void api
      .patch("/settings", {
        revision: resource.data.revision,
        values: { [key]: next },
      })
      .then(() => {
        setGuardNotice(
          key === "model_capability_guard" && !next
            ? "仅关闭新增能力预检；元数据展示、国际图片归并及其他安全限制不变，新请求生效。"
            : `${key === "model_guard" ? "表外模型拦截" : "模型能力预检"}已${next ? "开启" : "关闭"}。`,
        );
        resource.reload();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  const [filter, setFilter] = useState<CatalogFilter>(emptyFilter);
  const [sorting, setSorting] = useState<SortingState>([]);
  const filtering = Boolean(
    query || filter.region || filter.capability || filter.effort || filter.price,
  );
  // The table sorts; the page only decides which rows are eligible. Keeping the
  // filter here (not in a column filter model) is what makes "select all" mean
  // "these visible rows" for the bulk action below.
  //
  // Memoized on purpose: TanStack keys its core row model on the `data` identity, so
  // a fresh array per render rebuilds every row (and every row's DOM nodes) on each
  // keystroke, scroll tick and unrelated parent re-render.
  const rows = useMemo(
    () => resource.data?.models.filter((m) => matchesCatalog(m, query, filter)),
    [resource.data, query, filter],
  );

  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  // Seven-day health: one shared aggregate covers every row, while sparklines are
  // loaded only for the busiest rows of the current view (see insights.tsx).
  const modelHealth = useModelHealth();
  const sparkKeys = useMemo(
    () => sparklineKeys(rows, modelHealth.byModel),
    [rows, modelHealth.byModel],
  );
  const sparks = useModelSparklines(sparkKeys);
  const columns = useMemo(
    () =>
      modelColumns({
        totalAccounts,
        locks,
        health: modelHealth.byModel,
        sparks,
        onDetails: (model) => setDetailsId(model.id),
        onEdit: (model) => {
          setEditorRevision(resource.data?.revision ?? null);
          setEditing(model);
        },
        onDelete: (model) => {
          setDeleting(model);
          setError(null);
        },
        // Row-level edit/delete stay disabled while a batch runs (unchanged from
        // the pre-DataTable page); the list itself stays scrollable and readable,
        // which is the whole point of showing progress.
        actionsDisabled: bulkBusy,
      }),
    // `bulkBusy` is a dependency, not a late-bound read: the dependency array is
    // evaluated during render, so the value must already be initialised above.
    // `health` and `sparks` are maps rebuilt only when their payload changes, so the
    // column identities stay stable and TanStack does not rebuild every row.
    [totalAccounts, locks, resource.data?.revision, bulkBusy, modelHealth.byModel, sparks],
  );
  const { hidden, toggle: toggleColumn } = useColumnVisibility({
    storageKey: COLUMNS_KEY,
    columns,
    defaultHidden: DEFAULT_HIDDEN,
  });

  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const bulkTargets = (resource.data?.models ?? []).filter((m) => selected.has(m.id));
  const bulkRunnable = bulkTargets.filter((m) => !legacyScope(m));
  const bulkSkipped = bulkTargets.length - bulkRunnable.length;
  const openBulk = (action: BulkAction) => {
    setBulkAction(action);
    setBulkError(null);
    setBulkNotice(null);
    setBulkProgress(null);
  };
  const runBulk = async (action: BulkAction) => {
    if (!resource.data || bulkBusy) return;
    const enabled = action === "enable";
    const targets = bulkRunnable;
    const total = targets.length;
    if (!total) {
      setBulkError(t("models.bulk.nothingRunnable"));
      return;
    }
    setBulkBusy(true);
    setBulkError(null);
    setBulkNotice(null);
    setBulkProgress({ done: 0, total });
    // revision is a global CAS token: every write must chain the revision the previous
    // one returned, otherwise the second request is rejected with 409.
    let revision = resource.data.revision;
    let done = 0;
    let failure: string | null = null;
    for (const model of targets) {
      try {
        const response = await api.put(
          `/models/${encodeURIComponent(model.id)}`,
          bulkPayload(model, enabled, revision),
        );
        const result = object(response.data);
        const next = Number(result.revision);
        if (!Number.isInteger(next) || next <= revision)
          throw new Error(t("models.bulk.unconfirmed"));
        revision = next;
        done += 1;
        setSelected((old) => {
          const copy = new Set(old);
          copy.delete(model.id);
          return copy;
        });
        setBulkProgress({ done, total });
      } catch (err: unknown) {
        failure = statusOf(err) === 409 ? t("models.bulk.conflict") : errorMessage(err);
        break;
      }
    }
    setBulkBusy(false);
    if (done) resource.reload();
    if (failure) {
      setBulkError(done ? t("models.bulk.stopped", { done, total, message: failure }) : failure);
      return;
    }
    setBulkNotice(
      [
        t("models.bulk.done", {
          action: enabled ? t("models.bulk.action.enable") : t("models.bulk.action.disable"),
          count: done,
        }),
        bulkSkipped ? t("models.bulk.legacySkipped", { count: bulkSkipped }) : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    setBulkAction(null);
    setBulkProgress(null);
  };
  return (
    <>
      <PageTitle
        title="模型路由"
        description="独立映射模型名称，并明确每条路由的账号或区域边界。"
        actions={
          <>
            <button
              onClick={() => {
                resource.reload();
                credentials.reload();
              }}
            >
              <Icon name="refresh" />
              刷新目录
            </button>
            <button
              className={s.primary}
              disabled={!resource.data}
              onClick={() => {
                setEditorRevision(resource.data?.revision ?? null);
                setCreating(true);
              }}
            >
              <Icon name="plus" />
              新增模型
            </button>
          </>
        }
      />
      {resource.loading && !resource.data ? (
        <Skeleton variant="table" label={t("models.loading")} />
      ) : (
        <ResourceState {...resource} />
      )}
      <ErrorNotice message={error} />
      <ErrorNotice message={credentials.error} retry={credentials.reload} />
      {(guardNotice || bulkNotice) && (
        <p className={s.successNotice} role="status">
          {guardNotice ?? bulkNotice}
        </p>
      )}
      <Panel
        title="模型目录"
        hint={
          resource.data
            ? filtering && rows
              ? `命中 ${rows.length} / ${resource.data.models.length} 个模型`
              : `${resource.data.models.length} 个模型`
            : undefined
        }
      >
        <div className={s.toolbar}>
          <input
            aria-label="搜索模型"
            placeholder="搜索 ID、名称、描述、厂商，支持空格分隔多关键词…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className={s.filterBar}>
            <select
              aria-label="筛选区域"
              value={filter.region}
              onChange={(e) => setFilter({ ...filter, region: e.target.value })}
            >
              <option value="">全部区域</option>
              <option value="auto">自动选择</option>
              <option value="cn">中国大陆</option>
              <option value="intl">国际</option>
            </select>
            <select
              aria-label="筛选能力"
              value={filter.capability}
              onChange={(e) => setFilter({ ...filter, capability: e.target.value })}
            >
              <option value="">全部能力</option>
              <option value="images">支持视觉</option>
              <option value="tools">支持工具</option>
              <option value="reasoning">支持思考</option>
            </select>
            <select
              aria-label="筛选思考"
              value={filter.effort}
              onChange={(e) => setFilter({ ...filter, effort: e.target.value })}
            >
              <option value="">全部档位</option>
              <option value="off">可关闭思考</option>
              {EFFORT_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              aria-label="筛选价格"
              value={filter.price}
              onChange={(e) => setFilter({ ...filter, price: e.target.value })}
            >
              <option value="">全部价格</option>
              <option value="free">限时免费</option>
              <option value="paid">收费</option>
            </select>
            {(filtering || sorting.length > 0) && (
              <button
                onClick={() => {
                  setQuery("");
                  setFilter(emptyFilter);
                  setSorting([]);
                }}
              >
                重置
              </button>
            )}
            <ColumnMenu
              label={t("models.col.toggle")}
              columns={columns
                .filter((column) => column.optional)
                .map(({ id, header }) => ({ id, header }))}
              hidden={hidden}
              onToggle={toggleColumn}
            />
            <label className={s.enableSwitch}>
              <input
                type="checkbox"
                role="switch"
                aria-label="表外模型拦截"
                checked={resource.data?.model_guard !== false}
                disabled={busy || !resource.data || resource.data.model_guard_locked === true}
                onChange={(e) => toggleGuard("model_guard", e.target.checked)}
              />
              <span>表外拦截：{resource.data?.model_guard === false ? "关闭" : "开启"}</span>
            </label>
            <label className={s.enableSwitch}>
              <input
                type="checkbox"
                role="switch"
                aria-label="模型能力预检"
                checked={resource.data?.model_capability_guard !== false}
                disabled={
                  busy ||
                  !resource.data ||
                  resource.data.model_capability_guard === undefined ||
                  resource.data.model_capability_guard_locked === true
                }
                onChange={(e) => toggleGuard("model_capability_guard", e.target.checked)}
              />
              <span>
                能力预检：
                {resource.data?.model_capability_guard === undefined
                  ? "未知"
                  : resource.data.model_capability_guard
                    ? "开启"
                    : "关闭"}
              </span>
            </label>
          </div>
        </div>
        <p className={s.note}>{t("models.select.scope", { count: rows?.length ?? 0 })}</p>
        {/* Say where the sparklines stop: a row without one means "not loaded",
            not "no traffic", and the two must not be confused. */}
        {sparkKeys.length > 0 && (
          <p className={s.muted}>{t("models.health.partial", { count: SPARKLINE_LIMIT })}</p>
        )}
        <DataTable
          rows={rows ?? []}
          columns={columns}
          hidden={hidden}
          rowId={(m) => m.id}
          sorting={sorting}
          onSortingChange={setSorting}
          selection={{
            selected,
            onChange: setSelected,
            rowLabel: (m) => t("models.select.row", { name: m.public_id }),
            selectAllLabel: t("models.select.all"),
          }}
          loading={resource.loading}
          loadingLabel={t("models.loading")}
          scroll
          empty={
            <Empty title={query ? "没有匹配的模型" : "模型目录为空"}>
              可新增模型映射，或添加凭证以同步目录。
            </Empty>
          }
        />
      </Panel>
      {/* Portalled: the page shell's enter animation sets a transform, which would turn
          position:fixed into a containing block and pin this bar to the page, not the
          viewport — measured 99px of overflow at the bottom on a 390px viewport. */}
      {selected.size > 0 &&
        createPortal(
          <div className={s.bulkBar} role="region" aria-label={t("models.bulk.region")}>
            <span className={s.bulkCount}>{selected.size}</span>
            <span className={s.bulkDivider} aria-hidden="true" />
            <button disabled={bulkBusy} onClick={() => setSelected(new Set<string>())}>
              {t("models.bulk.clear")}
            </button>
            <span className={s.bulkDivider} aria-hidden="true" />
            <div className={s.bulkActions}>
              <button disabled={bulkBusy} onClick={() => openBulk("enable")}>
                {t("models.bulk.enable")}
              </button>
              <button className={s.danger} disabled={bulkBusy} onClick={() => openBulk("disable")}>
                {t("models.bulk.disable")}
              </button>
            </div>
          </div>,
          document.body,
        )}
      <DrawerPresence>
        {detailed && (
          <Drawer title={`模型详情 · ${detailed.public_id}`} onClose={() => setDetailsId(null)}>
            <ModelMetadata model={detailed} totalAccounts={totalAccounts} />
          </Drawer>
        )}
      </DrawerPresence>
      <DrawerPresence>
        {bulkAction && resource.data && (
          <Drawer
            title={t("models.bulk.title", {
              action: bulkAction === "enable" ? t("models.bulk.enable") : t("models.bulk.disable"),
            })}
            onClose={() => {
              if (bulkBusy) return;
              setBulkAction(null);
              setBulkProgress(null);
              setBulkError(null);
            }}
            dismissDisabled={bulkBusy}
          >
            <p className={s.note}>
              {bulkAction === "enable" ? t("models.bulk.enableDesc") : t("models.bulk.disableDesc")}{" "}
              {t("models.bulk.reason")}
            </p>
            <p className={s.note}>
              {t("models.bulk.affected", {
                action:
                  bulkAction === "enable"
                    ? t("models.bulk.action.enable")
                    : t("models.bulk.action.disable"),
                count: bulkRunnable.length,
              })}
            </p>
            <ul className={s.bulkList}>
              {bulkTargets.map((m) => (
                <li className={s.bulkListItem} key={m.id}>
                  <code>{m.public_id}</code>
                  {legacyScope(m) ? (
                    <Badge tone="warn">{t("models.bulk.legacy")}</Badge>
                  ) : m.credential_ids.length ? (
                    <Badge tone="neutral">
                      {t("models.bulk.accounts", { count: m.credential_ids.length })}
                    </Badge>
                  ) : m.available_credentials === 0 ? (
                    <Badge tone="warn">{t("models.bulk.noAccounts")}</Badge>
                  ) : (
                    <Badge tone="neutral">
                      {m.region ? profileLabel(m.region) : t("models.bulk.auto")}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            {bulkSkipped > 0 && (
              <p className={s.warning}>{t("models.bulk.legacySkipped", { count: bulkSkipped })}</p>
            )}
            {bulkProgress && (
              <div className={s.bulkProgress}>
                <span>
                  {t("models.bulk.progress", {
                    done: bulkProgress.done,
                    total: bulkProgress.total,
                  })}
                </span>
                <span className={s.bulkProgressBar} aria-hidden="true">
                  <span
                    style={{
                      width: `${bulkProgress.total ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%`,
                    }}
                  />
                </span>
              </div>
            )}
            <ErrorNotice message={bulkError} />
            {bulkError && <p className={s.note}>{t("models.bulk.retryHint")}</p>}
            <div className={s.actions}>
              <button
                disabled={bulkBusy}
                onClick={() => {
                  setBulkAction(null);
                  setBulkProgress(null);
                  setBulkError(null);
                }}
              >
                {t("models.bulk.cancel")}
              </button>
              <button
                className={bulkAction === "disable" ? s.danger : s.primary}
                disabled={bulkBusy || bulkRunnable.length === 0}
                onClick={() => void runBulk(bulkAction)}
              >
                {bulkBusy
                  ? t("models.bulk.running")
                  : t("models.bulk.confirm", {
                      action:
                        bulkAction === "enable"
                          ? t("models.bulk.action.enable")
                          : t("models.bulk.action.disable"),
                    })}
              </button>
            </div>
          </Drawer>
        )}
      </DrawerPresence>
      <DrawerPresence>
        {(editing || creating) && resource.data && (
          <ModelEditor
            model={editing ?? emptyRule}
            creating={creating}
            models={resource.data.models}
            credentials={credentials.data}
            revision={editorRevision ?? resource.data.revision}
            onClose={() => {
              setEditing(null);
              setCreating(false);
              setEditorRevision(null);
            }}
            onSaved={resource.reload}
          />
        )}
      </DrawerPresence>
      <DrawerPresence>
        {deleting && resource.data && (
          <Drawer title="删除自建模型" onClose={() => setDeleting(null)} dismissDisabled={busy}>
            <p className={s.warning}>
              删除 {deleting.public_id} 的本地路由。不会删除上游模型、账号或历史统计。
            </p>
            <ErrorNotice message={error} />
            <button
              className={s.danger}
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(null);
                void api
                  .delete(`/models/${encodeURIComponent(deleting.id)}`, {
                    data: { revision: resource.data!.revision },
                  })
                  .then((response) => {
                    if (object(response.data).ok !== true)
                      throw new Error("后端未确认删除，请刷新后核验");
                    setDeleting(null);
                    resource.reload();
                  })
                  .catch((err: unknown) => setError(errorMessage(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "正在删除…" : "确认删除模型"}
            </button>
          </Drawer>
        )}
      </DrawerPresence>
    </>
  );
}
