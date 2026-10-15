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
import { useFusionResource } from "../fusion/client";
import { FUSION_DEVELOPMENT } from "../fusion/client";
import type { DiagnosticResponse, ServiceStatus } from "../fusion/types";
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
  const accounts = diagnostic.data?.accounts ?? [];
  const locks = diagnostic.data?.model_locks ?? [];

  return (
    <>
      <PageTitle
        title={t("nav.diagnostics")}
        description={t("fusion.diagnostics.pageDesc")}
        actions={
          <>
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
                        <th>{t("fusion.diagnostics.colProduct")}</th>
                        <th>{t("fusion.diagnostics.colAccounts")}</th>
                        <th>{t("fusion.diagnostics.colHealthy")}</th>
                        <th>{t("fusion.diagnostics.colServable")}</th>
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
        {diagnostic.loading ? (
          <Skeleton variant="table" label={t("fusion.diagnostics.accountsLoading")} />
        ) : accounts.length ? (
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>{t("fusion.diagnostics.colAccountProduct")}</th>
                  <th>{t("fusion.diagnostics.colStatus")}</th>
                  <th>{t("fusion.diagnostics.colCircuit")}</th>
                  <th>{t("fusion.diagnostics.colModelCooldown")}</th>
                  <th>{t("fusion.diagnostics.colDisabledReason")}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.id}>
                    <td>
                      <strong>{account.name}</strong>
                      <small>{profileLabel(account.profile)}</small>
                    </td>
                    <td>
                      <Badge tone={healthTone(account.health)}>{text(account.health)}</Badge>
                      {account.paused && <Badge tone="neutral">{t("fusion.common.paused")}</Badge>}
                    </td>
                    <td>
                      {account.cooldown && account.cooldown.fail_until > 0 ? (
                        <>
                          <Countdown until={account.cooldown.fail_until} />
                          <small>{account.cooldown.reason}</small>
                        </>
                      ) : (
                        <Badge>{t("fusion.diagnostics.noCircuit")}</Badge>
                      )}
                    </td>
                    <td>
                      {account.model_cooldowns.length ? (
                        account.model_cooldowns.map((cooldown, index) => (
                          <small key={index}>
                            {text(cooldown.model)} · <Countdown until={cooldown.until} />
                          </small>
                        ))
                      ) : (
                        <span>{t("fusion.common.none")}</span>
                      )}
                    </td>
                    <td>
                      {account.disabled_reason && <small>{account.disabled_reason}</small>}
                      {account.sync_error && (
                        <small>
                          {t("fusion.diagnostics.syncFailed", { message: account.sync_error })}
                        </small>
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
                          {t("fusion.diagnostics.transportFails", {
                            count: account.transport_fails,
                          })}
                        </small>
                      )}
                      {!account.disabled_reason &&
                        !account.sync_error &&
                        account.transport_penalty_remaining <= 0 &&
                        account.transport_fails <= 0 && (
                          <span className={s.muted}>{t("fusion.common.normal")}</span>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t("fusion.diagnostics.noAccounts")} />
        )}
      </Panel>

      <Panel
        title={t("fusion.diagnostics.locks")}
        hint={locks.length ? t("fusion.diagnostics.lockCount", { count: locks.length }) : undefined}
      >
        {diagnostic.loading ? (
          <Skeleton variant="table" label={t("fusion.diagnostics.locksLoading")} />
        ) : locks.length ? (
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>{t("fusion.diagnostics.colProductModel")}</th>
                  <th>{t("fusion.diagnostics.colLocked")}</th>
                  <th>{t("fusion.diagnostics.colPoolUnlock")}</th>
                  <th>{t("fusion.diagnostics.colKind")}</th>
                  <th>{t("fusion.diagnostics.colReason")}</th>
                </tr>
              </thead>
              <tbody>
                {locks.map((lock) => (
                  <tr key={`${lock.profile}|${lock.model}`}>
                    <td>
                      <strong>{text(lock.model)}</strong>
                      <small>{profileLabel(lock.profile)}</small>
                    </td>
                    <td>
                      <Badge tone={lock.kind === "model_block" ? "warn" : "bad"}>
                        {t("fusion.diagnostics.lockedAccounts", { count: lock.locked_accounts })}
                      </Badge>
                      <small>{lock.account_ids.join(t("fusion.common.listSeparator"))}</small>
                    </td>
                    <td>
                      {lock.all_unlock_in_seconds !== null && lock.all_unlock_in_seconds > 0 ? (
                        <Countdown
                          until={lock.latest_unlock_at}
                          fallback={t("fusion.common.unknown")}
                        />
                      ) : (
                        <Badge tone="good">{t("fusion.diagnostics.unlocked")}</Badge>
                      )}
                      {lock.earliest_unlock_at !== null && (
                        <small>
                          {t("fusion.diagnostics.earliestUnlock")}{" "}
                          <Countdown until={lock.earliest_unlock_at} />
                        </small>
                      )}
                    </td>
                    <td>
                      <Badge tone={lock.kind === "model_block" ? "warn" : "neutral"}>
                        {lock.kind === "model_block"
                          ? t("fusion.diagnostics.kindModelBlock")
                          : t("fusion.diagnostics.kindQuotaCooldown")}
                      </Badge>
                    </td>
                    <td>
                      <small>{lock.reason}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title={t("fusion.diagnostics.noLocks")}>
            {t("fusion.diagnostics.noLocksHint")}
          </Empty>
        )}
      </Panel>
    </>
  );
}
