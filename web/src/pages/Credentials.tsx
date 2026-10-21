import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { OAuth } from "../OAuth";
import { countdownText, useCoarseNow, useNow, useOptimisticOverrides } from "../hooks";
import { fusionMutate } from "../fusion/client";
import { Trial } from "../Trial";
import { TravelSummary } from "../Travel";
import { Buddy, buddyConfirmation } from "../Buddy";
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
  DataValue,
  Drawer,
  DrawerPresence,
  Empty,
  ErrorNotice,
  Fields,
  Icon,
  PageTitle,
  Panel,
  ResourceState,
  profileLabel,
} from "../components";
import { prepareImports, type ImportResult } from "../imports";
import { downloadFilename } from "../downloads";
import { useDateFormat } from "../i18n";
import s from "../ui.module.scss";

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
  credential_error: "凭证同步失败（详见操作结果）",
};

function lastErrorLabel(value: unknown) {
  const key = text(value);
  return lastErrorLabels[key] ?? key;
}

export { safeOAuthUrl } from "../OAuth";

function boundModels(credential: Credential): string[] {
  return Array.isArray(credential.bindings)
    ? credential.bindings.filter((id): id is string => typeof id === "string")
    : [];
}

function ImportDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [results, setResults] = useState<ImportResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Drawer title="导入凭证" onClose={onClose} dismissDisabled={busy}>
      <p className={s.note}>
        支持 UTF-8 .info 或 ZIP，ZIP 仅接受根目录 .info。单项 ≤ 1 MiB，每批 ≤ 100 项 / 32
        MiB，不覆盖现有文件。
      </p>
      <label className={s.upload}>
        选择 .info 或 ZIP
        <input
          type="file"
          accept=".info,.zip"
          multiple
          disabled={busy}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (!files.length) return;
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
          }}
        />
      </label>
      {busy && <p role="status">正在检查并上传，请勿关闭…</p>}
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

function MaintenanceResults({ results }: { results: Record<string, unknown>[] }) {
  return (
    <Panel title="凭证操作结果">
      <ul className={s.operationResults} aria-live="polite">
        {results.map((r, i) => {
          const complete =
            r.ok === true &&
            !(r.travel && typeof r.travel === "object" && object(r.travel).ok === false);
          return (
            <li key={i}>
              <strong>{text(r.name)}</strong>
              <Badge tone={complete ? "good" : "warn"}>
                {complete
                  ? "已完成"
                  : r.checkin_ok === true ||
                      r.claimed === true ||
                      r.departed === true ||
                      r.buddy_claimed === true ||
                      r.agreement_accepted === true ||
                      (r.travel &&
                        typeof r.travel === "object" &&
                        (object(r.travel).claimed === true || object(r.travel).departed === true))
                    ? "部分完成"
                    : r.skipped
                      ? "已跳过"
                      : "未完成"}
              </Badge>
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
          );
        })}
      </ul>
    </Panel>
  );
}

type ChannelKey = "all" | "cn" | "intl" | "enterprise";
type ViewMode = "cards" | "list";
type StatusFilter = "all" | "ready" | "issue" | "disabled";
type DetailTab = "overview" | "tasks" | "cooldowns" | "raw";

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
 * Live "认证熔断 m:ss" badge for one credential.
 *
 * The page root used to hold the clock, so every tick re-rendered the channel
 * summary cards, the whole filtered account list and the pager — and re-ran the
 * filter over every account. Subscribing here instead confines a tick to the one
 * badge that actually changes, and the subscription drops out entirely when the
 * deadline is absent or already in the past.
 */
function BreakerCountdown({ failUntil, health }: { failUntil: number | null; health: string }) {
  const live = failUntil !== null && failUntil > 0;
  const now = useNow(live);
  // A deadline already in the past means the breaker lifted and must not keep
  // showing a stale 0:00 badge (upstream leaves the timestamp behind).
  const cooling = live && Math.ceil(failUntil - now / 1000) > 0;
  return (
    <Badge tone={cooling ? "bad" : health === "ready" ? "good" : "warn"}>
      {cooling
        ? `认证熔断 ${countdownText(failUntil, "", now)}`
        : health === "ready"
          ? "认证正常"
          : health}
    </Badge>
  );
}

/**
 * Compact "model · m:ss" cooldown text, ticking on the shared clock.
 *
 * `fallback` is the backend's own remaining-seconds figure: it is what renders
 * before the first tick arrives, and it is what keeps a cooldown readable when the
 * `until` deadline is missing.
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
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={s.moreMenu} ref={ref}>
      <button
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(!open)}
      >
        {title}
      </button>
      {open && (
        <div className={s.moreMenuList} role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Credentials() {
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
  const [notice, setNotice] = useState<string | null>(null);
  const [maintenance, setMaintenance] = useState<Record<string, unknown>[]>([]);
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
      .get(`/logs?credential=${encodeURIComponent(detailKey)}&limit=8`)
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
  const maintain = (
    action:
      | "refresh"
      | "checkin"
      | "sync"
      | "travel"
      | "travel-status"
      | "daily-chat"
      | "reset-cooldown",
    credential?: Credential,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMaintenance([]);
    const path = credential
      ? `/credentials/${encodeURIComponent(credential.id)}/${action}`
      : `/${action}`;
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
        setMaintenance(results);
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
        setError(`${errorMessage(err)}；请求失败不代表后台已停止，请刷新列表核验。`),
      )
      .finally(() => {
        setBusy(false);
        resource.reload();
      });
  };
  const oauthDone = useCallback(() => {
    setDrawer(null);
    setNotice("授权完成，凭证已添加。");
    resource.reload();
  }, [resource.reload]);
  // No page-root clock: this page used to call useNow() here, which re-rendered
  // the channel summary cards, the whole filtered list and the pager once a second
  // (and re-ran the filter over every account each time). Countdown text is now
  // produced by <BreakerCountdown> / <ModelCooldownText>, which subscribe to the
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
    void fusionMutate("PATCH", `/admin/credentials/${encodeURIComponent(credential.id)}`, {
      paused,
    })
      .then(() => {
        setNotice(
          paused
            ? "账号已暂停：不再参与选号，保留在池中。"
            : "账号已恢复运行，后续请求按规则选用。",
        );
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
  const preference = (
    credential: Credential,
    field: "auto_checkin" | "auto_travel" | "auto_daily_chat",
    enabled: boolean,
  ) => {
    // Flip the switch immediately; the overlay is cleared when the write confirms
    // (reload) or rolls back (run's catch).
    optimistic.apply(credential.id, { [field]: enabled });
    run(async () => {
      const response = await api.patch(`/credentials/${encodeURIComponent(credential.id)}`, {
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
            : "自动活跃打卡";
      setNotice(`${label}已${enabled ? "开启" : "关闭"}；保存不会立即执行，后续维护按新设置执行。`);
    }, credential.id);
  };
  const [channel, setChannel] = useState<ChannelKey>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<ViewMode>(savedViewMode);
  const [pageSize, setPageSize] = useState<number>(savedPageSize);
  const [page, setPage] = useState(1);
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
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const liveSelected = selected.filter((id) => allItems.some((c) => c.id === id));
  const channelDefs: [ChannelKey, string, string][] = [
    ["all", "全部账号", "个人区域与企业账号汇总"],
    ["cn", "国内区域", "国内 CodeBuddy · WorkBuddy"],
    ["intl", "国际区域", "国际 CodeBuddy · WorkBuddy"],
    ["enterprise", "企业账号", "独立归类 · 不按区域拆分"],
  ];
  const renderSyncIcon = (c: Credential) => (
    <button
      type="button"
      className={s.iconBtn}
      disabled={busy || c.enabled !== true}
      aria-label={`同步余额 ${c.name ?? c.id}`}
      title="同步余额"
      onClick={() => maintain("sync", c)}
    >
      <Icon name="refresh" />
    </button>
  );
  const renderActions = (c: Credential) => {
    const enabledTasks = [
      c.auto_checkin === true && "签到",
      c.travel_supported === true && c.auto_travel === true && "旅行",
      c.daily_chat_supported === true && c.auto_daily_chat === true && "打卡",
    ].filter(Boolean);
    return (
      <div className={s.rowActions}>
        <button onClick={() => openDetail(c, "overview")}>详情</button>
        <button aria-label={`任务配置 ${c.name ?? c.id}`} onClick={() => openDetail(c, "tasks")}>
          任务配置{enabledTasks.length ? ` (${enabledTasks.length})` : ""}
        </button>
        <MoreMenu label={`更多 ${c.name ?? c.id}`}>
          <button
            disabled={busy || c.enabled !== true}
            aria-label={`刷新凭证 ${c.name ?? c.id}`}
            onClick={() => maintain("refresh", c)}
          >
            刷新 Token
          </button>
          <button
            disabled={busy || c.enabled !== true}
            aria-label={`签到 ${c.name ?? c.id}`}
            onClick={() => maintain("checkin", c)}
          >
            {c.auto_travel === true ? "签到并旅行" : "签到"}
          </button>
          {/* Not gated on displayed cooldowns or on enablement: a reset that failed
            to persist must stay retryable, and a disabled account can still hold
            a stale cooldown worth clearing. */}
          <button
            disabled={busy}
            aria-label={`清除冷却 ${c.name ?? c.id}`}
            onClick={() => maintain("reset-cooldown", c)}
          >
            清除冷却
          </button>
          {c.trial_supported === true && (
            <button
              disabled={busy || c.enabled !== true}
              aria-label={`领取体验积分 ${c.name ?? c.id}`}
              onClick={() => setTrialTarget(c)}
            >
              领取体验积分
            </button>
          )}
          {c.daily_chat_supported === true && (
            <button
              disabled={busy || c.enabled !== true}
              aria-label={`活跃打卡 ${c.name ?? c.id}`}
              onClick={() => maintain("daily-chat", c)}
            >
              活跃打卡
            </button>
          )}
          {c.travel_supported === true && (
            <>
              <button
                disabled={busy || c.enabled !== true}
                aria-label={`旅行状态 ${c.name ?? c.id}`}
                onClick={() => maintain("travel-status", c)}
              >
                旅行状态
              </button>
              <button
                disabled={busy || c.enabled !== true}
                aria-label={`旅行领派 ${c.name ?? c.id}`}
                onClick={() => maintain("travel", c)}
              >
                旅行领派
              </button>
            </>
          )}
        </MoreMenu>
        <button className={s.textDanger} disabled={!c.name || busy} onClick={() => setDeleting(c)}>
          删除
        </button>
      </div>
    );
  };
  const renderEnableSwitch = (c: Credential) => (
    <>
      <label className={s.enableSwitch}>
        <input
          type="checkbox"
          role="switch"
          aria-label={`启用状态 ${c.name ?? c.id}`}
          checked={c.enabled === true}
          disabled={busy || typeof c.enabled !== "boolean"}
          onChange={() =>
            run(() =>
              api.patch(`/credentials/${encodeURIComponent(c.id)}`, {
                enabled: !c.enabled,
              }),
            )
          }
        />
        <span>{c.enabled === true ? "已启用" : c.enabled === false ? "人工停用" : "未知"}</span>
      </label>
      {/* Fusion increment: paused is orthogonal to enabled — pausing only leaves
          credential selection while check-in / travel / keepalive keep running.
          The row *does* carry the authoritative flag: the admin whitelist
          (app/admin_api.py:74) keeps "paused" and pool.snapshot()
          (converter.py:1942) fills it, so the switch reads c.paused and nothing
          else. Deriving it from enabled made an externally paused account show
          "运行中" after a refresh, and made a disabled-but-not-paused account
          show "已暂停". Unknown (missing) is not paused. */}
      <label className={s.enableSwitch}>
        <input
          type="checkbox"
          role="switch"
          aria-label={`暂停账号 ${c.name ?? c.id}`}
          checked={c.paused === true}
          // Deliberately not gated on the field being present: a row that omits
          // it must stay operable (the write itself is authoritative), and a
          // missing flag reads as "not paused" rather than blocking the switch.
          disabled={busy}
          onChange={(e) => togglePaused(c, e.target.checked)}
        />
        <span>{c.paused === true ? "已暂停" : c.paused === false ? "运行中" : "未知"}</span>
      </label>
    </>
  );
  const renderHealthBadge = (c: Credential) => (
    // A live breaker ticks once a second, but only that badge re-renders: the
    // countdown is its own clock subscriber (see BreakerCountdown), instead of the
    // page root subscribing and re-rendering every card and the whole pager.
    <BreakerCountdown failUntil={number(c.fail_until)} health={text(c.health)} />
  );
  const renderSyncAndCatalog = (c: Credential) => {
    const cooldowns = Array.isArray(c.cooldowns) ? list(c.cooldowns) : null;
    const trip = c.travel && typeof c.travel === "object" ? object(c.travel) : null;
    return (
      <>
        <strong>
          {c.sync_pending === true
            ? "目录同步中"
            : c.catalog_ready === true
              ? "目录已就绪"
              : "目录状态待确认"}
        </strong>
        <div className={s.credSyncTags}>
          <small>{c.token_expired === true ? "Token 已过期" : "同步正常"}</small>
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
            <DataValue value={c.model_cooldowns} />
          ) : null}
        </div>
        {c.last_error_code != null && (
          <small>
            最近错误：{text(lastErrorLabel(c.last_error_code))}
            {number(c.last_failure_at) !== null
              ? ` · ${expiry(c.last_failure_at, format.dateTime)}`
              : ""}
          </small>
        )}
        {typeof c.sync_error === "string" && c.sync_error !== "" && (
          <small>失败原因：{text(c.sync_error)}</small>
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
            <strong>{rate !== null ? `${(rate * 100).toFixed(1)}%` : "—"}</strong>
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
      <div className={s.credUsageBox}>
        <div>
          <span>累计请求</span>
          <strong>{compact(reqs)}</strong>
          <small>{rate !== null ? `成功率 ${(rate * 100).toFixed(1)}%` : "暂无请求记录"}</small>
        </div>
        <div>
          <span>总 Token</span>
          <strong>{totalTokens !== null ? compact(totalTokens) : "0"}</strong>
          <small>缓存 {cacheTokens !== null ? compact(cacheTokens) : "0"}</small>
        </div>
        <div>
          <span>Credit 消耗</span>
          <strong>{credit !== null ? metric(credit) : "0"}</strong>
          <small>{avgMs !== null ? `平均耗时 ${(avgMs / 1000).toFixed(1)}s` : "耗时 —"}</small>
        </div>
        <div>
          <span>最近调用</span>
          <strong>{stats?.last_model ? text(stats.last_model) : "—"}</strong>
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
      <div className={s.credCardTasks}>
        <div className={s.credTaskRow}>
          <label className={s.check}>
            <input
              type="checkbox"
              role="switch"
              aria-label={`自动签到 ${c.name ?? c.id}`}
              checked={c.auto_checkin === true}
              disabled={busy || typeof c.auto_checkin !== "boolean"}
              onChange={(e) => preference(c, "auto_checkin", e.target.checked)}
            />
            自动签到
          </label>
          <small>
            上次签到{checkin?.date ? `（${text(checkin.date)}）` : ""}：
            {checkin ? text(checkin.message) : "尚未查询"}
          </small>
        </div>
        <div className={s.credTaskRow}>
          <label className={s.check}>
            <input
              type="checkbox"
              role="switch"
              aria-label={`自动旅行 ${c.name ?? c.id}`}
              checked={c.auto_travel === true}
              disabled={busy || c.travel_supported !== true || typeof c.auto_travel !== "boolean"}
              onChange={(e) => preference(c, "auto_travel", e.target.checked)}
            />
            自动旅行
          </label>
          <small>
            {c.travel_supported === true
              ? `上次旅行：${trip ? text(trip.message) : "尚未查询"}`
              : isEnterprise(c)
                ? "企业账号不参与成长中心，无法旅行"
                : "旅行仅适用于国内账号"}
          </small>
        </div>
        <div className={s.credTaskRow}>
          <label className={s.check}>
            <input
              type="checkbox"
              role="switch"
              aria-label={`自动活跃打卡 ${c.name ?? c.id}`}
              checked={c.auto_daily_chat === true}
              disabled={
                busy || c.daily_chat_supported !== true || typeof c.auto_daily_chat !== "boolean"
              }
              onChange={(e) => preference(c, "auto_daily_chat", e.target.checked)}
            />
            自动活跃打卡
          </label>
          <small>
            {c.daily_chat_supported === true
              ? `今日打卡：${dailyChat ? text(dailyChat.message) : "尚未执行"}`
              : "活跃打卡仅适用于国际 WorkBuddy 账号"}
          </small>
        </div>
        {dailyChat?.acp_usage != null && (
          <small>本次会话成本：{text(dailyChat.acp_usage)} 积分</small>
        )}
        {trip?.stale === true && <small>状态可能已变化，请先查询核验</small>}
        {c.travel_supported === true && <TravelSummary trip={trip} />}
        {c.enabled === false && <small>账号停用期间不执行自动任务</small>}
        {c.trial_supported === true && c.trial != null && (
          <small>体验积分：{text(object(c.trial).message)}</small>
        )}
      </div>
    );
  };
  return (
    <>
      <PageTitle
        title="凭证管理"
        actions={
          <>
            <button onClick={resource.reload}>
              <Icon name="refresh" />
              刷新列表
            </button>
            <button disabled={busy} onClick={() => maintain("sync")}>
              同步全部余额
            </button>
            <MoreMenu label="批量操作" title="批量操作">
              <button disabled={busy} onClick={() => maintain("checkin")}>
                批量签到
              </button>
              <button onClick={() => setDrawer("import")}>导入文件</button>
              <button disabled={!liveSelected.length} onClick={() => setDrawer("export")}>
                导出已选 ({liveSelected.length})
              </button>
            </MoreMenu>
            <button className={s.primary} onClick={() => setDrawer("oauth")}>
              <Icon name="key" />
              添加凭证
            </button>
          </>
        }
      />
      {!detail && notice && (
        <p className={s.successNotice} role="status">
          {notice}
        </p>
      )}
      {!detail && busy && <p role="status">操作执行中，请勿重复提交…</p>}
      <ResourceState {...resource} />
      {!detail && <ErrorNotice message={error} />}
      {resource.data && (
        <div className={s.channelGrid} role="group" aria-label="区域与账号类型筛选">
          {channelDefs.map(([key, label, hint]) => {
            const group = key === "all" ? allItems : allItems.filter((c) => channelOf(c) === key);
            const ready = group.filter(isReady).length;
            let totalCredits = 0;
            let hasNumeric = false;
            let unlimited = 0;
            for (const item of group) {
              const bal =
                item.credits && typeof item.credits === "object" ? object(item.credits) : null;
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
            const active = channel === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={active}
                className={`${s.channelCard} ${active ? s.channelActive : ""}`}
                onClick={() => {
                  setChannel(active && key !== "all" ? "all" : key);
                  setPage(1);
                }}
              >
                <div className={s.channelHead}>
                  <span>{label}</span>
                  <span>
                    {ready} / {group.length} 就绪
                  </span>
                </div>
                <strong title={hasNumeric ? metric(totalCredits) : undefined}>
                  {hasNumeric ? compact(totalCredits) : unlimited > 0 ? "无限" : `${group.length}`}
                </strong>
                <small>
                  {hasNumeric
                    ? `${group.length} 个账号 · 剩余额度${unlimited ? ` (+${unlimited} 无限)` : ""}`
                    : `${group.length} 个账号 · ${hint}`}
                </small>
                <div className={s.channelBar} aria-hidden="true">
                  <i style={{ width: `${group.length ? (ready / group.length) * 100 : 0}%` }} />
                </div>
              </button>
            );
          })}
        </div>
      )}
      {!detail && maintenance.length > 0 && <MaintenanceResults results={maintenance} />}
      <Panel
        title="账号凭证"
        hint={
          resource.data
            ? filtered.length === allItems.length
              ? `${allItems.length} 个账号`
              : `筛选 ${filtered.length} / ${allItems.length} 个账号`
            : "等待凭证列表"
        }
      >
        <div className={s.credFilterBar}>
          <div className={s.credFilterLeft}>
            <label className={s.check}>
              <input
                aria-label="选择全部凭证"
                type="checkbox"
                checked={allItems.length > 0 && liveSelected.length === allItems.length}
                onChange={(e) => setSelected(e.target.checked ? allItems.map((c) => c.id) : [])}
              />
              全选
            </label>
            <input
              className={s.credSearch}
              aria-label="搜索凭证"
              placeholder="搜索账号文件名、昵称或 UID…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
            <div className={s.statusPills} role="group" aria-label="状态筛选">
              {(
                [
                  ["all", "全部"],
                  ["ready", "就绪"],
                  ["issue", "冷却 / 异常"],
                  ["disabled", "已停用"],
                ] as [StatusFilter, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={statusFilter === key}
                  className={statusFilter === key ? s.pillActive : ""}
                  onClick={() => {
                    setStatusFilter(key);
                    setPage(1);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {liveSelected.length > 0 && (
              <button onClick={() => setDrawer("export")}>导出已选 ({liveSelected.length})</button>
            )}
          </div>
          <div className={s.viewSwitch} role="group" aria-label="视图切换">
            <button
              type="button"
              aria-pressed={view === "cards"}
              className={view === "cards" ? s.viewActive : ""}
              onClick={() => chooseView("cards")}
            >
              卡片视图
            </button>
            <button
              type="button"
              aria-pressed={view === "list"}
              className={view === "list" ? s.viewActive : ""}
              onClick={() => chooseView("list")}
            >
              列表视图
            </button>
          </div>
        </div>
        {resource.data &&
          (filtered.length ? (
            <>
              {view === "cards" ? (
                <div className={s.credCardGrid} role="table" aria-label="账号凭证卡片">
                  {paged.map((raw) => {
                    // Fusion increment: apply the optimistic overlay (paused/enabled
                    // writes) on top of the authoritative list; reloads reconcile it.
                    const c = optimistic.view(raw);
                    const balance =
                      c.credits && typeof c.credits === "object" ? object(c.credits) : null;
                    return (
                      <article key={c.id} className={s.credCard} role="row">
                        <div className={s.credCardHead}>
                          <div className={s.credCardTitle}>
                            <input
                              aria-label={`选择 ${c.name ?? c.id}`}
                              type="checkbox"
                              checked={liveSelected.includes(c.id)}
                              onChange={(e) =>
                                setSelected(
                                  e.target.checked
                                    ? [...selected, c.id]
                                    : selected.filter((id) => id !== c.id),
                                )
                              }
                            />
                            <div>
                              <strong>{c.name ?? "安全文件名不可用"}</strong>
                              <small>
                                {isEnterprise(c)
                                  ? `企业账号 · ${profileLabel(text(c.profile))}`
                                  : profileLabel(text(c.profile))}{" "}
                                · {text(c.nickname ?? c.uid)}
                              </small>
                            </div>
                          </div>
                          <div className={s.credCardBadges}>
                            {renderHealthBadge(c)}
                            {renderEnableSwitch(c)}
                          </div>
                        </div>
                        <div className={s.credCardStats}>
                          <div>
                            <div className={s.credStatHead}>
                              <span>官方余额 / 到期</span>
                              {renderSyncIcon(c)}
                            </div>
                            <strong role="cell">
                              {balance
                                ? balance.unlimited && balance.enterprise
                                  ? "无限"
                                  : metric(balance.credits ?? balance.remaining)
                                : "未知"}
                            </strong>
                            <small>
                              {c.token_expires_at !== undefined
                                ? expiry(c.token_expires_at, format.dateTime, true)
                                : c.expiresAt !== undefined
                                  ? expiry(c.expiresAt, format.dateTime, true)
                                  : expiry(
                                      c.expires_at ?? balance?.soonest_expiry,
                                      format.dateTime,
                                    )}
                            </small>
                          </div>
                          <div>
                            <span>目录与同步状态</span>
                            {renderSyncAndCatalog(c)}
                          </div>
                        </div>
                        {renderUsageBlock(c)}
                        <div className={s.credCardFoot}>{renderActions(c)}</div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className={s.tableWrap}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col"></th>
                        <th scope="col">凭证 / 产品</th>
                        <th scope="col">目录与同步状态</th>
                        <th scope="col">官方余额 / 到期</th>
                        <th scope="col">请求与用量</th>
                        <th scope="col">认证与启用</th>
                        <th scope="col">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paged.map((raw) => {
                        // Fusion increment: same optimistic overlay as the card view.
                        const c = optimistic.view(raw);
                        const balance =
                          c.credits && typeof c.credits === "object" ? object(c.credits) : null;
                        return (
                          <tr key={c.id}>
                            <td>
                              <input
                                aria-label={`选择 ${c.name ?? c.id}`}
                                type="checkbox"
                                checked={liveSelected.includes(c.id)}
                                onChange={(e) =>
                                  setSelected(
                                    e.target.checked
                                      ? [...selected, c.id]
                                      : selected.filter((id) => id !== c.id),
                                  )
                                }
                              />
                            </td>
                            <td>
                              <strong>{c.name ?? "安全文件名不可用"}</strong>
                              <small>
                                {isEnterprise(c)
                                  ? `企业账号 · ${profileLabel(text(c.profile))}`
                                  : profileLabel(text(c.profile))}{" "}
                                · {text(c.nickname ?? c.uid)}
                              </small>
                            </td>
                            <td>{renderSyncAndCatalog(c)}</td>
                            <td>
                              <div className={s.credStatHead}>
                                <strong>
                                  {balance
                                    ? balance.unlimited && balance.enterprise
                                      ? "无限"
                                      : metric(balance.credits ?? balance.remaining)
                                    : "未知"}
                                </strong>
                                {renderSyncIcon(c)}
                              </div>
                              <small>
                                {c.token_expires_at !== undefined
                                  ? expiry(c.token_expires_at, format.dateTime, true)
                                  : c.expiresAt !== undefined
                                    ? expiry(c.expiresAt, format.dateTime, true)
                                    : expiry(
                                        c.expires_at ?? balance?.soonest_expiry,
                                        format.dateTime,
                                      )}
                              </small>
                            </td>
                            <td>{renderUsageBlock(c, true)}</td>
                            <td>
                              <div className={s.credCardBadges}>
                                {renderHealthBadge(c)}
                                {renderEnableSwitch(c)}
                              </div>
                            </td>
                            <td>{renderActions(c)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className={s.credPager}>
                <span>
                  第 {(safePage - 1) * pageSize + 1}–
                  {Math.min(filtered.length, safePage * pageSize)} 条 · 共 {filtered.length} 个账号
                </span>
                <div className={s.credPagerRight}>
                  <select
                    aria-label="每页显示数量"
                    value={pageSize}
                    onChange={(e) => choosePageSize(Number(e.target.value))}
                  >
                    {PAGE_SIZES.map((n) => (
                      <option key={n} value={n}>
                        {n} / 页
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => setPage(Math.max(1, safePage - 1))}
                  >
                    上一页
                  </button>
                  <span>
                    第 {safePage} / {totalPages} 页
                  </span>
                  <button
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage(Math.min(totalPages, safePage + 1))}
                  >
                    下一页
                  </button>
                </div>
              </div>
            </>
          ) : (
            <Empty title={allItems.length ? "没有匹配的凭证" : "还没有凭证"}>
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
              setMaintenance([result]);
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
            title={`凭证详情 · ${liveDetail.name ?? liveDetail.id}`}
            onClose={() => setDetail(null)}
          >
            {notice && (
              <p className={s.successNotice} role="status">
                {notice}
              </p>
            )}
            {busy && <p role="status">操作执行中，请勿重复提交…</p>}
            <ErrorNotice message={error} />
            {maintenance.length > 0 && <MaintenanceResults results={maintenance} />}
            <div className={s.detailBar}>
              <div className={s.credCardBadges}>
                {renderHealthBadge(liveDetail)}
                {renderEnableSwitch(liveDetail)}
              </div>
              <div className={s.rowActions}>
                {renderSyncIcon(liveDetail)}
                <button
                  disabled={busy || liveDetail.enabled !== true}
                  onClick={() => maintain("refresh", liveDetail)}
                >
                  刷新 Token
                </button>
              </div>
            </div>
            <div className={s.tabs} role="tablist" aria-label="凭证详情分区">
              {(
                [
                  ["overview", "概览与请求"],
                  ["tasks", "自动化配置"],
                  ["cooldowns", "绑定与冷却"],
                  ["raw", "原始诊断"],
                ] as [DetailTab, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={detail.tab === key}
                  className={detail.tab === key ? s.selectedTab : ""}
                  onClick={() => setDetail({ credential: liveDetail, tab: key })}
                >
                  {label}
                </button>
              ))}
            </div>
            {detail.tab === "overview" && (
              <>
                <Panel title="请求与用量概览">
                  <div className={s.panelBody}>{renderUsageBlock(liveDetail)}</div>
                </Panel>
                <Panel title="目录与同步状态">
                  <div className={s.panelBody}>{renderSyncAndCatalog(liveDetail)}</div>
                </Panel>
                <Panel title="最近请求记录">
                  <div className={s.panelBody}>
                    {detailLogs === null ? (
                      <small>正在加载请求记录…</small>
                    ) : detailLogs.length ? (
                      <div className={s.tableWrap}>
                        <table>
                          <thead>
                            <tr>
                              <th scope="col">时间</th>
                              <th scope="col">模型</th>
                              <th scope="col">状态</th>
                              <th scope="col">Token</th>
                              <th scope="col">Credit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {detailLogs.map((log, i) => (
                              <tr key={typeof log.id === "string" ? log.id : i}>
                                <td>{expiry(log.started_at, format.dateTime)}</td>
                                <td>{text(log.public_model ?? log.model)}</td>
                                <td>
                                  <Badge tone={log.outcome === "success" ? "good" : "warn"}>
                                    {text(log.status_code ?? log.outcome)}
                                  </Badge>
                                </td>
                                <td>{compact(log.total_tokens)}</td>
                                <td>{metric(log.credit)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty title="暂无该凭证的请求明细" />
                    )}
                  </div>
                </Panel>
              </>
            )}
            {detail.tab === "tasks" && (
              <Panel title="自动任务与日常维护">
                <div className={s.panelBody}>
                  <p className={s.storageSubtle}>
                    自动任务按账号保存：国内默认签到后旅行，国际默认关闭。开关分别生效；余额同步不触发领取，关闭开关不撤回已发送的请求。
                  </p>
                  {renderAutomationPanel(liveDetail)}
                  <div className={s.rowActions}>
                    <button
                      disabled={busy || liveDetail.enabled !== true}
                      onClick={() => maintain("checkin", liveDetail)}
                    >
                      {liveDetail.auto_travel === true ? "签到并旅行" : "签到"}
                    </button>
                    {liveDetail.travel_supported === true && (
                      <>
                        <button
                          disabled={busy || liveDetail.enabled !== true}
                          onClick={() => maintain("travel-status", liveDetail)}
                        >
                          旅行状态
                        </button>
                        <button
                          disabled={busy || liveDetail.enabled !== true}
                          onClick={() => maintain("travel", liveDetail)}
                        >
                          旅行领派
                        </button>
                      </>
                    )}
                    {liveDetail.daily_chat_supported === true && (
                      <button
                        disabled={busy || liveDetail.enabled !== true}
                        onClick={() => maintain("daily-chat", liveDetail)}
                      >
                        活跃打卡
                      </button>
                    )}
                    {liveDetail.trial_supported === true && (
                      <button
                        disabled={busy || liveDetail.enabled !== true}
                        onClick={() => setTrialTarget(liveDetail)}
                      >
                        领取体验积分
                      </button>
                    )}
                  </div>
                </div>
              </Panel>
            )}
            {detail.tab === "cooldowns" && (
              <Panel title="模型绑定与 429 冷却">
                <div className={s.panelBody}>
                  <div className={s.details}>
                    <div>
                      <span>绑定模型规则</span>
                      <strong>
                        {Array.isArray(liveDetail.bindings) && liveDetail.bindings.length
                          ? liveDetail.bindings.map(text).join("、")
                          : "无专属绑定（参与公共选路）"}
                      </strong>
                    </div>
                  </div>
                  <div className={s.rowActions}>
                    <button disabled={busy} onClick={() => maintain("reset-cooldown", liveDetail)}>
                      清除全部冷却
                    </button>
                  </div>
                </div>
              </Panel>
            )}
            {detail.tab === "raw" && <Fields data={liveDetail} />}
          </Drawer>
        )}
      </DrawerPresence>
      <DrawerPresence>
        {deleting && (
          <Drawer title="删除凭证" onClose={() => setDeleting(null)} dismissDisabled={busy}>
            <div className={s.warning}>
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
            <ErrorNotice message={error} />
            <button
              className={s.danger}
              disabled={busy}
              onClick={() =>
                run(() =>
                  api.delete(
                    `/credentials/${encodeURIComponent(deleting.name!)}${
                      boundModels(deleting).length ? "?unbind=1" : ""
                    }`,
                  ),
                )
              }
            >
              {boundModels(deleting).length ? "解除绑定并删除凭证" : "确认删除凭证"}
            </button>
          </Drawer>
        )}
      </DrawerPresence>
      <DrawerPresence>
        {drawer === "export" && (
          <Drawer title="导出明文凭证" onClose={() => setDrawer(null)} dismissDisabled={busy}>
            <div className={s.warning}>
              <Icon name="alert" />
              <div>
                <strong>文件包含明文认证信息</strong>
                <p>
                  将导出 {liveSelected.length}{" "}
                  个凭证，他人可能借此使用账号。请仅保存在可信设备，勿分享或公开上传。
                </p>
              </div>
            </div>
            <ErrorNotice message={error} />
            <button
              className={s.danger}
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
            </button>
          </Drawer>
        )}
      </DrawerPresence>
    </>
  );
}
