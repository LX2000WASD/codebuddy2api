import { useState } from "react";
import { metric, number, object, text } from "../api";
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
import { useFusionResource, FUSION_DEVELOPMENT } from "../fusion/client";
import type { CreditExpiryResponse } from "../fusion/types";
import { profileLabel } from "../values";
import s from "../ui.module.scss";

function normalizeExpiry(value: unknown): CreditExpiryResponse {
  const data = object(value, "积分到期");
  if (!Array.isArray(data.items)) throw new Error("积分到期列表缺失");
  return data as CreditExpiryResponse;
}

const WINDOWS = [
  ["7", "7 天"],
  ["14", "14 天"],
  ["30", "30 天"],
  ["90", "90 天"],
] as const;
const BURNS = [
  ["1", "1 天"],
  ["7", "7 天"],
  ["14", "14 天"],
  ["30", "30 天"],
] as const;

function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: string;
}) {
  return (
    <section className={s.stat}>
      <div>
        {label}
        <span>
          <Icon name={icon} />
        </span>
      </div>
      <strong>{value}</strong>
      {hint && <small>{hint}</small>}
    </section>
  );
}

/** Expiry distribution across the displayed items: credits by days-to-expiry band. */
function distribution(items: CreditExpiryResponse["items"]) {
  const bands = [
    { label: "已过期", max: 0, credits: 0, accounts: new Set<string>() },
    { label: "3 天内", max: 3, credits: 0, accounts: new Set<string>() },
    { label: "7 天内", max: 7, credits: 0, accounts: new Set<string>() },
    { label: "30 天内", max: 30, credits: 0, accounts: new Set<string>() },
    { label: "90 天内", max: 90, credits: 0, accounts: new Set<string>() },
  ];
  for (const item of items) {
    for (const segment of item.segments) {
      const days = (segment.expires_at - Date.now() / 1000) / 86400;
      const band = bands.find((band) => days <= band.max) ?? bands.at(-1)!;
      band.credits += segment.remaining;
      band.accounts.add(item.account_id);
    }
  }
  const peak = Math.max(1, ...bands.map((band) => band.credits));
  return { bands, peak, total: bands.reduce((sum, band) => sum + band.credits, 0) };
}

export function Credits() {
  const [days, setDays] = useState("30");
  const [burnDays, setBurnDays] = useState("7");
  const params = new URLSearchParams({ days, burn_days: burnDays });
  const resource = useFusionResource("/admin/credits/expiry", params, normalizeExpiry);
  const data = resource.data;
  const dist = data ? distribution(data.items) : null;

  return (
    <>
      <PageTitle
        title="积分到期提醒"
        description="FEFO 批次明细、日均需耗与到期分布；仅展示到期日落入窗口内的批次。"
        actions={
          <>
            {FUSION_DEVELOPMENT && <Badge tone="warn">本地演示数据</Badge>}
            <button onClick={resource.reload} disabled={resource.loading}>
              <Icon name="refresh" />
              刷新
            </button>
          </>
        }
      />
      <Panel title="提醒窗口" hint={`阈值 ${data?.threshold_days ?? 3} 天内为紧急`}>
        <div className={s.fusionControls}>
          <label className={s.field}>
            展示窗口
            <select aria-label="展示窗口" value={days} onChange={(e) => setDays(e.target.value)}>
              {WINDOWS.map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            日均需耗窗口
            <select
              aria-label="日均需耗窗口"
              value={burnDays}
              onChange={(e) => setBurnDays(e.target.value)}
            >
              {BURNS.map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      {resource.error ? (
        <ErrorNotice message={resource.error} retry={resource.reload} />
      ) : resource.loading ? (
        <Skeleton variant="card" label="积分提醒加载中" />
      ) : data ? (
        <>
          <div className={s.stats}>
            <StatCard
              label="窗口内到期积分"
              value={metric(data.summary.expiring_credits)}
              hint={`${data.summary.expiring_accounts} 个账号`}
              icon="coin"
            />
            <StatCard
              label="紧急账号"
              value={String(data.summary.urgent_accounts)}
              hint={`${data.threshold_days} 天内到期`}
              icon="alert"
            />
            <StatCard
              label="全部剩余"
              value={metric(data.summary.total_credits)}
              hint="全部账号合计"
              icon="leaf"
            />
            <StatCard
              label="日均需耗"
              value={
                data.summary.daily_burn_known ? `${metric(data.summary.daily_burn)} / 天` : "未知"
              }
              hint={`按最近 ${data.burn_window_days} 天消耗估算`}
              icon="chart"
            />
          </div>

          {dist && dist.total > 0 && (
            <Panel title="到期分布" hint="按批次剩余积分聚合">
              <div className={s.distribution}>
                {dist.bands.map((band) => (
                  <div key={band.label}>
                    <div>
                      <strong>{band.label}</strong>
                      <span>{metric(band.credits)}</span>
                    </div>
                    <progress
                      max={dist.peak || 1}
                      value={band.credits}
                      aria-label={`${band.label}到期积分 ${metric(band.credits)}，${band.accounts.size} 个账号`}
                    />
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {data.items.length ? (
            <div className={s.creditCards}>
              {data.items.map((item) => (
                <section
                  className={s.creditCard}
                  key={item.account_id}
                  data-urgent={item.urgent || undefined}
                >
                  <div className={s.creditHead}>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{profileLabel(item.profile)}</small>
                    </div>
                    <Badge tone={item.urgent ? "bad" : "warn"}>
                      {item.urgent ? "紧急" : `${metric(item.days_remaining)} 天后到期`}
                    </Badge>
                  </div>
                  <dl className={s.creditMetrics}>
                    <div>
                      <dt>账号剩余</dt>
                      <dd>
                        {item.remaining_credits === null ? "未知" : metric(item.remaining_credits)}
                      </dd>
                    </div>
                    <div>
                      <dt>日均需耗</dt>
                      <dd>
                        {item.daily_burn === null ? "未知" : `${metric(item.daily_burn)} / 天`}
                      </dd>
                    </div>
                    <div>
                      <dt>预计耗尽</dt>
                      <dd>
                        {item.projected_exhaustion_days === null
                          ? "未知"
                          : `${metric(item.projected_exhaustion_days)} 天`}
                      </dd>
                    </div>
                    <div>
                      <dt>最近到期</dt>
                      <dd>
                        {item.soonest_expiry === null ? (
                          "未知"
                        ) : (
                          <>
                            <Countdown until={item.soonest_expiry} fallback="" />
                            <small>
                              {new Date(item.soonest_expiry * 1000).toLocaleDateString("zh-CN")}
                            </small>
                          </>
                        )}
                      </dd>
                    </div>
                  </dl>
                  <div className={s.tableWrap}>
                    <table>
                      <thead>
                        <tr>
                          <th>批次（FEFO 序）</th>
                          <th>剩余 / 总量</th>
                          <th>到期</th>
                        </tr>
                      </thead>
                      <tbody>
                        {item.segments.map((segment, index) => (
                          <tr key={index}>
                            <td>
                              <strong>{text(segment.source)}</strong>
                              <small>{segment.package_code ?? "无批次号"}</small>
                            </td>
                            <td>
                              {metric(segment.remaining)} / {metric(segment.total)}
                            </td>
                            <td>
                              {number(segment.expires_at) === null
                                ? "未知"
                                : new Date(segment.expires_at * 1000).toLocaleDateString("zh-CN")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <Panel title="到期批次">
              <Empty title="窗口内没有到期批次">
                当前窗口 {days} 天内没有积分到期；可放宽窗口查看更远批次。
              </Empty>
            </Panel>
          )}
        </>
      ) : (
        <Empty title="暂无积分快照" />
      )}
    </>
  );
}
