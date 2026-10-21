import { useMemo, useState } from "react";
import { object, text } from "../api";
import { t, useT } from "../i18n";
import {
  Badge,
  Countdown,
  Empty,
  ErrorNotice,
  Icon,
  PageTitle,
  Panel,
  Skeleton,
} from "../components";
import { profileLabel } from "../values";
import { FreshnessHint } from "../components";
import { useNow } from "../hooks";
import { useFusionResource } from "../fusion/client";
import { FUSION_DEVELOPMENT } from "../fusion/client";
import type {
  DiagnosticAccount,
  DiagnosticResponse,
  ModelLock,
  ServiceStatus,
} from "../fusion/types";
import { DataTable, type DataTableColumn, type SortingState } from "../dataTable";
import s from "../ui.module.scss";

function normalizeStatus(value: unknown): ServiceStatus {
  const data = object(value, t("fusion.diagnostics.statusContext"));
  if (typeof data.service !== "string")
    throw new Error(t("fusion.diagnostics.statusMissingService"));
  return data as ServiceStatus;
}
function normalizeDiagnostic(value: unknown): DiagnosticResponse {
  const data = object(value, t("fusion.diagnostics.context"));
  if (!Array.isArray(data.accounts) || !Array.isArray(data.model_locks))
    throw new Error(t("fusion.diagnostics.missingLists"));
  return data as DiagnosticResponse;
}

const healthTone = (health: string) =>
  health === "ready" ? "good" : health === "disabled" ? "neutral" : "warn";

/**
 * The breaker deadline as epoch seconds, or null when there is none.
 *
 * `fail_until` is an absolute epoch (seconds). A past deadline is a cooldown that
 * already lifted, and 0 means "no breaker at all" — neither may render a badge, and
 * the truthiness test alone kept an expired timestamp on screen forever.
 *
 * Expiry is now decided *inside* <Countdown>, which is the component that already
 * subscribes to the shared clock. Deciding it here would have forced the page root
 * to subscribe, and that re-rendered both tables once a second.
 */
function coolingUntil(account: DiagnosticAccount): number | null {
  const until = account.cooldown?.fail_until;
  return typeof until === "number" && Number.isFinite(until) && until > 0 ? until : null;
}

/**
 * The circuit-breaker cell for one account.
 *
 * It is a component (not an inline expression) because a live breaker is the only
 * thing in this row that changes second to second. The clock subscription lives
 * here — and only here, and only while the deadline is still in the future — so a
 * tick re-renders this one cell instead of the status cards and both tables.
 *
 * The expiry test has to run *inside* the clock subscriber: the backend keeps
 * reporting a stale reason until an explicit reset, so a past `fail_until` is a
 * breaker that already lifted and must read 无熔断, not a countdown stuck at 0.
 */
function BreakerCell({ account }: { account: DiagnosticAccount }) {
  const t = useT();
  const deadline = coolingUntil(account);
  // Subscribe only for a deadline that could still be live; an absent or expired
  // one has nothing to tick and must not hold a timer open.
  const now = useNow(deadline !== null);
  const until = deadline !== null && deadline * 1000 > now ? deadline : null;
  if (until === null) return <Badge>{t("fusion.diagnostics.noCircuit")}</Badge>;
  return (
    <>
      <Countdown until={until} />
      {account.cooldown?.reason ? <small>{account.cooldown.reason}</small> : null}
    </>
  );
}

/**
 * Account table columns.
 *
 * The renderers live in a factory (not inline JSX in the page body) because
 * DataTable takes column definitions as data — but the *cell component* stays
 * module-level inside DataTable, so rebuilding this array never remounts a cell.
 * Sorting is added where the value is unambiguous: name, health and the number of
 * cooling models. The breaker cell has no comparable value (it is a live
 * countdown), so its header stays plain text instead of a button that does nothing.
 */
function accountColumns(t: ReturnType<typeof useT>): DataTableColumn<DiagnosticAccount>[] {
  return [
    {
      id: "account",
      header: t("fusion.diagnostics.colAccountProduct"),
      sortValue: (account) => account.name,
      cell: (account) => (
        <>
          <strong>{account.name}</strong>
          <small>{profileLabel(account.profile)}</small>
        </>
      ),
    },
    {
      id: "status",
      header: t("fusion.diagnostics.colStatus"),
      sortValue: (account) => account.health,
      cell: (account) => (
        <>
          <Badge tone={healthTone(account.health)}>{text(account.health)}</Badge>
          {account.paused && <Badge tone="neutral">{t("fusion.common.paused")}</Badge>}
        </>
      ),
    },
    {
      id: "circuit",
      header: t("fusion.diagnostics.colCircuit"),
      cell: (account) => <BreakerCell account={account} />,
    },
    {
      id: "cooldowns",
      header: t("fusion.diagnostics.colModelCooldown"),
      sortValue: (account) => account.model_cooldowns.length,
      sortDescFirst: true,
      cell: (account) =>
        account.model_cooldowns.length ? (
          account.model_cooldowns.map((cooldown, index) => (
            <small key={index}>
              {text(cooldown.model)} · <Countdown until={cooldown.until} />
            </small>
          ))
        ) : (
          <span>{t("fusion.common.none")}</span>
        ),
    },
    {
      id: "reason",
      header: t("fusion.diagnostics.colDisabledReason"),
      cell: (account) => (
        <>
          {account.disabled_reason && <small>{account.disabled_reason}</small>}
          {account.sync_error && (
            <small>{t("fusion.diagnostics.syncFailed", { message: account.sync_error })}</small>
          )}
          {account.transport_penalty_remaining > 0 && (
            <Badge tone="warn">
              {t("fusion.diagnostics.transportPenalty", {
                seconds: Math.ceil(account.transport_penalty_remaining),
              })}
            </Badge>
          )}
          {account.transport_fails > 0 && account.transport_penalty_remaining <= 0 && (
            <small>
              {t("fusion.diagnostics.transportFails", { count: account.transport_fails })}
            </small>
          )}
          {!account.disabled_reason &&
            !account.sync_error &&
            account.transport_penalty_remaining <= 0 &&
            account.transport_fails <= 0 && (
              <span className={s.muted}>{t("fusion.common.normal")}</span>
            )}
        </>
      ),
    },
  ];
}

/**
 * Model-lock columns. Locks are grouped by (profile, model) upstream, so a model
 * can appear once per profile; sorting by locked accounts answers "what is holding
 * the most accounts right now", which is the question this table exists for.
 */
function lockColumns(t: ReturnType<typeof useT>): DataTableColumn<ModelLock>[] {
  return [
    {
      id: "model",
      header: t("fusion.diagnostics.colProductModel"),
      sortValue: (lock) => lock.model,
      cell: (lock) => (
        <>
          <strong>{text(lock.model)}</strong>
          <small>{profileLabel(lock.profile)}</small>
        </>
      ),
    },
    {
      id: "locked",
      header: t("fusion.diagnostics.colLocked"),
      sortValue: (lock) => lock.locked_accounts,
      sortDescFirst: true,
      cell: (lock) => (
        <>
          <Badge tone={lock.kind === "model_block" ? "warn" : "bad"}>
            {t("fusion.diagnostics.lockedAccounts", { count: lock.locked_accounts })}
          </Badge>
          <small>{lock.account_ids.join(t("fusion.common.listSeparator"))}</small>
        </>
      ),
    },
    {
      id: "unlock",
      header: t("fusion.diagnostics.colPoolUnlock"),
      sortValue: (lock) => lock.all_unlock_in_seconds ?? undefined,
      sortDescFirst: true,
      sortUndefined: "last",
      cell: (lock) => (
        <>
          {lock.all_unlock_in_seconds !== null && lock.all_unlock_in_seconds > 0 ? (
            <Countdown until={lock.latest_unlock_at} fallback={t("fusion.common.unknown")} />
          ) : (
            <Badge tone="good">{t("fusion.diagnostics.unlocked")}</Badge>
          )}
          {lock.earliest_unlock_at !== null && (
            <small>
              {t("fusion.diagnostics.earliestUnlock")} <Countdown until={lock.earliest_unlock_at} />
            </small>
          )}
        </>
      ),
    },
    {
      id: "kind",
      header: t("fusion.diagnostics.colKind"),
      sortValue: (lock) => lock.kind,
      cell: (lock) => (
        <Badge tone={lock.kind === "model_block" ? "warn" : "neutral"}>
          {lock.kind === "model_block"
            ? t("fusion.diagnostics.kindModelBlock")
            : t("fusion.diagnostics.kindQuotaCooldown")}
        </Badge>
      ),
    },
    {
      id: "reason",
      header: t("fusion.diagnostics.colReason"),
      cell: (lock) => <small>{lock.reason}</small>,
    },
  ];
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <section className={s.stat}>
      <div>
        {label}
        <span>
          <Icon name={icon} />
        </span>
      </div>
      <strong>{value}</strong>
    </section>
  );
}

export function Diagnostics() {
  const t = useT();
  const status = useFusionResource("/admin/status", null, normalizeStatus);
  const diagnostic = useFusionResource("/admin/diagnostic", null, normalizeDiagnostic);
  // Memoized on the payload identity: TanStack keys its core row model on the
  // `data` array, so a fresh literal per render would rebuild every row.
  const accounts = useMemo(() => diagnostic.data?.accounts ?? [], [diagnostic.data]);
  const locks = useMemo(() => diagnostic.data?.model_locks ?? [], [diagnostic.data]);
  const accountDefs = useMemo(() => accountColumns(t), [t]);
  const lockDefs = useMemo(() => lockColumns(t), [t]);
  const [accountSort, setAccountSort] = useState<SortingState>([]);
  const [lockSort, setLockSort] = useState<SortingState>([]);
  // This page deliberately holds no clock. It used to call useNow() at the root,
  // which re-rendered the status cards and both tables once a second. Every live
  // deadline is now rendered by <Countdown>, which subscribes to the shared clock
  // on its own and only while it still has something to count down.

  return (
    <>
      <PageTitle
        title={t("nav.diagnostics")}
        description={t("fusion.diagnostics.pageDesc")}
        actions={
          <>
            <FreshnessHint path="/admin/status" />
            {FUSION_DEVELOPMENT && <Badge tone="warn">{t("fusion.common.demoData")}</Badge>}
            <button
              onClick={() => {
                status.reload();
                diagnostic.reload();
              }}
              disabled={status.loading || diagnostic.loading}
            >
              <Icon name="refresh" />
              {t("fusion.common.refresh")}
            </button>
          </>
        }
      />
      <ErrorNotice message={status.error} retry={status.reload} />
      <ErrorNotice message={diagnostic.error} retry={diagnostic.reload} />
      {status.loading && !status.data ? (
        <Skeleton variant="card" label={t("fusion.diagnostics.statusLoading")} />
      ) : status.data ? (
        <>
          <div className={s.stats}>
            <StatCard
              label={t("fusion.diagnostics.pool")}
              value={t("fusion.diagnostics.poolValue", {
                healthy: status.data.pool.healthy,
                total: status.data.pool.total,
              })}
              icon="key"
            />
            <StatCard
              label={t("fusion.diagnostics.coolingDisabled")}
              value={`${status.data.pool.cooling} / ${status.data.pool.disabled}`}
              icon="pulse"
            />
            <StatCard
              label={t("fusion.diagnostics.servable")}
              value={status.data.pool.servable ? t("fusion.common.yes") : t("fusion.common.no")}
              icon="shield"
            />
            <StatCard
              label={t("fusion.diagnostics.uptime")}
              value={t("fusion.diagnostics.uptimeHours", {
                hours: Math.floor(status.data.uptime_seconds / 3600),
              })}
              icon="chart"
            />
          </div>
          <div className={s.dashboardGrid}>
            <Panel title={t("fusion.diagnostics.byProfile")}>
              {Object.entries(status.data.by_profile).length ? (
                <div className={s.tableWrap}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t("fusion.diagnostics.colProduct")}</th>
                        <th scope="col">{t("fusion.diagnostics.colAccounts")}</th>
                        <th scope="col">{t("fusion.diagnostics.colHealthy")}</th>
                        <th scope="col">{t("fusion.diagnostics.colServable")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(status.data.by_profile).map(([key, row]) => (
                        <tr key={key}>
                          <td>
                            <strong>{profileLabel(key)}</strong>
                          </td>
                          <td>{row.total}</td>
                          <td>{row.healthy}</td>
                          <td>
                            <Badge tone={row.servable ? "good" : "bad"}>
                              {row.servable ? t("fusion.common.yes") : t("fusion.common.no")}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title={t("fusion.diagnostics.noProfile")} />
              )}
            </Panel>
            <Panel title={t("fusion.diagnostics.subsystems")}>
              <div className={s.subsystems}>
                {[
                  [
                    t("fusion.diagnostics.sub.audit"),
                    status.data.audit,
                    ["degraded", "failure_count"],
                  ],
                  [
                    t("fusion.diagnostics.sub.cooldown"),
                    status.data.cooldown_storage,
                    ["degraded", "rows"],
                  ],
                  [
                    t("fusion.diagnostics.sub.alerts"),
                    status.data.alerts,
                    ["enabled", "pending_deliveries"],
                  ],
                ].map(([label, data]) => {
                  const row = object(data, t("fusion.diagnostics.subsystems"));
                  const degraded = row.degraded === true;
                  return (
                    <div key={label as string}>
                      <strong>{label as string}</strong>
                      <Badge tone={degraded ? "bad" : "good"}>
                        {degraded ? t("fusion.common.degraded") : t("fusion.common.normal")}
                      </Badge>
                      {row.last_error ? <small>{text(row.last_error)}</small> : null}
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>
        </>
      ) : null}

      <Panel
        title={t("fusion.diagnostics.accounts")}
        hint={
          accounts.length
            ? t("fusion.diagnostics.accountCount", { count: accounts.length })
            : undefined
        }
      >
        <DataTable
          rows={accounts}
          columns={accountDefs}
          rowId={(account) => account.id}
          sorting={accountSort}
          onSortingChange={setAccountSort}
          loading={diagnostic.loading}
          loadingLabel={t("fusion.diagnostics.accountsLoading")}
          // The page already renders diagnostic.error above; without this the failed
          // load also painted "no accounts", which reads as "the pool is empty".
          error={diagnostic.error}
          rowHeight={66}
          skeletonCells={["twoLine", "badge", "badge", "text", "text"]}
          empty={<Empty title={t("fusion.diagnostics.noAccounts")} />}
        />
      </Panel>

      <Panel
        title={t("fusion.diagnostics.locks")}
        hint={locks.length ? t("fusion.diagnostics.lockCount", { count: locks.length }) : undefined}
      >
        <DataTable
          rows={locks}
          columns={lockDefs}
          // Locks are keyed by (profile, model): the same model may be locked on
          // several profiles, and neither field alone is unique.
          rowId={(lock) => `${lock.profile}|${lock.model}`}
          sorting={lockSort}
          onSortingChange={setLockSort}
          loading={diagnostic.loading}
          loadingLabel={t("fusion.diagnostics.locksLoading")}
          error={diagnostic.error}
          rowHeight={70}
          skeletonCells={["text", "badge", "text", "badge", "twoLine"]}
          empty={
            <Empty title={t("fusion.diagnostics.noLocks")}>
              {t("fusion.diagnostics.noLocksHint")}
            </Empty>
          }
        />
      </Panel>
    </>
  );
}
