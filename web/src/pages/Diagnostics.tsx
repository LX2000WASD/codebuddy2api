import { object, text } from "../api";
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
  const data = object(value, "服务状态");
  if (typeof data.service !== "string") throw new Error("服务状态缺少 service");
  return data as ServiceStatus;
}
function normalizeDiagnostic(value: unknown): DiagnosticResponse {
  const data = object(value, "诊断");
  if (!Array.isArray(data.accounts) || !Array.isArray(data.model_locks))
    throw new Error("诊断响应缺少账号或锁池列表");
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
  const status = useFusionResource("/admin/status", null, normalizeStatus);
  const diagnostic = useFusionResource("/admin/diagnostic", null, normalizeDiagnostic);
  const accounts = diagnostic.data?.accounts ?? [];
  const locks = diagnostic.data?.model_locks ?? [];

  return (
    <>
      <PageTitle
        title="诊断"
        description="聚合服务状态、逐账号冷却与禁用原因、模型锁全池视图，仅在打开本页时拉取。"
        actions={
          <>
            {FUSION_DEVELOPMENT && <Badge tone="warn">本地演示数据</Badge>}
            <button
              onClick={() => {
                status.reload();
                diagnostic.reload();
              }}
              disabled={status.loading || diagnostic.loading}
            >
              <Icon name="refresh" />
              刷新
            </button>
          </>
        }
      />
      <ErrorNotice message={status.error} retry={status.reload} />
      <ErrorNotice message={diagnostic.error} retry={diagnostic.reload} />
      {status.loading && !status.data ? (
        <Skeleton variant="card" label="服务状态加载中" />
      ) : status.data ? (
        <>
          <div className={s.stats}>
            <StatCard
              label="凭证池"
              value={`${status.data.pool.healthy}/${status.data.pool.total} 可用`}
              icon="key"
            />
            <StatCard
              label="冷却 / 停用"
              value={`${status.data.pool.cooling} / ${status.data.pool.disabled}`}
              icon="pulse"
            />
            <StatCard
              label="可服务"
              value={status.data.pool.servable ? "是" : "否"}
              icon="shield"
            />
            <StatCard
              label="运行时长"
              value={`${Math.floor(status.data.uptime_seconds / 3600)} 小时`}
              icon="chart"
            />
          </div>
          <div className={s.dashboardGrid}>
            <Panel title="按产品分布">
              {Object.entries(status.data.by_profile).length ? (
                <div className={s.tableWrap}>
                  <table>
                    <thead>
                      <tr>
                        <th>产品</th>
                        <th>账号</th>
                        <th>可用</th>
                        <th>可服务</th>
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
                              {row.servable ? "是" : "否"}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty title="暂无产品分布" />
              )}
            </Panel>
            <Panel title="子系统状态">
              <div className={s.subsystems}>
                {[
                  ["审计存储", status.data.audit, ["degraded", "failure_count"]],
                  ["冷却存储", status.data.cooldown_storage, ["degraded", "rows"]],
                  ["告警", status.data.alerts, ["enabled", "pending_deliveries"]],
                ].map(([label, data]) => {
                  const row = object(data, "子系统状态");
                  const degraded = row.degraded === true;
                  return (
                    <div key={label as string}>
                      <strong>{label as string}</strong>
                      <Badge tone={degraded ? "bad" : "good"}>{degraded ? "降级" : "正常"}</Badge>
                      {row.last_error ? <small>{text(row.last_error)}</small> : null}
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>
        </>
      ) : null}

      <Panel title="账号诊断" hint={accounts.length ? `${accounts.length} 个账号` : undefined}>
        {diagnostic.loading ? (
          <Skeleton variant="table" label="账号诊断加载中" />
        ) : accounts.length ? (
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>账号 / 产品</th>
                  <th>状态</th>
                  <th>认证熔断</th>
                  <th>模型冷却</th>
                  <th>禁用原因 / 最近错误</th>
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
                      {account.paused && <Badge tone="neutral">已暂停</Badge>}
                    </td>
                    <td>
                      {account.cooldown && account.cooldown.fail_until > 0 ? (
                        <>
                          <Countdown until={account.cooldown.fail_until} />
                          <small>{account.cooldown.reason}</small>
                        </>
                      ) : (
                        <Badge>无熔断</Badge>
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
                        <span>无</span>
                      )}
                    </td>
                    <td>
                      {account.disabled_reason && <small>{account.disabled_reason}</small>}
                      {account.sync_error && <small>同步失败：{account.sync_error}</small>}
                      {!account.disabled_reason && !account.sync_error && (
                        <span className={s.muted}>正常</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="暂无账号诊断" />
        )}
      </Panel>

      <Panel title="模型锁池" hint={locks.length ? `${locks.length} 组锁定` : undefined}>
        {diagnostic.loading ? (
          <Skeleton variant="table" label="锁池视图加载中" />
        ) : locks.length ? (
          <div className={s.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>产品 / 模型</th>
                  <th>锁定账号</th>
                  <th>全池解锁</th>
                  <th>类型</th>
                  <th>原因</th>
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
                        {lock.locked_accounts} 个
                      </Badge>
                      <small>{lock.account_ids.join("、")}</small>
                    </td>
                    <td>
                      {lock.all_unlock_in_seconds !== null && lock.all_unlock_in_seconds > 0 ? (
                        <Countdown until={lock.latest_unlock_at} fallback="未知" />
                      ) : (
                        <Badge tone="good">已解锁</Badge>
                      )}
                      {lock.earliest_unlock_at !== null && (
                        <small>
                          最早解锁 <Countdown until={lock.earliest_unlock_at} />
                        </small>
                      )}
                    </td>
                    <td>
                      <Badge tone={lock.kind === "model_block" ? "warn" : "neutral"}>
                        {lock.kind === "model_block" ? "模型不可用" : "额度冷却"}
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
          <Empty title="当前没有模型级锁定">模型 429 冷却与后端不可用锁定都会聚合在这里。</Empty>
        )}
      </Panel>
    </>
  );
}
