import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { OAuth } from "../OAuth";
import { countdownText, useCoarseNow, useNow, useOptimisticOverrides } from "../hooks";
import { fusionMutate } from "../fusion/client";
import { Trial } from "../Trial";
import { TravelSummary } from "../Travel";
import { Buddy, buddyConfirmation } from "../Buddy";
import { GrowthTasks, describeGrowth, useGrowthJobs } from "../GrowthTasks";
import { JobBanner, ProgressBanner } from "../jobs";
import { BalanceExpiry, CreditsPanel } from "../CreditsPanel";
import { dateLabel, tokenExpiry } from "../credits";
import {
  api,
  compact,
  credentialResponse,
  errorMessage,
  list,
  metric,
  number,
  object,
  text,
  useResource,
  type Credential,
} from "../api";
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
  IconButton,
  Input,
  Page,
  Panel,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Table,
  Textarea,
  ToastRegion,
  Toolbar,
  clearToasts,
  nextSort,
  notify,
  sortRows,
  type SortValue,
  type TableColumn,
  type TableSort,
} from "../ui";
import {
  MAX_REFRESH_TOKENS,
  REFRESH_PROFILES,
  parseRefreshTokens,
  prepareImports,
  type ImportResult,
  type RefreshProfile,
} from "../imports";
import { downloadFilename } from "../downloads";
import { useDateFormat, useT } from "../i18n";
import { Fields, profileLabel } from "../values";
import { popoverHost, usePopover } from "../popover";
import s from "./Credentials.module.scss";

// Locale-aware timestamps: a hard-coded toLocaleString("zh-CN") kept rendering
// a Chinese date order inside the English UI. The formatter comes from
// useDateFormat() so the output follows the active UI language.
function expiry(value: unknown, format: (date: Date) => string, milliseconds = false) {
  return typeof value === "number"
    ? format(new Date(milliseconds ? value : value * 1000))
    : text(value);
}

const lastErrorLabels: Record<string, string> = {
  http_401: "上游 401（登录态被拒）",
  http_403: "上游 403（无权限）",
  restricted: "官方限制（11140）",
  credential_error: "凭证同步失败（详见操作结果）",
};

const healthLabels: Record<string, string> = {
  ready: "就绪",
  disabled: "人工停用",
  auto_disabled: "自动禁用",
  restricted: "被官方限制",
  circuit_open: "认证熔断",
  expired: "已过期",
  error: "错误",
};

function lastErrorLabel(value: unknown) {
  const key = text(value);
  return lastErrorLabels[key] ?? key;
}

function prettyErrorJson(value: unknown) {
  const raw = text(value);
  if (raw === "") return "";
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/**
 * A portaled popover's inline geometry.
 *
 * popover.ts flips the box above its trigger near the bottom edge, but a flipped box can
 * still be taller than the space that is left (P3-2: a 231px menu opened at y=1166 in an
 * 844px viewport). Publishing the resolved top as a custom property lets the module cap
 * the height to the remaining space and scroll inside, so the box can never leave the
 * viewport in either direction.
 */
const cappedTop = (top: number) => ({ top, "--popover-top": String(top) + "px" }) as CSSProperties;

/** Last upstream error; hover (desktop) or tap (mobile) opens the recorded JSON. Click pins it open. */
function LastErrorJson({ code, at, body }: { code: unknown; at: unknown; body: unknown }) {
  const format = useDateFormat();
  const json = prettyErrorJson(body);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<number | null>(null);
  const trigger = useRef<HTMLSpanElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const open = pinned || hovered;
  const close = useCallback(() => {
    setPinned(false);
    setHovered(false);
  }, []);
  const placement = usePopover(open, close, trigger, tip, "start");
  useEffect(
    () => () => {
      if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    },
    [],
  );
  // A short grace period bridges the gap between the trigger and the portaled tip.
  const scheduleClose = () => {
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setHovered(false), 160);
  };
  const holdOpen = () => {
    if (leaveTimer.current !== null) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
    setHovered(true);
  };
  const hoverProps = {
    onPointerEnter: (event: { pointerType: string }) => {
      if (event.pointerType === "mouse") holdOpen();
    },
    onPointerLeave: (event: { pointerType: string }) => {
      if (event.pointerType === "mouse") scheduleClose();
    },
  };
  const reason = text(lastErrorLabel(code));
  const stamp = number(at) !== null ? expiry(at, format.dateTime) : "";
  const title = stamp ? "最近错误：" + reason + " · " + stamp : "最近错误：" + reason;
  if (json === "") {
    return (
      <small className={s.errorLine}>
        最近错误：{reason}
        {stamp ? " · " + stamp : ""}
      </small>
    );
  }
  return (
    <>
      <small className={s.errorLine}>
        {/* Anchored through its wrapper: the primitive owns no ref. The label wraps
            inside the card instead of stretching past it and being clipped with no
            ellipsis and no way to read the timestamp (P1-3). */}
        <span className={s.anchor} ref={trigger}>
          <Button
            size="sm"
            variant="ghost"
            className={s.errorTrigger}
            aria-expanded={open}
            title={title}
            /* Touch toggles purely via the pin: hover only tracks mouse pointers,
               so a tap never strands "hovered" open. */
            onClick={() => {
              setPinned((value) => !value);
            }}
            {...hoverProps}
          >
            最近错误：{reason}
          </Button>
        </span>
        {/* The timestamp is its own span: it is the part the old trigger lost off the
            edge of the card, and it must stay readable whatever the button does with
            its own label. */}
        {stamp ? <span className={s.errorAt}> · {stamp}</span> : null}
      </small>
      {open &&
        createPortal(
          <div
            ref={tip}
            className={s.tip}
            style={
              placement
                ? { ...cappedTop(placement.top), left: placement.left }
                : { visibility: "hidden" }
            }
            {...hoverProps}
          >
            {json}
          </div>,
          popoverHost(trigger.current),
        )}
    </>
  );
}

export { safeOAuthUrl } from "../OAuth";

function boundModels(credential: Credential): string[] {
  return Array.isArray(credential.bindings)
    ? credential.bindings.filter((id): id is string => typeof id === "string")
    : [];
}

function ImportDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<"file" | "token">("file");
  const [results, setResults] = useState<ImportResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<RefreshProfile>("cn-work");
  const [input, setInput] = useState("");
  const parsed = parseRefreshTokens(input);
  const tooMany = parsed.tokens.length > MAX_REFRESH_TOKENS;
  const switchTab = (next: "file" | "token") => {
    if (busy) return;
    setTab(next);
    setResults([]);
    setError(null);
  };
  const importFiles = (files: File[]) => {
    setBusy(true);
    setError(null);
    setResults([]);
    void prepareImports(files)
      .then(async (batch) => {
        setResults(batch.results);
        if (!batch.files.length) return;
        const response = await api.post<unknown>("/credentials/upload", {
          files: batch.files,
          replace: false,
        });
        const server = list(object(response.data).results).map((item) => {
          if (typeof item.name !== "string" || typeof item.ok !== "boolean")
            throw new Error("导入结果缺少 name / ok");
          return {
            name: item.name,
            ok: item.ok,
            ...(item.error ? { error: text(item.error) } : {}),
          };
        });
        setResults([...batch.results, ...server]);
        if (server.some((item) => item.ok)) onDone();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  const importTokens = () => {
    if (busy || !parsed.tokens.length || tooMany) return;
    setBusy(true);
    setError(null);
    setResults([]);
    void api
      .post<unknown>("/credentials/refresh-import", {
        profile,
        refresh_tokens: parsed.tokens,
      })
      .then((response) => {
        const server = list(object(response.data).results).map((item) => {
          if (typeof item.name !== "string" || typeof item.ok !== "boolean")
            throw new Error("导入结果缺少 name / ok");
          return {
            name: item.name,
            ok: item.ok,
            ...(item.error ? { error: text(item.error) } : {}),
          };
        });
        setResults(server);
        if (server.some((item) => item.ok)) onDone();
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };
  return (
    <Drawer
      title="导入凭证"
      closeLabel={t("common.closeDrawer")}
      dismissDisabled={busy}
      onClose={onClose}
    >
      <div className={s.tabs} role="tablist" aria-label="导入方式">
        {(
          [
            ["file", "文件导入"],
            ["token", "仅刷新令牌"],
          ] as ["file" | "token", string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={s.tab}
            onClick={() => switchTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "file" ? (
        <>
          <p className={s.note}>
            支持 UTF-8 .info 或 ZIP，ZIP 仅接受根目录 .info。单项 ≤ 1 MiB，每批 ≤ 100 项 / 32
            MiB，不覆盖现有文件。
          </p>
          <Field label="选择 .info 或 ZIP">
            <input
              className={s.fileInput}
              type="file"
              accept=".info,.zip"
              multiple
              disabled={busy}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length) importFiles(files);
              }}
            />
          </Field>
          {busy && <p role="status">正在检查并上传，请勿关闭…</p>}
        </>
      ) : (
        <>
          <p className={s.note}>
            每行一个刷新令牌，逐条换取访问令牌后写入新凭证。端点决定产品与地区：国内刷新令牌分不出
            CLI 与 WorkBuddy，跨区令牌会被上游直接拒绝。
          </p>
          <Field label="端点">
            <Select
              label="端点"
              value={profile}
              disabled={busy}
              onChange={(value) => setProfile(value as RefreshProfile)}
            >
              {REFRESH_PROFILES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}（{item.value}）
                </option>
              ))}
            </Select>
          </Field>
          <Field label="刷新令牌">
            <Textarea
              value={input}
              rows={8}
              spellCheck={false}
              disabled={busy}
              placeholder={"每行一个刷新令牌，# 开头的行会被忽略"}
              onChange={(e) => setInput(e.target.value)}
            />
          </Field>
          <p className={s.note}>
            已识别 {parsed.tokens.length} / {MAX_REFRESH_TOKENS} 条
            {parsed.rejected ? "，" + parsed.rejected + " 行超过 8192 字符已忽略" : ""}。
          </p>
          <Button
            variant="primary"
            disabled={busy || !parsed.tokens.length || tooMany}
            onClick={importTokens}
          >
            {busy ? "正在逐条刷新并写入，请勿关闭…" : "刷新并导入 " + parsed.tokens.length + " 条"}
          </Button>
        </>
      )}
      <ErrorNotice message={error} />
      {results.map((r, i) => (
        <div className={s.importResult} key={i}>
          <Badge tone={r.ok ? "good" : "bad"}>{r.ok ? "已导入" : "未导入"}</Badge>
          <strong>{r.name}</strong>
          {r.error && <p>{r.error}</p>}
        </div>
      ))}
    </Drawer>
  );
}

type MaintenanceAction =
  | "refresh"
  | "checkin"
  | "sync"
  | "travel"
  | "travel-status"
  | "daily-chat"
  | "reset-cooldown";
const MAINTENANCE_LABELS: Record<MaintenanceAction, string> = {
  refresh: "刷新 Token",
  checkin: "签到",
  sync: "同步余额",
  travel: "旅行领派",
  "travel-status": "旅行状态",
  "daily-chat": "活跃打卡",
  "reset-cooldown": "清除冷却",
};
// Batch runs over every account keep the names of their toolbar buttons.
const BATCH_LABELS: Partial<Record<MaintenanceAction, string>> = {
  sync: "同步全部余额",
  checkin: "批量签到",
};
const SHOWN_RESULTS = 5;

function outcomeOf(r: Record<string, unknown>): { label: string; complete: boolean } {
  const travel = r.travel && typeof r.travel === "object" ? object(r.travel) : null;
  if (r.ok === true && travel?.ok !== false) return { label: "已完成", complete: true };
  const partial =
    r.checkin_ok === true ||
    r.claimed === true ||
    r.departed === true ||
    r.buddy_claimed === true ||
    r.agreement_accepted === true ||
    travel?.claimed === true ||
    travel?.departed === true;
  return { label: partial ? "部分完成" : r.skipped ? "已跳过" : "未完成", complete: false };
}

/**
 * Report a maintenance run as a toast: a batch lists only the accounts that did not finish,
 * a single account always shows its own result.
 */
function notifyMaintenance(title: string, results: Record<string, unknown>[]) {
  const rows = results.map((r) => ({ r, ...outcomeOf(r) }));
  const shown = results.length === 1 ? rows : rows.filter((row) => !row.complete);
  const counts = ["已完成", "部分完成", "已跳过", "未完成"]
    .map((label) => [label, rows.filter((row) => row.label === label).length] as const)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => label + " " + count)
    .join(" · ");
  notify({
    key: "maintenance",
    tone: shown.every((row) => row.complete) ? "good" : "warn",
    title,
    body: (
      <>
        {results.length > 1 && <span>{counts}</span>}
        {shown.length > 0 && (
          <ul className={s.toastRows}>
            {shown.slice(0, SHOWN_RESULTS).map(({ r, label, complete }, i) => (
              <li key={i}>
                <strong>{text(r.name)}</strong>
                <Badge tone={complete ? "good" : "warn"}>{label}</Badge>
                <span>{text(r.message)}</span>
                <TravelSummary
                  trip={
                    r.travel && typeof r.travel === "object"
                      ? object(r.travel)
                      : r.action === "travel" || r.action === "travel-status"
                        ? r
                        : null
                  }
                />
              </li>
            ))}
          </ul>
        )}
        {shown.length > SHOWN_RESULTS && (
          <span>另有 {shown.length - SHOWN_RESULTS} 个账号未完成，请在对应卡片核验。</span>
        )}
      </>
    ),
  });
}

type ChannelKey = "all" | "cn" | "intl" | "enterprise";
type ViewMode = "cards" | "list";
type StatusFilter = "all" | "ready" | "issue" | "disabled";
type DetailTab = "overview" | "credits" | "tasks" | "cooldowns" | "raw";

const PAGE_SIZES = [10, 20, 50, 100, 500, 1000, 2000] as const;
const PAGE_SIZE_KEY = "codebuddy2api.credPageSize";
const VIEW_MODE_KEY = "codebuddy2api.credView";

function savedPageSize(): number {
  try {
    const raw = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(raw) ? raw : 20;
  } catch {
    return 20;
  }
}

function savedViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "list" ? "list" : "cards";
  } catch {
    return "cards";
  }
}

function isEnterprise(c: Credential): boolean {
  if (c.enterprise === true || Boolean(c.enterpriseName)) return true;
  if (c.credits && typeof c.credits === "object" && object(c.credits).enterprise === true)
    return true;
  return false;
}

function channelOf(c: Credential): Exclude<ChannelKey, "all"> {
  if (isEnterprise(c)) return "enterprise";
  if (text(c.profile).startsWith("intl") || c.region === "intl") return "intl";
  return "cn";
}

/**
 * Live health badge for one credential: "认证熔断 m:ss" while the breaker is open, the
 * remaining time while the official 11140 restriction is in force, and the localized
 * state otherwise (人工停用 / 自动禁用 / 认证正常).
 *
 * The page root used to hold the clock, so every tick re-rendered the channel
 * summary cards, the whole filtered account list and the pager — and re-ran the
 * filter over every account. Subscribing here instead confines a tick to the one
 * badge that actually changes, and the subscription drops out entirely when both
 * deadlines are absent or already in the past.
 */
function HealthBadge({
  failUntil,
  restrictedUntil,
  restricted,
  health,
}: {
  failUntil: number | null;
  restrictedUntil: number | null;
  restricted: boolean;
  health: string;
}) {
  const breakerLive = failUntil !== null && failUntil > 0;
  const restrictedLive = restricted && restrictedUntil !== null && restrictedUntil > 0;
  const now = useNow(breakerLive || restrictedLive);
  // A deadline already in the past means the condition lifted and must not keep
  // showing a stale 0:00 badge (upstream leaves the timestamp behind).
  const cooling = breakerLive && Math.ceil(failUntil - now / 1000) > 0;
  const restrictedLeft = restrictedLive ? Math.ceil(restrictedUntil - now / 1000) : 0;
  if (restricted) {
    return (
      <Badge tone="bad">
        {restrictedLeft > 0
          ? healthLabels.restricted + " " + restrictedLeft + "s"
          : healthLabels.restricted}
      </Badge>
    );
  }
  return (
    <Badge tone={cooling ? "bad" : health === "ready" ? "good" : "warn"}>
      {cooling
        ? "认证熔断 " + countdownText(failUntil, "", now)
        : health === "ready"
          ? "认证正常"
          : (healthLabels[health] ?? health)}
    </Badge>
  );
}

/**
 * Compact "model · m:ss" cooldown text, ticking on the shared clock.
 *
 * "fallback" is the backend's own remaining-seconds figure: it is what renders
 * before the first tick arrives, and it is what keeps a cooldown readable when the
 * "until" deadline is missing.
 */
function ModelCooldownText({
  model,
  until,
  fallback,
}: {
  model: string;
  until: number | null;
  fallback: string;
}) {
  const live = until !== null && until > 0;
  const now = useNow(live);
  return (
    <small>
      {model} · {countdownText(until, fallback, now)}
    </small>
  );
}

/** A row's overflow menu. Same algorithm as the error tip: it opens below the trigger,
 *  flips above when there is no room, and never leaves the viewport (P3-2). */
function MoreMenu({
  label,
  title = "更多",
  children,
}: {
  label?: string;
  title?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLSpanElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const placement = usePopover(open, close, trigger, menu, "end");
  return (
    <>
      <span className={s.anchor} ref={trigger}>
        <Button
          size="sm"
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => setOpen(!open)}
        >
          {title}
        </Button>
      </span>
      {open &&
        createPortal(
          <div
            ref={menu}
            className={s.menu}
            role="menu"
            style={
              placement
                ? { ...cappedTop(placement.top), left: placement.left }
                : { visibility: "hidden" }
            }
            onClick={close}
          >
            {children}
          </div>,
          popoverHost(trigger.current),
        )}
    </>
  );
}

/** Columns whose first click means "largest first" (the useful direction for a figure). */
const DESC_FIRST = new Set(["balance", "usage", "status"]);

const STATUS_OPTIONS = [
  { value: "all", label: "全部" },
  { value: "ready", label: "就绪" },
  { value: "issue", label: "冷却 / 异常" },
  { value: "disabled", label: "已停用" },
];

const VIEW_OPTIONS = [
  { value: "cards", label: "卡片视图" },
  { value: "list", label: "列表视图" },
];

const DETAIL_TABS: [DetailTab, string][] = [
  ["overview", "概览与请求"],
  ["credits", "官方额度"],
  ["tasks", "自动化配置"],
  ["cooldowns", "绑定与冷却"],
  ["raw", "原始诊断"],
];

export function Credentials() {
  const t = useT();
  const resource = useResource("/credentials", credentialResponse);
  const [selected, setSelected] = useState<string[]>([]);
  const [drawer, setDrawer] = useState<"oauth" | "import" | "export" | null>(null);
  const [detail, setDetail] = useState<{ credential: Credential; tab: DetailTab } | null>(null);
  const [detailLogs, setDetailLogs] = useState<Record<string, unknown>[] | null>(null);
  const [deleting, setDeleting] = useState<Credential | null>(null);
  const [trialTarget, setTrialTarget] = useState<Credential | null>(null);
  const [buddyTarget, setBuddyTarget] = useState<{
    credential: Credential;
    result: Record<string, unknown>;
    confirmation: ReturnType<typeof buddyConfirmation>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openDetail = (credential: Credential, tab: DetailTab = "overview") => {
    setDetail({ credential, tab });
  };
  // Optimistic overlay for the paused switch and the enabled button: the toggle
  // flips immediately and rolls back if the write fails. Declared before the
  // derived views below, which read through it.
  const optimistic = useOptimisticOverrides<string>();
  const detailTab = detail?.tab ?? null;
  // The effect below keys on the credential *identity*, never on the derived row
  // object: optimistic.view() is re-evaluated on every render (and always returns
  // a fresh object while an override is pending), so using it as a dependency
  // re-ran the fetch on every render — ~520 /admin/logs requests per second after
  // any toggle inside the drawer, which only stopped when the drawer closed.
  const detailKey = detail ? text(detail.credential.account_key ?? detail.credential.id) : null;
  // Fusion increment: the drawer reads through the same optimistic overlay as the
  // list so a paused/enabled toggle reflects immediately inside the open drawer.
  const liveDetail = detail
    ? optimistic.view(
        resource.data?.find((item) => item.id === detail.credential.id) ?? detail.credential,
      )
    : null;
  useEffect(() => {
    if (detailKey === null || detailTab !== "overview") return;
    let cancelled = false;
    void api
      .get("/logs?credential=" + encodeURIComponent(detailKey) + "&limit=8")
      .then((res) => {
        if (cancelled) return;
        const items = object(res.data).items;
        setDetailLogs(Array.isArray(items) ? list(items) : []);
      })
      .catch(() => {
        if (!cancelled) setDetailLogs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [detailKey, detailTab]);
  const [running, setRunning] = useState<{ key: string; title: string } | null>(null);
  const maintain = (action: MaintenanceAction, credential?: Credential) => {
    if (busy) return;
    const title = credential
      ? MAINTENANCE_LABELS[action] + " · " + (credential.name ?? credential.id)
      : (BATCH_LABELS[action] ?? MAINTENANCE_LABELS[action]);
    setBusy(true);
    setRunning({ key: action + ":" + (credential?.id ?? "*"), title });
    setError(null);
    const path = credential
      ? "/credentials/" + encodeURIComponent(credential.id) + "/" + action
      : "/" + action;
    void api
      .post(path, undefined, { timeout: 300000 })
      .then(({ data }) => {
        const results = list(object(data).results, "凭证操作结果");
        if (
          !results.length ||
          results.some((r) => typeof r.ok !== "boolean" || typeof r.message !== "string")
        )
          throw new Error("未收到完整操作结果，请刷新列表核验，勿直接重复执行");
        for (const r of results) if (r.travel !== undefined) object(r.travel, "旅行操作结果");
        notifyMaintenance(title, results);
        if (action === "travel" && credential) {
          if (results.length !== 1 || results[0].id !== credential.id)
            throw new Error("旅行账号或结果未确认，请刷新列表核验");
          if (results[0].buddy_confirmation !== undefined)
            setBuddyTarget({
              credential,
              result: results[0],
              confirmation: buddyConfirmation(results[0].buddy_confirmation),
            });
        }
      })
      .catch((err: unknown) =>
        setError(errorMessage(err) + "；请求失败不代表后台已停止，请刷新列表核验。"),
      )
      .finally(() => {
        setBusy(false);
        setRunning(null);
        resource.reload();
      });
  };
  const oauthDone = useCallback(() => {
    setDrawer(null);
    notify({ tone: "good", title: "授权完成，凭证已添加。" });
    resource.reload();
  }, [resource.reload]);
  // No page-root clock: this page used to call useNow() here, which re-rendered
  // the channel summary cards, the whole filtered list and the pager once a second
  // (and re-ran the filter over every account each time). Countdown text is now
  // produced by <HealthBadge> / <ModelCooldownText>, which subscribe to the
  // shared clock themselves — see the comment above each.
  // One locale-aware formatter for every timestamp on the page.
  const format = useDateFormat();
  const togglePaused = (credential: Credential, paused: boolean) => {
    if (busy) return;
    // Only paused is written: the two flags are orthogonal server-side, so
    // mirroring paused into enabled would show a rollback that never happened.
    optimistic.apply(credential.id, { paused });
    setBusy(true);
    setError(null);
    // fused contract: PATCH {paused} equals enabled=false
    void fusionMutate("PATCH", "/admin/credentials/" + encodeURIComponent(credential.id), {
      paused,
    })
      .then(() => {
        notify({
          key: "paused",
          tone: "good",
          title: paused ? "账号已暂停" : "账号已恢复运行",
          body: <span>{paused ? "不再参与选号，保留在池中。" : "后续请求按规则选用。"}</span>,
        });
      })
      .catch((err: unknown) => {
        optimistic.clear(credential.id);
        setError(errorMessage(err));
      })
      .finally(() => setBusy(false));
  };
  // key optionally identifies the credential row carrying an optimistic override so
  // a failed write rolls the UI back to the authoritative list value.
  const run = (action: () => Promise<unknown>, key?: string) => {
    setBusy(true);
    setError(null);
    void action()
      .then(() => {
        if (key) optimistic.clear(key);
        resource.reload();
        setDeleting(null);
      })
      .catch((err: unknown) => {
        if (key) optimistic.clear(key);
        setError(errorMessage(err));
      })
      .finally(() => setBusy(false));
  };
  const releaseRestriction = (credential: Credential) => {
    run(async () => {
      const response = await api.patch("/credentials/" + encodeURIComponent(credential.id), {
        enabled: true,
      });
      const saved = object(response.data);
      if (saved.id !== credential.id || saved.enabled !== true || !Number.isInteger(saved.revision))
        throw new Error("限制解除结果未确认，请刷新列表核验");
      notify({
        key: "restriction",
        tone: "good",
        title: "官方限制已解除",
        body: <span>账号已重新加入选路。</span>,
      });
    });
  };
  const preference = (
    credential: Credential,
    field: "auto_checkin" | "auto_travel" | "auto_daily_chat" | "auto_growth",
    enabled: boolean,
  ) => {
    // Flip the switch immediately; the overlay is cleared when the write confirms
    // (reload) or rolls back (run's catch).
    optimistic.apply(credential.id, { [field]: enabled });
    run(async () => {
      const response = await api.patch("/credentials/" + encodeURIComponent(credential.id), {
        [field]: enabled,
      });
      const saved = object(response.data);
      if (
        saved.id !== credential.id ||
        saved[field] !== enabled ||
        !Number.isInteger(saved.revision)
      )
        throw new Error("设置保存结果未确认，请刷新列表核验");
      const label =
        field === "auto_checkin"
          ? "自动签到"
          : field === "auto_travel"
            ? "自动旅行"
            : field === "auto_growth"
              ? "自动成长补领"
              : "自动活跃打卡";
      notify({
        key: "preference",
        tone: "good",
        title: label + "已" + (enabled ? "开启" : "关闭"),
        body: <span>保存不会立即执行，后续维护按新设置执行。</span>,
      });
    }, credential.id);
  };
  const [channel, setChannel] = useState<ChannelKey>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>(savedViewMode);
  const [pageSize, setPageSize] = useState<number>(savedPageSize);
  const [page, setPage] = useState(1);
  // The list view sorts before it slices, so the sort lives here rather than in
  // the table: sorting only the visible page would reshuffle on "next".
  const [sort, setSort] = useState<TableSort>(null);
  // The page owns the order (it slices after sorting), so the header click rule comes
  // from the primitive's sort helper instead of being restated here.
  const toggleSort = (columnId: string) => {
    setSort(nextSort(sort, columnId, DESC_FIRST.has(columnId)));
    setPage(1);
  };
  const chooseView = (next: ViewMode) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      /* ignore */
    }
  };
  const choosePageSize = (next: number) => {
    setPageSize(next);
    setPage(1);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(next));
    } catch {
      /* ignore */
    }
  };
  const allItems = resource.data ?? [];
  // Coarse clock (10 s), not the 1 Hz one: the filter and the "N ready" counters only
  // need a cooldown to *expire*, and a per-second snapshot here would re-filter the
  // whole account list once a second — the exact cost this refactor removes. The
  // second-by-second digits are rendered by the leaf countdown components instead.
  const coarseNow = useCoarseNow(10);
  const isReady = (c: Credential) => {
    const until = number(c.fail_until);
    const cooling = until !== null && Math.ceil(until - coarseNow / 1000) > 0;
    return c.enabled !== false && !cooling && c.health === "ready";
  };
  const filtered = allItems.filter((c) => {
    if (channel !== "all" && channelOf(c) !== channel) return false;
    if (statusFilter === "ready" && !isReady(c)) return false;
    if (statusFilter === "disabled" && c.enabled !== false) return false;
    if (statusFilter === "issue" && (c.enabled === false || isReady(c))) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [c.name, c.nickname, c.uid, c.enterpriseName, profileLabel(text(c.profile))]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });
  const liveSelected = selected.filter((id) => allItems.some((c) => c.id === id));
  const growthJobs = useGrowthJobs();
  const accountName = (identity: string) => {
    const credential = allItems.find((c) => c.id === identity);
    return credential?.name ?? credential?.nickname ?? identity.slice(0, 8);
  };
  const growthBanner = (job: ReturnType<typeof growthJobs.byAccount>) =>
    job?.status === "running" ? (
      <JobBanner
        key={job.key}
        title={"成长计划 · " + text(accountName(text(job.meta.account)))}
        job={job}
        describe={describeGrowth}
      />
    ) : null;
  const channelDefs: [ChannelKey, string, string][] = [
    ["all", "全部账号", "个人区域与企业账号汇总"],
    ["cn", "国内区域", "国内 CodeBuddy · WorkBuddy"],
    ["intl", "国际区域", "国际 CodeBuddy · WorkBuddy"],
    ["enterprise", "企业账号", "独立归类 · 不按区域拆分"],
  ];
  // One segment per region group: the figure is the group's remaining credit and the
  // note is how many of its accounts are ready. The full value is the tooltip, so the
  // segment never has to truncate it.
  const channelOptions = channelDefs.map(([key, label, hint]) => {
    const group = key === "all" ? allItems : allItems.filter((c) => channelOf(c) === key);
    const ready = group.filter(isReady).length;
    let totalCredits = 0;
    let hasNumeric = false;
    let unlimited = 0;
    for (const item of group) {
      const bal = item.credits && typeof item.credits === "object" ? object(item.credits) : null;
      if (bal?.unlimited && bal?.enterprise) {
        unlimited += 1;
        continue;
      }
      const val = number(bal?.credits ?? bal?.remaining);
      if (val !== null) {
        totalCredits += val;
        hasNumeric = true;
      }
    }
    return {
      value: key,
      label,
      amount: hasNumeric ? compact(totalCredits) : unlimited > 0 ? "无限" : "—",
      detail: ready + " / " + group.length + " 就绪",
      title: hasNumeric
        ? group.length +
          " 个账号 · 剩余额度 " +
          metric(totalCredits) +
          (unlimited ? " (+" + unlimited + " 无限)" : "")
        : group.length + " 个账号 · " + hint,
    };
  });
  const renderSyncIcon = (c: Credential) => (
    <IconButton
      icon={
        <Icon name="refresh" spin={running?.key === "sync:" + c.id || running?.key === "sync:*"} />
      }
      label={"同步余额 " + (c.name ?? c.id)}
      disabled={busy || c.enabled !== true}
      onClick={() => maintain("sync", c)}
    />
  );
  const renderActions = (c: Credential) => {
    const enabledTasks = [
      c.auto_checkin === true && "签到",
      c.travel_supported === true && c.auto_travel === true && "旅行",
      c.daily_chat_supported === true && c.auto_daily_chat === true && "打卡",
    ].filter(Boolean);
    return (
      <div className={s.rowActions}>
        <Button size="sm" onClick={() => openDetail(c, "overview")}>
          详情
        </Button>
        <Button
          size="sm"
          aria-label={"任务配置 " + (c.name ?? c.id)}
          onClick={() => openDetail(c, "tasks")}
        >
          任务配置{enabledTasks.length ? " (" + enabledTasks.length + ")" : ""}
        </Button>
        <MoreMenu label={"更多 " + (c.name ?? c.id)}>
          <Button
            size="sm"
            disabled={busy || c.enabled !== true}
            aria-label={"刷新凭证 " + (c.name ?? c.id)}
            onClick={() => maintain("refresh", c)}
          >
            刷新 Token
          </Button>
          <Button
            size="sm"
            disabled={busy || c.enabled !== true}
            aria-label={"签到 " + (c.name ?? c.id)}
            onClick={() => maintain("checkin", c)}
          >
            {c.auto_travel === true ? "签到并旅行" : "签到"}
          </Button>
          {/* Not gated on displayed cooldowns or on enablement: a reset that failed
            to persist must stay retryable, and a disabled account can still hold
            a stale cooldown worth clearing. */}
          <Button
            size="sm"
            disabled={busy}
            aria-label={"清除冷却 " + (c.name ?? c.id)}
            onClick={() => maintain("reset-cooldown", c)}
          >
            清除冷却
          </Button>
          {c.restricted === true && (
            <Button
              size="sm"
              disabled={busy}
              aria-label={"解除官方限制 " + (c.name ?? c.id)}
              onClick={() => releaseRestriction(c)}
            >
              申诉通过，重新使用
            </Button>
          )}
          {c.trial_supported === true && (
            <Button
              size="sm"
              disabled={busy || c.enabled !== true}
              aria-label={"领取体验积分 " + (c.name ?? c.id)}
              onClick={() => setTrialTarget(c)}
            >
              领取体验积分
            </Button>
          )}
          {c.daily_chat_supported === true && (
            <Button
              size="sm"
              disabled={busy || c.enabled !== true}
              aria-label={"活跃打卡 " + (c.name ?? c.id)}
              onClick={() => maintain("daily-chat", c)}
            >
              活跃打卡
            </Button>
          )}
          {c.travel_supported === true && (
            <>
              <Button
                size="sm"
                disabled={busy || c.enabled !== true}
                aria-label={"旅行状态 " + (c.name ?? c.id)}
                onClick={() => maintain("travel-status", c)}
              >
                旅行状态
              </Button>
              <Button
                size="sm"
                disabled={busy || c.enabled !== true}
                aria-label={"旅行领派 " + (c.name ?? c.id)}
                onClick={() => maintain("travel", c)}
              >
                旅行领派
              </Button>
            </>
          )}
        </MoreMenu>
        <Button
          size="sm"
          variant="danger"
          disabled={!c.name || busy}
          onClick={() => setDeleting(c)}
        >
          删除
        </Button>
      </div>
    );
  };
  const renderEnableSwitch = (c: Credential) => (
    <>
      <span className={s.switchRow}>
        <Switch
          label={"启用状态 " + (c.name ?? c.id)}
          checked={c.enabled === true}
          disabled={busy || typeof c.enabled !== "boolean"}
          onChange={() =>
            run(() =>
              api.patch("/credentials/" + encodeURIComponent(c.id), {
                enabled: !c.enabled,
              }),
            )
          }
        />
        <span>{c.enabled === true ? "已启用" : c.enabled === false ? "人工停用" : "未知"}</span>
      </span>
      {/* Fusion increment: paused is orthogonal to enabled — pausing only leaves
          credential selection while check-in / travel / keepalive keep running.
          The row *does* carry the authoritative flag: the admin whitelist
          (app/admin_api.py:74) keeps "paused" and pool.snapshot()
          (converter.py:1942) fills it, so the switch reads c.paused and nothing
          else. Deriving it from enabled made an externally paused account show
          "运行中" after a refresh, and made a disabled-but-not-paused account
          show "已暂停". Unknown (missing) is not paused. */}
      <span className={s.switchRow}>
        <Switch
          label={"暂停账号 " + (c.name ?? c.id)}
          checked={c.paused === true}
          // Deliberately not gated on the field being present: a row that omits
          // it must stay operable (the write itself is authoritative), and a
          // missing flag reads as "not paused" rather than blocking the switch.
          disabled={busy}
          onChange={(checked) => togglePaused(c, checked)}
        />
        <span>{c.paused === true ? "已暂停" : c.paused === false ? "运行中" : "未知"}</span>
      </span>
    </>
  );
  const renderHealthBadge = (c: Credential) => (
    // A live breaker ticks once a second, but only that badge re-renders: the
    // countdown is its own clock subscriber (see HealthBadge), instead of the
    // page root subscribing and re-rendering every card and the whole pager.
    <HealthBadge
      failUntil={number(c.fail_until)}
      restrictedUntil={number(c.restricted_until)}
      restricted={c.restricted === true}
      health={text(c.health)}
    />
  );
  const renderSyncAndCatalog = (c: Credential) => {
    const cooldowns = Array.isArray(c.cooldowns) ? list(c.cooldowns) : null;
    const trip = c.travel && typeof c.travel === "object" ? object(c.travel) : null;
    const tokenAt = tokenExpiry(c);
    return (
      <>
        <strong className={s.catalogState}>
          {c.catalog_ready === true
            ? "目录已就绪"
            : c.sync_pending === true
              ? "目录同步中"
              : "目录状态待确认"}
        </strong>
        <div className={s.syncTags}>
          <small>
            {c.token_expired === true
              ? "Token 已过期"
              : typeof c.sync_error === "string" && c.sync_error !== ""
                ? "同步异常"
                : "同步正常"}
          </small>
          {c.token_expired !== true && tokenAt !== null && (
            <small>Token 至 {dateLabel(tokenAt, coarseNow / 1000)}</small>
          )}
          {cooldowns ? (
            cooldowns.length ? (
              cooldowns.map((cooldown, i) => (
                <ModelCooldownText
                  key={i}
                  model={text(cooldown.model)}
                  until={number(cooldown.until)}
                  fallback={text(cooldown.remaining_seconds)}
                />
              ))
            ) : (
              <Badge>无模型冷却</Badge>
            )
          ) : c.model_cooldowns ? (
            <Fields data={{ model_cooldowns: c.model_cooldowns }} />
          ) : null}
        </div>
        {c.last_error_code != null && (
          <LastErrorJson code={c.last_error_code} at={c.last_failure_at} body={c.last_error_body} />
        )}
        {typeof c.sync_error === "string" && c.sync_error !== "" && (
          <small className={s.errorLine}>失败原因：{text(c.sync_error)}</small>
        )}
        {c.travel_supported === true && trip && <TravelSummary trip={trip} />}
      </>
    );
  };
  const renderUsageBlock = (c: Credential, compactTable = false) => {
    const stats = c.usage_stats && typeof c.usage_stats === "object" ? object(c.usage_stats) : null;
    const reqs = number(stats?.requests) ?? 0;
    const rate = number(stats?.success_rate);
    const totalTokens = number(stats?.total_tokens);
    const cacheTokens = number(stats?.cache_read_tokens);
    const credit = number(stats?.credit);
    const avgMs = number(stats?.avg_duration_ms);
    if (compactTable) {
      return (
        <div className={s.tableUsage}>
          <div>
            <span>请求</span>
            <strong>{compact(reqs)}</strong>
          </div>
          <div>
            <span>成功率</span>
            <strong>{rate !== null ? (rate * 100).toFixed(1) + "%" : "—"}</strong>
          </div>
          <div>
            <span>Token</span>
            <strong>{totalTokens !== null ? compact(totalTokens) : "—"}</strong>
          </div>
          <div>
            <span>Credit</span>
            <strong>{credit !== null ? metric(credit) : "—"}</strong>
          </div>
        </div>
      );
    }
    return (
      <div className={s.usage}>
        <div>
          <span>累计请求</span>
          <strong>{compact(reqs)}</strong>
          <small>
            {rate !== null ? "成功率 " + (rate * 100).toFixed(1) + "%" : "暂无请求记录"}
          </small>
        </div>
        <div>
          <span>总 Token</span>
          <strong>{totalTokens !== null ? compact(totalTokens) : "0"}</strong>
          <small>缓存 {cacheTokens !== null ? compact(cacheTokens) : "0"}</small>
        </div>
        <div>
          <span>Credit 消耗</span>
          <strong>{credit !== null ? metric(credit) : "0"}</strong>
          <small>{avgMs !== null ? "平均耗时 " + (avgMs / 1000).toFixed(1) + "s" : "耗时 —"}</small>
        </div>
        <div>
          <span>最近调用</span>
          <strong title={stats?.last_model ? text(stats.last_model) : undefined}>
            {stats?.last_model ? text(stats.last_model) : "—"}
          </strong>
          <small>
            {stats?.last_request_at !== undefined
              ? expiry(stats.last_request_at, format.dateTime)
              : "尚无调用"}
          </small>
        </div>
      </div>
    );
  };
  const renderAutomationPanel = (c: Credential) => {
    const checkin = c.checkin && typeof c.checkin === "object" ? object(c.checkin) : null;
    const trip = c.travel && typeof c.travel === "object" ? object(c.travel) : null;
    const dailyChat =
      c.daily_chat && typeof c.daily_chat === "object" ? object(c.daily_chat) : null;
    return (
      <div className={s.tasks}>
        <div className={s.taskRow}>
          <span className={s.switchRow}>
            <Switch
              label={"自动签到 " + (c.name ?? c.id)}
              checked={c.auto_checkin === true}
              disabled={busy || typeof c.auto_checkin !== "boolean"}
              onChange={(checked) => preference(c, "auto_checkin", checked)}
            />
            <span>自动签到</span>
          </span>
          <small className={s.note}>
            上次签到{checkin?.date ? "（" + text(checkin.date) + "）" : ""}：
            {checkin ? text(checkin.message) : "尚未查询"}
          </small>
        </div>
        <div className={s.taskRow}>
          <span className={s.switchRow}>
            <Switch
              label={"自动旅行 " + (c.name ?? c.id)}
              checked={c.auto_travel === true}
              disabled={busy || c.travel_supported !== true || typeof c.auto_travel !== "boolean"}
              onChange={(checked) => preference(c, "auto_travel", checked)}
            />
            <span>自动旅行</span>
          </span>
          <small className={s.note}>
            {c.travel_supported === true
              ? "上次旅行：" + (trip ? text(trip.message) : "尚未查询")
              : isEnterprise(c)
                ? "企业账号不参与成长中心，无法旅行"
                : "旅行仅适用于国内账号"}
          </small>
        </div>
        <div className={s.taskRow}>
          <span className={s.switchRow}>
            <Switch
              label={"自动活跃打卡 " + (c.name ?? c.id)}
              checked={c.auto_daily_chat === true}
              disabled={
                busy || c.daily_chat_supported !== true || typeof c.auto_daily_chat !== "boolean"
              }
              onChange={(checked) => preference(c, "auto_daily_chat", checked)}
            />
            <span>自动活跃打卡</span>
          </span>
          <small className={s.note}>
            {c.daily_chat_supported === true
              ? "今日打卡：" + (dailyChat ? text(dailyChat.message) : "尚未执行")
              : "活跃打卡仅适用于国际 WorkBuddy 账号"}
          </small>
        </div>
        {dailyChat?.acp_usage != null && (
          <small className={s.note}>本次会话成本：{text(dailyChat.acp_usage)} 积分</small>
        )}
        {trip?.stale === true && <small className={s.note}>状态可能已变化，请先查询核验</small>}
        {c.travel_supported === true && <TravelSummary trip={trip} />}
        {c.enabled === false && <small className={s.note}>账号停用期间不执行自动任务</small>}
        {c.trial_supported === true && c.trial != null && (
          <small className={s.note}>体验积分：{text(object(c.trial).message)}</small>
        )}
        {c.growth_supported === true && (
          <>
            <small className={s.note}>
              <strong>成长计划</strong>
              （仅国内个人账号；任务开关默认关闭，开启后自动推进）
            </small>
            <GrowthTasks
              credential={c}
              busy={busy}
              onPreference={preference}
              selectedIds={liveSelected}
              job={growthJobs.byAccount(c.id)}
              onRun={(code) => growthJobs.start(c.id, code)}
            />
          </>
        )}
      </div>
    );
  };
  /**
   * The list view's columns.
   *
   * Every cell delegates to the same renderer the card view uses, so the two
   * views can never drift: a change to how a balance or a breaker reads lands in
   * both places at once. The actions column is declared with "actions: true" so the
   * primitive pins it to the right edge and folds it into the card's footer.
   */
  const listColumns: TableColumn<Credential>[] = [
    {
      id: "name",
      header: "凭证 / 产品",
      sortable: true,
      className: `${s.cellWrap} ${s.nameCell}`,
      cell: (c) => (
        <>
          <strong className={s.rowName} title={text(c.name ?? c.id)}>
            {c.name ?? "安全文件名不可用"}
          </strong>
          <small className={s.rowNote}>
            {isEnterprise(c)
              ? "企业账号 · " + profileLabel(text(c.profile))
              : profileLabel(text(c.profile))}{" "}
            · {text(c.nickname ?? c.uid)}
          </small>
        </>
      ),
    },
    {
      id: "catalog",
      header: "目录与同步状态",
      className: s.cellWrap,
      cell: (c) => renderSyncAndCatalog(c),
    },
    {
      id: "balance",
      header: "官方余额 / 到期",
      sortable: true,
      className: s.cellWrap,
      cell: (c) => {
        const balance = c.credits && typeof c.credits === "object" ? object(c.credits) : null;
        return (
          <>
            <div className={s.statHead}>
              <strong>
                {balance
                  ? balance.unlimited && balance.enterprise
                    ? "无限"
                    : metric(balance.credits ?? balance.remaining)
                  : "未知"}
              </strong>
              {renderSyncIcon(c)}
            </div>
            <BalanceExpiry credits={balance} now={coarseNow / 1000} />
          </>
        );
      },
    },
    {
      id: "usage",
      header: "请求与用量",
      sortable: true,
      className: `${s.cellWrap} ${s.usageCell}`,
      cell: (c) => renderUsageBlock(c, true),
    },
    {
      id: "status",
      header: "认证与启用",
      sortable: true,
      className: `${s.cellWrap} ${s.statusCell}`,
      cell: (c) => (
        <div className={s.badges}>
          {renderHealthBadge(c)}
          {renderEnableSwitch(c)}
        </div>
      ),
    },
    {
      id: "actions",
      header: "操作",
      actions: true,
      cell: (c) => renderActions(c),
    },
  ];
  const listSortValues: Record<string, SortValue<Credential>> = {
    name: (c) => text(c.name ?? c.id),
    balance: (c) => {
      const bal = c.credits && typeof c.credits === "object" ? object(c.credits) : null;
      if (bal?.unlimited && bal?.enterprise) return Number.POSITIVE_INFINITY;
      return number(bal?.credits ?? bal?.remaining) ?? undefined;
    },
    usage: (c) => {
      const stats =
        c.usage_stats && typeof c.usage_stats === "object" ? object(c.usage_stats) : null;
      return number(stats?.requests) ?? undefined;
    },
    status: (c) => (isReady(c) ? 2 : c.enabled === false ? 0 : 1),
  };
  const ordered = sortRows(filtered, listSortValues, sort);
  const totalPages = Math.max(1, Math.ceil(ordered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = ordered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const clearFilters = () => {
    setQuery("");
    setChannel("all");
    setStatusFilter("all");
    setPage(1);
  };
  const toggleSelected = (c: Credential, checked: boolean) =>
    setSelected(checked ? [...selected, c.id] : selected.filter((id) => id !== c.id));
  return (
    <Page
      title="凭证管理"
      description="账号登录态、官方余额与自动化开关；同步与探活按账号执行，批量操作只作用于已选账号。"
      actions={
        <>
          <Button
            icon={<Icon name="refresh" spin={resource.refreshing} />}
            onClick={() => {
              clearToasts();
              resource.reload();
            }}
          >
            刷新列表
          </Button>
          <Button disabled={busy} onClick={() => maintain("sync")}>
            同步全部余额
          </Button>
          <MoreMenu label="批量操作" title="批量操作">
            <Button size="sm" disabled={busy} onClick={() => maintain("checkin")}>
              批量签到
            </Button>
            <Button size="sm" onClick={() => setDrawer("import")}>
              导入文件
            </Button>
            <Button size="sm" disabled={!liveSelected.length} onClick={() => setDrawer("export")}>
              导出已选 ({liveSelected.length})
            </Button>
          </MoreMenu>
          <Button variant="primary" icon="key" onClick={() => setDrawer("oauth")}>
            添加凭证
          </Button>
        </>
      }
    >
      <ToastRegion />
      {!detail && running && (
        <ProgressBanner title={running.title}>
          <small>正在执行，请勿重复提交…</small>
        </ProgressBanner>
      )}
      {growthJobs.jobs.map(growthBanner)}
      {resource.loading && !resource.data ? (
        <Skeleton
          variant="table"
          label="凭证列表加载中"
          cells={["text", "twoLine", "badge", "text"]}
        />
      ) : (
        <ErrorNotice
          message={resource.error}
          retry={{ label: t("common.retry"), onClick: resource.reload }}
        />
      )}
      {!detail && <ErrorNotice message={error} />}
      {resource.data && (
        <Segmented
          label="区域与账号类型筛选"
          value={channel}
          options={channelOptions}
          className={s.channelBar}
          onChange={(next) => {
            // Clicking the active group (other than 全部) returns to the whole pool.
            setChannel(next === channel && next !== "all" ? "all" : (next as ChannelKey));
            setPage(1);
          }}
        />
      )}
      <Panel
        title="账号凭证"
        hint={
          resource.data
            ? filtered.length === allItems.length
              ? allItems.length + " 个账号"
              : "筛选 " + filtered.length + " / " + allItems.length + " 个账号"
            : "等待凭证列表"
        }
      >
        <Toolbar split>
          <Cluster gap="2">
            <label className={s.check}>
              <input
                aria-label="选择全部凭证"
                type="checkbox"
                checked={allItems.length > 0 && liveSelected.length === allItems.length}
                onChange={(e) => setSelected(e.target.checked ? allItems.map((c) => c.id) : [])}
              />
              <span>全选</span>
            </label>
            <Input
              type="search"
              className={s.search}
              aria-label="搜索凭证"
              placeholder="搜索账号文件名、昵称或 UID…"
              value={query}
              onChange={(value) => {
                setQuery(value.target.value);
                setPage(1);
              }}
            />
            <Segmented
              size="sm"
              label="状态筛选"
              value={statusFilter}
              options={STATUS_OPTIONS}
              onChange={(next) => {
                setStatusFilter(next as StatusFilter);
                setPage(1);
              }}
            />
            {liveSelected.length > 0 && (
              <Button size="sm" onClick={() => setDrawer("export")}>
                导出已选 ({liveSelected.length})
              </Button>
            )}
          </Cluster>
          <Segmented
            size="sm"
            label="视图切换"
            value={view}
            options={VIEW_OPTIONS}
            onChange={(next) => chooseView(next as ViewMode)}
          />
        </Toolbar>
        {resource.data &&
          (filtered.length ? (
            <>
              {view === "cards" ? (
                <div className={s.cardGrid}>
                  {paged.map((raw) => {
                    // Fusion increment: apply the optimistic overlay (paused/enabled
                    // writes) on top of the authoritative list; reloads reconcile it.
                    const c = optimistic.view(raw);
                    const balance =
                      c.credits && typeof c.credits === "object" ? object(c.credits) : null;
                    return (
                      <article key={c.id} className={s.card}>
                        <div className={s.cardHead}>
                          <label className={s.cardTitle}>
                            <input
                              aria-label={"选择 " + (c.name ?? c.id)}
                              type="checkbox"
                              checked={liveSelected.includes(c.id)}
                              onChange={(e) => toggleSelected(c, e.target.checked)}
                            />
                            <span className={s.cardName}>
                              <strong title={text(c.name ?? c.id)}>
                                {c.name ?? "安全文件名不可用"}
                              </strong>
                              <small>
                                {isEnterprise(c)
                                  ? "企业账号 · " + profileLabel(text(c.profile))
                                  : profileLabel(text(c.profile))}{" "}
                                · {text(c.nickname ?? c.uid)}
                              </small>
                            </span>
                          </label>
                          <div className={s.badges}>
                            {renderHealthBadge(c)}
                            {renderEnableSwitch(c)}
                          </div>
                        </div>
                        <div className={s.stats}>
                          <div className={s.stat}>
                            <div className={s.statHead}>
                              <span>官方余额 / 到期</span>
                              {renderSyncIcon(c)}
                            </div>
                            <strong>
                              {balance
                                ? balance.unlimited && balance.enterprise
                                  ? "无限"
                                  : metric(balance.credits ?? balance.remaining)
                                : "未知"}
                            </strong>
                            <BalanceExpiry credits={balance} now={coarseNow / 1000} />
                          </div>
                          <div className={s.stat}>
                            <span>目录与同步状态</span>
                            {renderSyncAndCatalog(c)}
                          </div>
                        </div>
                        {renderUsageBlock(c)}
                        <div className={s.cardFoot}>{renderActions(c)}</div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <Table
                  // The optimistic overlay is applied per row here, exactly as the
                  // card view does: a paused/enabled write flips the row before the
                  // server answers, and a failed write rolls it back.
                  rows={paged.map((raw) => optimistic.view(raw))}
                  columns={listColumns}
                  rowKey={(c) => c.id}
                  label="账号凭证列表"
                  sort={sort}
                  onSort={toggleSort}
                  // The page sorts and slices before handing rows over, so the
                  // table must not re-sort the visible page underneath it.
                  selection={{
                    selected: new Set(liveSelected),
                    onChange: (next) => setSelected([...next]),
                    rowLabel: (c) => "选择 " + (c.name ?? c.id),
                    selectAllLabel: "全选当前页",
                    // The toolbar's 全选 means the whole pool; a second header box
                    // selecting a different set on the same screen is a trap.
                    headerCheckbox: false,
                  }}
                />
              )}
              <div className={s.pager}>
                <span>
                  第 {(safePage - 1) * pageSize + 1}–
                  {Math.min(filtered.length, safePage * pageSize)} 条 · 共 {filtered.length} 个账号
                </span>
                <div className={s.pagerRight}>
                  <Select
                    label="每页显示数量"
                    value={pageSize}
                    onChange={(value) => choosePageSize(Number(value))}
                  >
                    {PAGE_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {n} / 页
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    disabled={safePage <= 1}
                    onClick={() => setPage(Math.max(1, safePage - 1))}
                  >
                    上一页
                  </Button>
                  <span>
                    第 {safePage} / {totalPages} 页
                  </span>
                  <Button
                    size="sm"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <Empty
              title={allItems.length ? "没有匹配的凭证" : "还没有凭证"}
              tone={
                allItems.length &&
                (channel !== "all" || statusFilter !== "all" || query.trim().length > 0)
                  ? "filtered"
                  : "initial"
              }
              action={
                allItems.length ? (
                  <Button size="sm" onClick={clearFilters}>
                    {t("common.clearFilters")}
                  </Button>
                ) : undefined
              }
            >
              {allItems.length ? "可切换上方区域或清除筛选条件。" : "添加账号或导入 .info 文件。"}
            </Empty>
          ))}
      </Panel>
      <DrawerPresence>
        {buddyTarget && (
          <Buddy
            key={buddyTarget.credential.id}
            credential={buddyTarget.credential}
            initial={buddyTarget.result}
            confirmation={buddyTarget.confirmation}
            onClose={() => setBuddyTarget(null)}
            onDone={(result) => {
              notifyMaintenance(
                "首次领取猫猫并派遣 · " +
                  (buddyTarget.credential.name ?? buddyTarget.credential.id),
                [result],
              );
              resource.reload();
            }}
          />
        )}
      </DrawerPresence>
      <DrawerPresence>
        {trialTarget && (
          <Trial
            credential={trialTarget}
            onClose={() => setTrialTarget(null)}
            onDone={resource.reload}
          />
        )}
      </DrawerPresence>
      <DrawerPresence>
        {drawer === "oauth" && <OAuth onClose={() => setDrawer(null)} onDone={oauthDone} />}
      </DrawerPresence>
      <DrawerPresence>
        {drawer === "import" && (
          <ImportDrawer onClose={() => setDrawer(null)} onDone={resource.reload} />
        )}
      </DrawerPresence>
      <DrawerPresence>
        {detail && liveDetail && (
          <Drawer
            title={"凭证详情 · " + (liveDetail.name ?? liveDetail.id)}
            closeLabel={t("common.closeDrawer")}
            onClose={() => setDetail(null)}
          >
            {running && (
              <ProgressBanner title={running.title}>
                <small>正在执行，请勿重复提交…</small>
              </ProgressBanner>
            )}
            {growthBanner(growthJobs.byAccount(liveDetail.id))}
            <ErrorNotice message={error} />
            <div className={s.detailBar}>
              <div className={s.badges}>
                {renderHealthBadge(liveDetail)}
                {renderEnableSwitch(liveDetail)}
              </div>
              <div className={s.rowActions}>
                {renderSyncIcon(liveDetail)}
                <Button
                  size="sm"
                  disabled={busy || liveDetail.enabled !== true}
                  onClick={() => maintain("refresh", liveDetail)}
                >
                  刷新 Token
                </Button>
              </div>
            </div>
            <div className={s.tabs} role="tablist" aria-label="凭证详情分区">
              {DETAIL_TABS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={detail.tab === key}
                  className={s.tab}
                  onClick={() => setDetail({ credential: liveDetail, tab: key })}
                >
                  {label}
                </button>
              ))}
            </div>
            {detail.tab === "overview" && (
              <>
                <Panel title="请求与用量概览">{renderUsageBlock(liveDetail)}</Panel>
                <Panel title="目录与同步状态">{renderSyncAndCatalog(liveDetail)}</Panel>
                <Panel title="最近请求记录">
                  {detailLogs === null ? (
                    <small>正在加载请求记录…</small>
                  ) : detailLogs.length ? (
                    <Table
                      label="最近请求记录"
                      rows={detailLogs.map((log, index) => ({ log, index }))}
                      rowKey={(row) =>
                        typeof row.log.id === "string" ? row.log.id : String(row.index)
                      }
                      columns={[
                        {
                          id: "at",
                          header: "时间",
                          cell: (row) => expiry(row.log.started_at, format.dateTime),
                        },
                        {
                          id: "model",
                          header: "模型",
                          cell: (row) => text(row.log.public_model ?? row.log.model),
                        },
                        {
                          id: "status",
                          header: "状态",
                          cell: (row) => (
                            <Badge tone={row.log.outcome === "success" ? "good" : "warn"}>
                              {text(row.log.status_code ?? row.log.outcome)}
                            </Badge>
                          ),
                        },
                        {
                          id: "tokens",
                          header: "Token",
                          cell: (row) => compact(row.log.total_tokens),
                        },
                        {
                          id: "credit",
                          header: "Credit",
                          cell: (row) => metric(row.log.credit),
                        },
                      ]}
                    />
                  ) : (
                    <Empty title="暂无该凭证的请求明细" />
                  )}
                </Panel>
              </>
            )}
            {detail.tab === "credits" && (
              <CreditsPanel credential={liveDetail} now={coarseNow / 1000} />
            )}
            {detail.tab === "tasks" && (
              <Panel title="自动任务与日常维护">
                <p className={s.subtle}>
                  自动任务按账号保存：国内默认签到后旅行，国际默认关闭。开关分别生效；余额同步不触发领取，关闭开关不撤回已发送的请求。
                </p>
                {renderAutomationPanel(liveDetail)}
                <div className={s.rowActions}>
                  <Button
                    size="sm"
                    disabled={busy || liveDetail.enabled !== true}
                    onClick={() => maintain("checkin", liveDetail)}
                  >
                    {liveDetail.auto_travel === true ? "签到并旅行" : "签到"}
                  </Button>
                  {liveDetail.travel_supported === true && (
                    <>
                      <Button
                        size="sm"
                        disabled={busy || liveDetail.enabled !== true}
                        onClick={() => maintain("travel-status", liveDetail)}
                      >
                        旅行状态
                      </Button>
                      <Button
                        size="sm"
                        disabled={busy || liveDetail.enabled !== true}
                        onClick={() => maintain("travel", liveDetail)}
                      >
                        旅行领派
                      </Button>
                    </>
                  )}
                  {liveDetail.daily_chat_supported === true && (
                    <Button
                      size="sm"
                      disabled={busy || liveDetail.enabled !== true}
                      onClick={() => maintain("daily-chat", liveDetail)}
                    >
                      活跃打卡
                    </Button>
                  )}
                  {liveDetail.trial_supported === true && (
                    <Button
                      size="sm"
                      disabled={busy || liveDetail.enabled !== true}
                      onClick={() => setTrialTarget(liveDetail)}
                    >
                      领取体验积分
                    </Button>
                  )}
                </div>
              </Panel>
            )}
            {detail.tab === "cooldowns" && (
              <Panel title="模型绑定与 429 冷却">
                <div className={s.binding}>
                  <span>绑定模型规则</span>
                  <strong>
                    {Array.isArray(liveDetail.bindings) && liveDetail.bindings.length
                      ? liveDetail.bindings.map(text).join("、")
                      : "无专属绑定（参与公共选路）"}
                  </strong>
                </div>
                <div className={s.rowActions}>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => maintain("reset-cooldown", liveDetail)}
                  >
                    清除全部冷却
                  </Button>
                </div>
              </Panel>
            )}
            {detail.tab === "raw" && <Fields data={liveDetail} />}
          </Drawer>
        )}
      </DrawerPresence>
      <DrawerPresence>
        {deleting && (
          <Drawer
            title="删除凭证"
            closeLabel={t("common.closeDrawer")}
            dismissDisabled={busy}
            onClose={() => setDeleting(null)}
          >
            <div className={s.warning}>
              <Icon name="alert" size="sm" />
              <div>
                将永久删除 {deleting.name}，不可撤销。
                {deleting.bindings === undefined ? (
                  "如已绑定模型规则，请先解除绑定。"
                ) : boundModels(deleting).length ? (
                  <>
                    该凭证仍被模型规则引用：{boundModels(deleting).join("、")}。
                    确认后将自动解除这些绑定，规则回退为自动选择账号。
                  </>
                ) : (
                  "该凭证未被模型规则引用。"
                )}
              </div>
            </div>
            <ErrorNotice message={error} />
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                run(() =>
                  api.delete(
                    "/credentials/" +
                      encodeURIComponent(deleting.name!) +
                      (boundModels(deleting).length ? "?unbind=1" : ""),
                  ),
                )
              }
            >
              {boundModels(deleting).length ? "解除绑定并删除凭证" : "确认删除凭证"}
            </Button>
          </Drawer>
        )}
      </DrawerPresence>
      <DrawerPresence>
        {drawer === "export" && (
          <Drawer
            title="导出明文凭证"
            closeLabel={t("common.closeDrawer")}
            dismissDisabled={busy}
            onClose={() => setDrawer(null)}
          >
            <div className={s.warning}>
              <Icon name="alert" size="sm" />
              <div>
                <strong>文件包含明文认证信息</strong>
                <p>
                  将导出 {liveSelected.length}{" "}
                  个凭证，他人可能借此使用账号。请仅保存在可信设备，勿分享或公开上传。
                </p>
              </div>
            </div>
            <ErrorNotice message={error} />
            <Button
              variant="danger"
              disabled={busy || !liveSelected.length}
              onClick={() => {
                setBusy(true);
                setError(null);
                void api
                  .post<Blob>(
                    "/credentials/export",
                    { ids: liveSelected, confirm: true },
                    { responseType: "blob" },
                  )
                  .then((response) => {
                    if (!response.data.size) throw new Error("导出响应为空");
                    const type = String(response.headers["content-type"] ?? "");
                    if (type.includes("json") || type.includes("html"))
                      throw new Error("导出响应不是凭证附件");
                    const url = URL.createObjectURL(response.data);
                    const link = document.createElement("a");
                    link.href = url;
                    const header = String(response.headers["content-disposition"] ?? "");
                    link.download = downloadFilename(
                      header,
                      liveSelected.length === 1 ? "credential.info" : "credentials.zip",
                    );
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                    setDrawer(null);
                  })
                  .catch((err: unknown) => setError(errorMessage(err)))
                  .finally(() => setBusy(false));
              }}
            >
              我理解明文风险，下载已选凭证
            </Button>
          </Drawer>
        )}
      </DrawerPresence>
    </Page>
  );
}
