import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  catalogScanResponse,
  credentialResponse,
  errorMessage,
  list,
  modelResponse,
  normalizeModelLocks,
  number,
  object,
  statusOf,
  text,
  useResource,
  type CatalogScan,
  type Credential,
  type ModelLock,
  type ModelRule,
  type RecordValue,
} from "../api";
import { RefreshIcon } from "../components";
import { useFusionResource } from "../fusion/client";
import { t, useT, type MessageKey } from "../i18n";
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
import { JobBanner, ProgressBanner, type Job } from "../jobs";
import css from "../models.module.scss";
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
import {
  OutputProbeNote,
  type OutputProbe,
  RateOverrideFields,
  describeProbe,
  formatEstimate,
  measuredNote,
  rateDetails,
  rateSource,
  useOutputProbes,
  useRateProbeJob,
  type RateProbeControl,
  type RateSource,
} from "../modelRates";
import { popoverHost, usePopover } from "../popover";
import {
  Badge,
  Button,
  clearToasts,
  Cluster,
  Dialog,
  Drawer,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Field,
  Input,
  notify,
  Page,
  Panel,
  Select,
  Skeleton,
  Stack,
  Switch,
  Table,
  Toolbar,
  type BadgeTone,
  type TableColumn,
  type TableSort,
} from "../ui";
import { DataValue, profileLabel } from "../values";

export const profiles = ["cn-cli", "cn-work", "intl-cli", "intl-work"];
const mediaKindKeys: Record<string, MessageKey> = {
  image: "models.mediaKind.image",
  edit: "models.mediaKind.edit",
  video: "models.mediaKind.video",
};
const validId = (id: string) => /^[A-Za-z0-9_.:/@-]{1,160}$/.test(id) && ![".", ".."].includes(id);
export function validateRule(
  rule: ModelRule,
  models: ModelRule[],
  translate: (key: string) => string = (key) => key,
): string | null {
  if (!rule.public_id.trim()) return "对外 ID 不能为空";
  if (rule.public_id !== rule.public_id.trim() || /\s/.test(rule.public_id))
    return "对外 ID 不能包含空白字符";
  if (!validId(rule.public_id)) return "对外 ID 只允许 1–160 位字母、数字及 _ . : / @ -";
  if (!validId(rule.upstream_id ?? rule.id)) return "上游 ID 不能为空，且须为有效模型标识";
  if (rule.routes) {
    if (!rule.routes.length) return translate("models.routes.invalidEmpty");
    const routeIds = new Set<string>();
    let hasWeight = false;
    let hasPositive = false;
    for (const route of rule.routes) {
      if (!validId(route.upstream_id) || routeIds.has(route.upstream_id))
        return translate("models.routes.invalidId");
      routeIds.add(route.upstream_id);
      if (route.weight !== null) {
        hasWeight = true;
        if (!Number.isFinite(route.weight) || route.weight < 0 || route.weight > 1000)
          return translate("models.routes.invalidWeight");
        if (route.weight > 0) hasPositive = true;
      }
    }
    if (hasWeight && !hasPositive) return translate("models.routes.invalidPositive");
  }
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
/** What the route-boundary cell says on its one line. */
function boundaryScope(model: ModelRule): string {
  if (model.credential_ids.length) return `${model.credential_ids.length} 个指定账号`;
  return model.region ? profileLabel(model.region) : "自动选择";
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
      <Stack gap="2">
        {!preview.candidates.length && (
          <p className={css.note}>
            当前没有可用候选。保存不会授权范围外的账号，也不会绕过账号目录。
          </p>
        )}
        {[
          ...preview.candidates.map((row) => ({ row, allowed: true })),
          ...preview.excluded.map((row) => ({ row, allowed: false })),
        ].map(({ row, allowed }, i) => (
          <div className={css.candidate} key={i}>
            <div>
              <strong>{typeof row.name === "string" ? row.name : "未命名账号"}</strong>
              <small className={css.muted}>
                {typeof row.profile === "string" ? profileLabel(row.profile) : "产品未知"}
              </small>
            </div>
            <Badge tone={allowed ? "good" : "warn"}>
              {allowed ? "候选" : typeof row.reason === "string" ? row.reason : "不可用"}
            </Badge>
          </div>
        ))}
      </Stack>
    </Panel>
  );
}

/** How one rate reads: the two significant digits, and where the number came from. */
function rateLabel(value: number, kind: RateSource): string {
  return kind === "measured"
    ? `≈${formatEstimate(value)} · 实测计费`
    : kind === "manual"
      ? `${formatEstimate(value)} · 手填`
      : value === 0
        ? "限时免费 0x"
        : formatRate(value);
}
/** One model's rates per product, and the notes that explain where each came from. */
function rateEntries(model: ModelRule) {
  const details = rateDetails(model);
  const perProfile =
    model.credits_by_profile &&
    typeof model.credits_by_profile === "object" &&
    !Array.isArray(model.credits_by_profile)
      ? Object.entries(model.credits_by_profile)
      : [];
  const unpriced = Object.entries(details).find(
    ([, detail]) => rateSource(detail) === "measured" && detail.measured?.rate == null,
  );
  return { details, perProfile, unpriced };
}
function RateCell({ model }: { model: ModelRule }) {
  const rate = rateOf(model.credits);
  const { details, perProfile, unpriced } = rateEntries(model);
  // The headline rate comes from the cheapest product; its provenance decides the label.
  const headline = perProfile.find(([, price]) => rateOf(price) === rate)?.[0];
  const source = headline ? rateSource(details[headline]) : "declared";
  if (rate === null) {
    if (unpriced)
      return (
        <Badge tone="warn" title={measuredNote(unpriced[1])}>
          实测计费 · 倍率待估
        </Badge>
      );
    return (
      <span className={css.cellLine}>
        <DataValue value={model.credits} />
        <small className={css.muted}>产品倍率未知</small>
      </span>
    );
  }
  return (
    <Badge
      tone={source === "measured" ? "warn" : rate === 0 ? "good" : "neutral"}
      title={
        source === "measured" && headline
          ? measuredNote(details[headline])
          : source === "manual"
            ? "管理员手填倍率，路由与 /v1/models 以此为准"
            : undefined
      }
    >
      {rateLabel(rate, source)}
    </Badge>
  );
}
/**
 * The per-product table the rate cell cannot show on one line: each product's own rate, its
 * provenance and the measured-billing note. Table clips the cell and hands the overflow to
 * its tooltip, so the numbers stay reachable without the column owning the row's height.
 */
function rateTooltip(model: ModelRule): string | undefined {
  const rate = rateOf(model.credits);
  const { details, perProfile, unpriced } = rateEntries(model);
  const lines = perProfile.map(([profile, price]) => {
    const value = rateOf(price);
    const kind = rateSource(details[profile]);
    const note = kind === "measured" ? `（${measuredNote(details[profile])}）` : "";
    return `${profileLabel(profile)} ${value === null ? "倍率未知" : rateLabel(value, kind)}${note}`;
  });
  if (unpriced && !lines.some((line) => line.startsWith(profileLabel(unpriced[0]))))
    lines.push(`${profileLabel(unpriced[0])} 实测计费 · 倍率待估（${measuredNote(unpriced[1])}）`);
  if (!lines.length) return rate === null ? "产品倍率未知" : undefined;
  return lines.join(" · ");
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
  const tone: BadgeTone =
    disabled || available === undefined ? "neutral" : available > 0 ? "good" : "bad";
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
    <span className={css.cellLine}>
      <Badge tone={tone} title={title}>
        {label}
      </Badge>
      {worst && (
        <Badge tone={worst.kind === "model_block" ? "bad" : "warn"} title={lockTitle(locks)}>
          {lockLabel(worst)}
          {locks.length > 1 ? ` +${locks.length - 1}` : ""}
        </Badge>
      )}
    </span>
  );
}

/**
 * The catalog's columns. `id` doubles as the Table sort key, the column-visibility
 * storage key and the card-layout label, so it must stay stable across releases.
 *
 * Built per render rather than at module scope because the cells read live page
 * state (account total, diagnostic locks, the row actions' callbacks).
 */
type ModelColumn = TableColumn<ModelRule> & {
  /** Sort key. A column without one is not sorted by the header. */
  sortValue?: (model: ModelRule) => number | string | undefined;
  /** Windows and windows read largest-first. */
  sortDescFirst?: boolean;
  /** Offered by the column-visibility menu; identity and actions always stay. */
  optional?: boolean;
};
function modelColumns({
  totalAccounts,
  locks,
  health,
  sparks,
  onDetails,
  onEdit,
  onDelete,
  actionsDisabled,
  outputProbes,
}: {
  totalAccounts: number | null;
  locks: ModelLock[];
  health: Map<string, ModelHealth>;
  sparks: Map<string, SparklineEntry>;
  outputProbes: Record<string, OutputProbe>;
  onDetails: (model: ModelRule) => void;
  onEdit: (model: ModelRule) => void;
  onDelete: (model: ModelRule) => void;
  actionsDisabled: boolean;
}): ModelColumn[] {
  return [
    {
      id: "id",
      header: t("models.col.id"),
      sortable: true,
      sortValue: (m) => m.public_id,
      // The line carries identity and state. Everything else about the rule — the display
      // name, the route list, the original id a rename retains — is the tooltip's job: a
      // table row is read across, not stacked (Table clips a cell to one line).
      title: (m) =>
        [
          m.public_id,
          modelDisplayName(m),
          (m.routes?.length ?? 0) > 1
            ? `${t("models.routes.label")}：${m
                .routes!.map(
                  (route) =>
                    `${route.upstream_id}${route.weight !== null ? ` · ${route.weight}` : ""}${
                      route.enabled ? "" : `（${t("models.routes.remove")}）`
                    }`,
                )
                .join("、")}`
            : "",
          m.keep_original ? `同时保留 ${m.id}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      cell: (m) => (
        <span className={css.cellLine}>
          <strong className={css.modelName}>{m.public_id}</strong>
          <small className={css.mono}>{m.upstream_id ?? m.id}</small>
          {!m.enabled && <Badge tone="neutral">{t("models.avail.disabled")}</Badge>}
          {m.custom && <Badge>自建</Badge>}
          {m.media_kinds?.map((kind) => (
            <Badge key={kind} tone="neutral">
              {mediaKindKeys[kind] ? t(mediaKindKeys[kind]!) : kind}
            </Badge>
          ))}
          {m.embedding && <Badge tone="neutral">{t("models.embedding")}</Badge>}
          {m.rerank && <Badge tone="neutral">{t("models.rerank")}</Badge>}
        </span>
      ),
    },
    {
      id: "rate",
      header: t("models.col.rate"),
      cell: (m) => <RateCell model={m} />,
      title: rateTooltip,
      sortable: true,
      sortValue: rateValue,
      optional: true,
    },
    {
      id: "capability",
      header: t("models.col.capability"),
      cell: (m) => <CapabilityChips model={m} />,
      optional: true,
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
                <small className={css.muted}>{t("models.health.loading")}</small>
              ) : undefined
            }
          />
        );
      },
      optional: true,
    },
    {
      id: "context",
      header: t("models.col.context"),
      cell: (m) => <SpecValue model={m} kind="input" />,
      sortable: true,
      sortValue: (m) => widestWindow(m, "input"),
      sortDescFirst: true,
      optional: true,
    },
    {
      id: "output",
      header: t("models.col.output"),
      cell: (m) => (
        <>
          <SpecValue model={m} kind="output" />
          <OutputProbeNote
            probe={outputProbes[m.public_id] ?? outputProbes[m.upstream_id ?? m.id]}
          />
        </>
      ),
      sortable: true,
      sortValue: (m) => widestWindow(m, "output"),
      sortDescFirst: true,
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
      title: (m) =>
        [
          boundaryScope(m),
          m.profile
            ? profileLabel(m.profile)
            : m.credential_ids.length
              ? "严格绑定，不越界回退"
              : "按账号能力选择",
        ].join(" · "),
      cell: (m) => (
        <span className={css.cellLine}>
          {boundaryScope(m)}
          {bindingMode(m) === "legacy" && <Badge tone="warn">旧联合范围</Badge>}
        </span>
      ),
      optional: true,
    },
    {
      id: "actions",
      header: t("models.col.actions"),
      // The one column that must survive every offset and every viewport: Table pins it
      // to the right edge and the card layout keeps it as the row's last pair (P1-2).
      actions: true,
      cell: (m) => (
        <Cluster gap="1">
          <Button size="sm" onClick={() => onDetails(m)}>
            模型详情
          </Button>
          <Button size="sm" disabled={actionsDisabled} onClick={() => onEdit(m)}>
            编辑规则
          </Button>
          {m.custom && (
            <Button
              size="sm"
              variant="danger"
              disabled={actionsDisabled}
              onClick={() => onDelete(m)}
            >
              删除
            </Button>
          )}
        </Cluster>
      ),
    },
  ];
}

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
/**
 * Which region a rule serves, in the order the backend resolves it: an explicit region
 * wins, then the product's prefix, and only then the accounts' own declarations.
 *
 * The last step is the upstream fd78e7a fix: a model that declares no region and no
 * profile but is only declared by intl-work accounts *is* an international model, and
 * filtering by 国际 used to drop it because this function only looked at `region`.
 */
export function modelHasRegion(model: ModelRule, region: "cn" | "intl"): boolean {
  if (model.region) return model.region === region;
  if (model.profile) return model.profile.startsWith(`${region}-`);
  const declarations = model.metadata_by_profile;
  if (!declarations || typeof declarations !== "object" || Array.isArray(declarations))
    return false;
  return Object.keys(declarations).some((profile) => profile.startsWith(`${region}-`));
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
    } else if (!modelHasRegion(model, filter.region as "cn" | "intl")) return false;
  }
  if (filter.capability === "media_image") {
    if (!model.media_kinds?.some((kind) => kind === "image" || kind === "edit")) return false;
  } else if (filter.capability === "media_video") {
    if (!model.media_kinds?.includes("video")) return false;
  } else if (filter.capability) {
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
 * Column visibility, persisted per browser. The catalog's secondary columns start hidden
 * (eight of them already scrolled sideways at 1280px); Table renders the remaining ones
 * and switches to the card layout below 900px by itself, so a phone never needs a
 * horizontal scrollbar to reach a column.
 */
const COLUMNS_KEY = "codebuddy.models.columns";
const COLUMN_KEYS = [
  "rate",
  "capability",
  "availability",
  "health",
  "context",
  "output",
  "effort",
  "boundary",
] as const;
type ColumnKey = (typeof COLUMN_KEYS)[number];
const DEFAULT_HIDDEN: ColumnKey[] = ["context", "output", "effort"];
function readHiddenColumns(): ColumnKey[] | null {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((value): value is ColumnKey => COLUMN_KEYS.includes(value as ColumnKey));
  } catch {
    return null;
  }
}
function useColumnVisibility(): { hidden: ColumnKey[]; toggle: (id: ColumnKey) => void } {
  const [hidden, setHidden] = useState<ColumnKey[]>(
    () => readHiddenColumns() ?? [...DEFAULT_HIDDEN],
  );
  const toggle = (id: ColumnKey) =>
    setHidden((old) => {
      const next = old.includes(id) ? old.filter((key) => key !== id) : [...old, id];
      try {
        localStorage.setItem(COLUMNS_KEY, JSON.stringify(next));
      } catch {
        // 隐私模式或存储配额不足时只在本次会话内生效。
      }
      return next;
    });
  return { hidden, toggle };
}

/**
 * The column picker. A button plus a popover that popover.ts places and clamps to the
 * viewport (a plain absolute menu opened downward off-screen — P3-2), and that closes on
 * Escape or an outside press, handing focus back to the button that opened it.
 */
function ColumnMenu({
  label,
  columns,
  hidden,
  onToggle,
}: {
  label: string;
  columns: { id: ColumnKey; header: string }[];
  hidden: ColumnKey[];
  onToggle: (id: ColumnKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    anchor.current?.querySelector("button")?.focus();
  }, []);
  const placement = usePopover(open, close, anchor, menu, "end");
  if (!columns.length) return null;
  return (
    <div className={css.menuAnchor} ref={anchor}>
      <Button
        size="sm"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </Button>
      {open &&
        createPortal(
          <div
            ref={menu}
            role="group"
            aria-label={label}
            className={css.menu}
            style={
              placement
                ? { top: placement.top, left: placement.left, minWidth: placement.minWidth }
                : { visibility: "hidden" }
            }
          >
            {columns.map((column) => (
              <label className={css.menuItem} key={column.id}>
                <input
                  type="checkbox"
                  checked={!hidden.includes(column.id)}
                  onChange={() => onToggle(column.id)}
                />
                {column.header}
              </label>
            ))}
          </div>,
          popoverHost(anchor.current),
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
  rateProbe,
  creating = false,
}: {
  model: ModelRule;
  models: ModelRule[];
  credentials: Credential[] | null;
  revision: number;
  onClose: () => void;
  onSaved: () => void;
  rateProbe?: RateProbeControl;
  creating?: boolean;
}) {
  const t = useT();
  const [rule, setRule] = useState({
    ...model,
    upstream_id: model.upstream_id ?? model.id,
    routes: model.routes?.map((route) => ({ ...route })),
    region:
      model.region ||
      (!model.credential_ids.length && profiles.includes(model.profile)
        ? model.profile.split("-")[0]
        : ""),
  });
  const [mode, setMode] = useState<Mode>(() => bindingMode(model));
  const [routesTouched, setRoutesTouched] = useState(
    () => model.routes?.some((route) => route.source === "manual") ?? false,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const request = useRef<AbortController | null>(null);
  const suggestions = useId();
  useEffect(() => () => request.current?.abort(), []);
  const update = <K extends keyof ModelRule>(key: K, value: ModelRule[K]) => {
    setRule((old) => ({ ...old, [key]: value }));
    if (key === "routes") setRoutesTouched(true);
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
      validateRule(rule, models, t) ??
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
      ...(routesTouched && rule.routes?.length ? { routes: rule.routes } : {}),
      enabled: rule.enabled,
      keep_original: rule.keep_original,
      region: rule.region || null,
      profile: rule.profile || null,
      credential_ids: rule.credential_ids,
      credits_override: rule.credits_override ?? {},
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
  const routes = rule.routes ?? [];
  const patchRoute = (index: number, patch: RecordValue) =>
    update(
      "routes",
      routes.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  return (
    <Drawer
      title={creating ? "新增模型" : "编辑模型规则"}
      closeLabel={t("common.closeDrawer")}
      onClose={onClose}
      dismissDisabled={busy}
    >
      <p className={css.note}>
        对外 ID 供客户端使用，上游 ID
        是发送给官方后端的模型名称。两者独立，账号能力与额度校验仍然生效。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(true);
        }}
      >
        <fieldset className={css.formStack} disabled={busy}>
          <div className={css.formGrid}>
            <Field label="对外 ID">
              <Input
                value={rule.public_id}
                required
                maxLength={160}
                placeholder="例如 my-coding-model"
                onChange={(e) => update("public_id", e.target.value)}
              />
            </Field>
            <Field label="上游 ID">
              <Input
                value={rule.upstream_id}
                required
                maxLength={160}
                list={suggestions}
                placeholder="实际调用的模型 ID"
                onChange={(e) => update("upstream_id", e.target.value)}
              />
            </Field>
          </div>
          <datalist id={suggestions}>
            {[...new Set(models.map((model) => model.upstream_id ?? model.id))].map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <fieldset className={css.formGroup}>
            <legend>{t("models.routes.title")}</legend>
            <p className={css.note}>{t("models.routes.help")}</p>
            {routes.length > 0 && (
              <Stack gap="2">
                {routes.map((route, index) => (
                  <div className={css.routeRow} key={`${route.upstream_id}-${index}`}>
                    <Input
                      value={route.upstream_id}
                      list={suggestions}
                      aria-label={`路由 ${index + 1} 的上游模型 ID`}
                      placeholder="上游模型 ID"
                      onChange={(e) => patchRoute(index, { upstream_id: e.target.value })}
                    />
                    <Input
                      type="number"
                      min={0}
                      max={1000}
                      step="any"
                      value={route.weight ?? ""}
                      aria-label={`路由 ${index + 1} 权重`}
                      placeholder={t("models.routes.weight")}
                      onChange={(e) =>
                        patchRoute(index, {
                          weight: e.target.value === "" ? null : Number(e.target.value),
                        })
                      }
                    />
                    <label className={css.check}>
                      <input
                        type="checkbox"
                        checked={route.enabled}
                        onChange={(e) => patchRoute(index, { enabled: e.target.checked })}
                      />
                      {t("models.routes.enabled")}
                    </label>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        update(
                          "routes",
                          routes.filter((_, i) => i !== index),
                        )
                      }
                    >
                      {t("models.routes.remove")}
                    </Button>
                  </div>
                ))}
              </Stack>
            )}
            <Cluster gap="2">
              <Button
                size="sm"
                onClick={() =>
                  update("routes", [
                    ...routes,
                    {
                      upstream_id: rule.upstream_id,
                      weight: null,
                      enabled: true,
                      source: "manual",
                    },
                  ])
                }
              >
                {t("models.routes.add")}
              </Button>
            </Cluster>
          </fieldset>
          <Cluster gap="3">
            <label className={css.switchLine}>
              <Switch
                label="启用模型"
                checked={rule.enabled}
                onChange={(value) => update("enabled", value)}
              />
              <span>启用模型</span>
            </label>
            {!creating && !model.custom && (
              <label className={css.switchLine}>
                <Switch
                  label="同时保留原模型 ID"
                  checked={rule.keep_original}
                  onChange={(value) => update("keep_original", value)}
                />
                <span>同时保留原模型 ID</span>
              </label>
            )}
          </Cluster>
          <fieldset className={css.formGroup}>
            <legend>选择路由方式</legend>
            <div className={css.modeGroup}>
              {(
                [
                  ["auto", "自动选择", "按现有账号能力选路"],
                  ["accounts", "指定账号", "只使用选中的账号"],
                  ["region", "指定区域", "仅从该区域中选择"],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  className={`${css.modeOption} ${mode === value ? css.modeSelected : ""}`}
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
            <p className={css.note}>
              账号与区域二选一，切换方式会清除另一种绑定；不可用时不越界回退。
            </p>
          </fieldset>
          {mode === "legacy" && (
            <p className={css.warning}>
              旧规则同时设置了账号和区域。当前仍按原交集执行，请明确选择一种路由方式后再保存。
            </p>
          )}
          {mode === "region" && (
            <div className={css.formGrid}>
              <Field label="区域">
                <Select
                  label="区域"
                  value={rule.region || (rule.profile.startsWith("intl-") ? "intl" : "cn")}
                  onChange={(value) => {
                    const region = value;
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
                </Select>
              </Field>
              <Field label="产品">
                <Select
                  label="产品"
                  value={rule.profile}
                  onChange={(value) => update("profile", value)}
                >
                  <option value="">不限产品</option>
                  {profiles
                    .filter((profile) => !rule.region || profile.startsWith(`${rule.region}-`))
                    .map((profile) => (
                      <option key={profile} value={profile}>
                        {profileLabel(profile)}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
          )}
          {mode === "accounts" && (
            <fieldset className={css.formGroup}>
              <legend>指定凭证</legend>
              {credentials === null ? (
                <p className={css.note}>凭证列表未加载，现有绑定保持不变。</p>
              ) : !credentials.length ? (
                <p className={css.note}>暂无账号，请先在凭证管理添加。</p>
              ) : (
                credentials.map((credential) => (
                  <label className={css.choice} key={credential.id}>
                    <input
                      type="checkbox"
                      checked={rule.credential_ids.includes(credential.id)}
                      onChange={(e) =>
                        update(
                          "credential_ids",
                          e.target.checked
                            ? [...rule.credential_ids, credential.id]
                            : rule.credential_ids.filter((id) => id !== credential.id),
                        )
                      }
                    />
                    <span>
                      <strong>{credential.name ?? credential.id}</strong>
                      <small>
                        {typeof credential.profile === "string"
                          ? profileLabel(credential.profile)
                          : "产品未知"}
                      </small>
                    </span>
                    {credential.enabled === false && <Badge tone="warn">已停用</Badge>}
                  </label>
                ))
              )}
              {rule.credential_ids
                .filter((id) => !credentials?.some((credential) => credential.id === id))
                .map((id) => (
                  <label className={css.check} key={id}>
                    <input
                      type="checkbox"
                      checked
                      onChange={() =>
                        update(
                          "credential_ids",
                          rule.credential_ids.filter((value) => value !== id),
                        )
                      }
                    />
                    {id} · 未在当前列表中
                  </label>
                ))}
            </fieldset>
          )}
          {!creating && !model.custom && (
            <RateOverrideFields
              model={model}
              value={rule.credits_override ?? {}}
              onChange={(next) => update("credits_override", next)}
              probe={rateProbe}
              disabled={busy}
            />
          )}
          <ErrorNotice message={error} />
          <Cluster gap="2">
            <Button disabled={busy} onClick={() => run(false)}>
              预览候选路由
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "处理中…" : creating ? "创建模型" : "保存规则"}
            </Button>
          </Cluster>
        </fieldset>
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
 * The catalog's order: reported values first, unknown last in both directions. Table owns
 * the header's aria-sort; the page owns the order, because "not reported" is a page rule.
 */
function sortedRows(rows: ModelRule[], columns: ModelColumn[], sort: TableSort): ModelRule[] {
  const column = sort ? columns.find((candidate) => candidate.id === sort.id) : undefined;
  const value = column?.sortValue;
  if (!sort || !value) return rows;
  const direction = sort.desc ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    if (a === undefined) return b === undefined ? 0 : 1;
    if (b === undefined) return -1;
    if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
    return String(a).localeCompare(String(b)) * direction;
  });
}

function rateProbeTitle(job: Job) {
  return job.meta.scope === "all" ? "一键检测倍率" : `倍率探测 · ${text(job.meta.scope)}`;
}
function notifyRateProbe(job: Job) {
  notify({
    key: "rate-probe",
    tone: (number(job.meta.failed) ?? 0) > 0 ? "warn" : "good",
    title: `${rateProbeTitle(job)}已完成`,
    body: (
      <span>
        {job.total
          ? `实测计费 ${text(job.meta.billed)} · 确认免费 ${text(job.meta.free)} · 失败 ${text(job.meta.failed)}`
          : "没有目录声明 0x 的模型"}
      </span>
    ),
  });
}
const scanSummary = (scan: CatalogScan) =>
  `成功 ${scan.success} · 失败 ${scan.failed} · 目录差异 ${scan.differences}`;
function notifyScan(scan: CatalogScan) {
  const versions = Object.entries(scan.profiles)
    .filter(([, row]) => row.distinct > 1)
    .map(([name, row]) => `${name}：${row.distinct} 组目录版本`)
    .join("；");
  const failed = scan.status === "failed";
  notify({
    key: "scan",
    tone: failed ? "bad" : scan.failed > 0 ? "warn" : "good",
    title: failed ? "全量扫描失败" : "全量扫描已完成",
    body: (
      <>
        <span>{scanSummary(scan)}</span>
        {failed && scan.error && <span>{scan.error}</span>}
        {versions && <span>{versions}</span>}
        {(failed || scan.failed > 0) && <span>失败账号保留上次成功的目录。</span>}
      </>
    ),
  });
}
export function Models() {
  const resource = useResource("/models", modelResponse, { cache: true });
  const credentials = useResource("/credentials", credentialResponse, { cache: true });
  // Advisory only: without the diagnostic endpoint the table still shows the account
  // counts the model catalog itself reports.
  const diagnostic = useFusionResource("/admin/diagnostic", null, normalizeModelLocks);
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
  const [scan, setScan] = useState<CatalogScan | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const outputProbes = useOutputProbes();
  const rateJob = useRateProbeJob((job) => {
    resource.reload();
    notifyRateProbe(job);
  });
  // Only a scan this page watched finish raises a toast; a reload does not repeat an old one.
  const scanRunning = useRef(false);
  const loadScan = useCallback(() => {
    void api
      .get("/models/scan")
      .then((response) => {
        const next = catalogScanResponse(response.data);
        setScan(next);
        // A scan that just finished may have refreshed the catalog list.
        if (next.status === "completed" || next.status === "failed") resource.reload();
        if (next.status !== "running" && scanRunning.current) notifyScan(next);
        scanRunning.current = next.status === "running";
      })
      .catch(() => {
        // 被动状态轮询失败不升级为页面错误；提交扫描的失败才提示。
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    loadScan(); // An in-progress scan survives page reloads.
  }, [loadScan]);
  useEffect(() => {
    if (scan?.status !== "running") return;
    const timer = setInterval(loadScan, 2000);
    return () => clearInterval(timer);
  }, [scan?.status, loadScan]);
  const startScan = () => {
    if (scanBusy) return;
    setScanBusy(true);
    setError(null);
    void api
      .post("/models/scan")
      .then((response) => {
        const next = catalogScanResponse(response.data);
        scanRunning.current = next.status === "running";
        setScan(next);
        resource.reload();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setScanBusy(false));
  };
  const toggleGuard = (key: "model_guard" | "model_capability_guard", next: boolean) => {
    if (!resource.data || busy) return;
    setBusy(true);
    setError(null);
    void api
      .patch("/settings", {
        revision: resource.data.revision,
        values: { [key]: next },
      })
      .then(() => {
        notify({
          key: "guard",
          tone: "good",
          title: `${key === "model_guard" ? "表外模型拦截" : "模型能力预检"}已${next ? "开启" : "关闭"}`,
          body:
            key === "model_capability_guard" && !next ? (
              <span>
                仅关闭新增能力预检；元数据展示、国际图片归并及其他安全限制不变，新请求生效。
              </span>
            ) : undefined,
        });
        resource.reload();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  const [filter, setFilter] = useState<CatalogFilter>(emptyFilter);
  const [sort, setSort] = useState<TableSort>(null);
  const filtering = Boolean(
    query || filter.region || filter.capability || filter.effort || filter.price,
  );
  // The table sorts and the page decides which rows are eligible. Keeping the filter here
  // (not in a column filter model) is what makes "select all" mean "these visible rows"
  // for the bulk action below.
  const rows = useMemo(
    () => resource.data?.models.filter((model) => matchesCatalog(model, query, filter)),
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
        outputProbes,
        onDetails: (model) => setDetailsId(model.id),
        onEdit: (model) => {
          setEditorRevision(resource.data?.revision ?? null);
          setEditing(model);
        },
        onDelete: (model) => {
          setDeleting(model);
          setError(null);
        },
        // Row-level edit/delete stay disabled while a batch runs; the list itself stays
        // scrollable and readable, which is the whole point of showing progress.
        actionsDisabled: bulkBusy,
      }),
    [
      totalAccounts,
      locks,
      resource.data?.revision,
      bulkBusy,
      modelHealth.byModel,
      sparks,
      outputProbes,
    ],
  );
  const { hidden, toggle: toggleColumn } = useColumnVisibility();
  const visibleColumns = columns.filter((column) => !hidden.includes(column.id as ColumnKey));
  const ordered = useMemo(() => sortedRows(rows ?? [], columns, sort), [rows, columns, sort]);
  const toggleSort = (columnId: string) => {
    const column = columns.find((candidate) => candidate.id === columnId);
    setSort((old) => {
      if (old?.id !== columnId) return { id: columnId, desc: column?.sortDescFirst === true };
      return old.desc ? null : { id: columnId, desc: true };
    });
  };
  const resetView = () => {
    setQuery("");
    setFilter(emptyFilter);
    setSort(null);
  };

  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const bulkTargets = (resource.data?.models ?? []).filter((model) => selected.has(model.id));
  const bulkRunnable = bulkTargets.filter((model) => !legacyScope(model));
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
  const catalog = rows ?? [];
  return (
    <Page
      title="模型路由"
      description="独立映射模型名称，并明确每条路由的账号或区域边界。"
      actions={
        <>
          <Button
            icon={<RefreshIcon spinning={resource.refreshing || credentials.refreshing} />}
            onClick={() => {
              clearToasts();
              resource.reload();
              credentials.reload();
            }}
          >
            刷新目录
          </Button>
          <Button
            icon={<RefreshIcon spinning={rateJob.job?.status === "running"} />}
            disabled={rateJob.job?.status === "running"}
            onClick={() => rateJob.start()}
            title="后台任务：对目录声明 0x 的模型逐产品发起一次 ≈8K token 对话；有扣费即为实测计费，未扣费才是真 0 倍率"
          >
            {rateJob.job?.status === "running"
              ? `检测中 ${rateJob.job.completed}/${rateJob.job.total}`
              : "一键检测倍率"}
          </Button>
          <Button
            icon={<RefreshIcon spinning={scanBusy || scan?.status === "running"} />}
            disabled={scanBusy || scan?.status === "running"}
            onClick={startScan}
            title="逐个账号刷新目录，仅由你手动触发；单账号失败时保留其旧目录"
          >
            {scan?.status === "running"
              ? `扫描中 ${scan.completed}/${scan.total}`
              : "扫描全部账号模型"}
          </Button>
          <Button
            variant="primary"
            icon="plus"
            disabled={!resource.data}
            onClick={() => {
              setEditorRevision(resource.data?.revision ?? null);
              setCreating(true);
            }}
          >
            新增模型
          </Button>
        </>
      }
    >
      {resource.loading && !resource.data ? (
        <Skeleton
          variant="table"
          label={t("models.loading")}
          cells={["text", "badge", "badge", "twoLine"]}
        />
      ) : null}
      <ErrorNotice
        message={resource.error}
        retry={{ label: t("common.retry"), onClick: resource.reload }}
      />
      <ErrorNotice message={rateJob.error} />
      {rateJob.job?.status === "running" && (
        <JobBanner title={rateProbeTitle(rateJob.job)} job={rateJob.job} describe={describeProbe} />
      )}
      <ErrorNotice
        message={credentials.error}
        retry={{ label: t("common.retry"), onClick: credentials.reload }}
      />
      {/* Bulk runs report through a banner (they can end half-done); the guard
          switches report through the toast they already raise. */}
      {bulkNotice && (
        <p className={css.successNotice} role="status">
          {bulkNotice}
        </p>
      )}
      {scan?.status === "running" && (
        <ProgressBanner title="扫描全部账号模型" completed={scan.completed} total={scan.total}>
          <small>{scanSummary(scan)}</small>
        </ProgressBanner>
      )}
      <Panel
        title="模型目录"
        hint={
          resource.data
            ? filtering
              ? `命中 ${catalog.length} / ${resource.data.models.length} 个模型`
              : `${resource.data.models.length} 个模型`
            : undefined
        }
      >
        <Toolbar gap="2">
          <Input
            className={css.search}
            aria-label="搜索模型"
            placeholder="搜索 ID、名称、描述、厂商，支持空格分隔多关键词…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className={css.filterField}>
            <Select
              label="筛选区域"
              value={filter.region}
              onChange={(value) => setFilter({ ...filter, region: value })}
            >
              <option value="">全部区域</option>
              <option value="auto">自动选择</option>
              <option value="cn">中国大陆</option>
              <option value="intl">国际</option>
            </Select>
          </div>
          <div className={css.filterField}>
            <Select
              label="筛选能力"
              value={filter.capability}
              onChange={(value) => setFilter({ ...filter, capability: value })}
            >
              <option value="">全部能力</option>
              <option value="media_image">图片生成 / 编辑</option>
              <option value="media_video">视频生成</option>
              <option value="images">支持视觉</option>
              <option value="tools">支持工具</option>
              <option value="reasoning">支持思考</option>
            </Select>
          </div>
          <div className={css.filterField}>
            <Select
              label="筛选思考"
              value={filter.effort}
              onChange={(value) => setFilter({ ...filter, effort: value })}
            >
              <option value="">全部档位</option>
              <option value="off">可关闭思考</option>
              {EFFORT_FILTERS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
          <div className={css.filterField}>
            <Select
              label="筛选价格"
              value={filter.price}
              onChange={(value) => setFilter({ ...filter, price: value })}
            >
              <option value="">全部价格</option>
              <option value="free">限时免费</option>
              <option value="paid">收费</option>
            </Select>
          </div>
          {(filtering || sort) && (
            <Button size="sm" onClick={resetView}>
              重置
            </Button>
          )}
          <ColumnMenu
            label={t("models.col.toggle")}
            columns={columns
              .filter(
                (column): column is ModelColumn & { id: ColumnKey } =>
                  column.optional === true && COLUMN_KEYS.includes(column.id as ColumnKey),
              )
              .map(({ id, header }) => ({ id: id as ColumnKey, header }))}
            hidden={hidden}
            onToggle={toggleColumn}
          />
        </Toolbar>
        <Toolbar gap="3">
          <label className={css.switchLine}>
            <Switch
              label="表外模型拦截"
              checked={resource.data?.model_guard !== false}
              disabled={busy || !resource.data || resource.data.model_guard_locked === true}
              onChange={(next) => toggleGuard("model_guard", next)}
            />
            <span>表外拦截：{resource.data?.model_guard === false ? "关闭" : "开启"}</span>
          </label>
          <label className={css.switchLine}>
            <Switch
              label="模型能力预检"
              checked={resource.data?.model_capability_guard !== false}
              disabled={
                busy ||
                !resource.data ||
                resource.data.model_capability_guard === undefined ||
                resource.data.model_capability_guard_locked === true
              }
              onChange={(next) => toggleGuard("model_capability_guard", next)}
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
        </Toolbar>
        <p className={css.note}>{t("models.select.scope", { count: catalog.length })}</p>
        {/* Say where the sparklines stop: a row without one means "not loaded",
            not "no traffic", and the two must not be confused. */}
        {sparkKeys.length > 0 && (
          <p className={css.note}>{t("models.health.partial", { count: SPARKLINE_LIMIT })}</p>
        )}
        {catalog.length ? (
          <Table
            className={css.catalog}
            label="模型目录"
            columns={visibleColumns}
            rows={ordered}
            rowKey={(model) => model.id}
            sort={sort}
            onSort={toggleSort}
            sortName={(label, direction) =>
              direction === "ascending"
                ? `${label}（升序）`
                : direction === "descending"
                  ? `${label}（降序）`
                  : label
            }
            selection={{
              selected,
              onChange: setSelected,
              rowLabel: (model) => t("models.select.row", { name: model.public_id }),
              selectAllLabel: t("models.select.all"),
            }}
          />
        ) : resource.error || !resource.data ? null : (
          <Empty
            title={query ? "没有匹配的模型" : "模型目录为空"}
            tone={filtering ? "filtered" : "initial"}
            action={
              filtering ? (
                <Button onClick={resetView}>{t("common.clearFilters")}</Button>
              ) : undefined
            }
          >
            可新增模型映射，或添加凭证以同步目录。
          </Empty>
        )}
      </Panel>
      {/* Portalled: the page shell's enter animation sets a transform, which would turn
          position:fixed into a containing block and pin this bar to the page, not the
          viewport — measured 99px of overflow at the bottom on a 390px viewport. */}
      {selected.size > 0 &&
        createPortal(
          <div className={css.bulkBar} role="region" aria-label={t("models.bulk.region")}>
            <span className={css.bulkCount}>{selected.size}</span>
            <span className={css.bulkDivider} aria-hidden="true" />
            <Button size="sm" disabled={bulkBusy} onClick={() => setSelected(new Set<string>())}>
              {t("models.bulk.clear")}
            </Button>
            <span className={css.bulkDivider} aria-hidden="true" />
            <Cluster gap="2">
              <Button size="sm" disabled={bulkBusy} onClick={() => openBulk("enable")}>
                {t("models.bulk.enable")}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={bulkBusy}
                onClick={() => openBulk("disable")}
              >
                {t("models.bulk.disable")}
              </Button>
            </Cluster>
          </div>,
          document.body,
        )}
      <DrawerPresence>
        {detailed && (
          <Drawer
            title={`模型详情 · ${detailed.public_id}`}
            closeLabel={t("common.closeDrawer")}
            onClose={() => setDetailsId(null)}
          >
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
            closeLabel={t("common.closeDrawer")}
            onClose={() => {
              if (bulkBusy) return;
              setBulkAction(null);
              setBulkProgress(null);
              setBulkError(null);
            }}
            dismissDisabled={bulkBusy}
          >
            <p className={css.note}>
              {bulkAction === "enable" ? t("models.bulk.enableDesc") : t("models.bulk.disableDesc")}{" "}
              {t("models.bulk.reason")}
            </p>
            <p className={css.note}>
              {t("models.bulk.affected", {
                action:
                  bulkAction === "enable"
                    ? t("models.bulk.action.enable")
                    : t("models.bulk.action.disable"),
                count: bulkRunnable.length,
              })}
            </p>
            <ul className={css.bulkList}>
              {bulkTargets.map((model) => (
                <li className={css.bulkListItem} key={model.id}>
                  <code>{model.public_id}</code>
                  {legacyScope(model) ? (
                    <Badge tone="warn">{t("models.bulk.legacy")}</Badge>
                  ) : model.credential_ids.length ? (
                    <Badge tone="neutral">
                      {t("models.bulk.accounts", { count: model.credential_ids.length })}
                    </Badge>
                  ) : model.available_credentials === 0 ? (
                    <Badge tone="warn">{t("models.bulk.noAccounts")}</Badge>
                  ) : (
                    <Badge tone="neutral">
                      {model.region ? profileLabel(model.region) : t("models.bulk.auto")}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            {bulkSkipped > 0 && (
              <p className={css.warning}>
                {t("models.bulk.legacySkipped", { count: bulkSkipped })}
              </p>
            )}
            {bulkProgress && (
              <div className={css.bulkProgress}>
                <span>
                  {t("models.bulk.progress", {
                    done: bulkProgress.done,
                    total: bulkProgress.total,
                  })}
                </span>
                <span className={css.bulkProgressBar} aria-hidden="true">
                  <span
                    style={{
                      width: `${bulkProgress.total ? (bulkProgress.done / bulkProgress.total) * 100 : 0}%`,
                    }}
                  />
                </span>
              </div>
            )}
            <ErrorNotice message={bulkError} />
            {bulkError && <p className={css.note}>{t("models.bulk.retryHint")}</p>}
            <Cluster gap="2">
              <Button
                disabled={bulkBusy}
                onClick={() => {
                  setBulkAction(null);
                  setBulkProgress(null);
                  setBulkError(null);
                }}
              >
                {t("models.bulk.cancel")}
              </Button>
              <Button
                variant={bulkAction === "disable" ? "danger" : "primary"}
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
              </Button>
            </Cluster>
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
            rateProbe={rateJob}
          />
        )}
      </DrawerPresence>
      <DrawerPresence>
        {deleting && resource.data && (
          <Dialog
            title="删除自建模型"
            closeLabel={t("common.closeDrawer")}
            onClose={() => setDeleting(null)}
            dismissDisabled={busy}
            footer={
              <>
                <Button disabled={busy} onClick={() => setDeleting(null)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="danger"
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
                </Button>
              </>
            }
          >
            <p className={css.warning}>
              删除 {deleting.public_id} 的本地路由。不会删除上游模型、账号或历史统计。
            </p>
            <ErrorNotice message={error} />
          </Dialog>
        )}
      </DrawerPresence>
    </Page>
  );
}
