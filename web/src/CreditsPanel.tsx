import { metric, type Credential, type RecordValue } from "./api";
import { Badge, Empty, ErrorNotice, Icon, Panel, Table } from "./ui";
import {
  CATEGORY_LABELS,
  agoLabel,
  creditBreakdown,
  dateLabel,
  untilLabel,
  type CreditCategory,
  type CreditPackage,
} from "./credits";
import s from "./CreditsPanel.module.scss";

const category = (value: CreditCategory) => ({ "data-category": value }) as const;

type Segment = CreditPackage["segments"][number] & { key: number };

function PackageRow({ pkg, now }: { pkg: CreditPackage; now: number }) {
  const filled = pkg.total > 0 ? Math.min(100, (pkg.remaining / pkg.total) * 100) : 0;
  const segments: Segment[] = pkg.segments.map((segment, index) => ({ ...segment, key: index }));
  return (
    <details className={s.package} {...category(pkg.category)}>
      <summary className={s.summary}>
        <span className={s.head}>
          <span className={s.dot} aria-hidden="true" />
          <strong className={s.name} title={pkg.code || undefined}>
            {pkg.label}
          </strong>
          <span className={s.category}>{CATEGORY_LABELS[pkg.category]}</span>
          <span className={s.amount}>
            {metric(pkg.remaining)}
            <small> / {metric(pkg.total)}</small>
          </span>
        </span>
        <span className={s.track} aria-hidden="true">
          <i style={{ width: `${filled}%` }} />
        </span>
        <span className={s.meta}>
          <small>
            {pkg.segments.length} 段
            {pkg.soonest === null
              ? ""
              : pkg.longTerm
                ? ` · ${dateLabel(pkg.soonest, now)} 到期`
                : ` · 最近到期 ${dateLabel(pkg.soonest, now)}（${untilLabel(pkg.soonest, now)}）`}
          </small>
          {pkg.soonRemaining > 0 && (
            <Badge tone="warn">7 天内到期 {metric(pkg.soonRemaining)}</Badge>
          )}
          {pkg.longTerm && <Badge tone="good">长期有效</Badge>}
          {pkg.expiredRemaining > 0 && (
            <Badge tone="bad">已过期 {metric(pkg.expiredRemaining)}</Badge>
          )}
          <span className={s.toggle}>明细</span>
        </span>
      </summary>
      {/* One row per expiry segment: the batch composition of this package. */}
      <Table
        label={`${pkg.label} 额度分段`}
        rows={segments}
        rowKey={(segment) => String(segment.key)}
        columns={[
          {
            id: "expires",
            header: "到期时间",
            cell: (segment) =>
              segment.expiresAt === null ? "—" : dateLabel(segment.expiresAt, now),
          },
          { id: "remaining", header: "剩余", cell: (segment) => metric(segment.remaining) },
          { id: "total", header: "总额", cell: (segment) => metric(segment.total) },
          {
            id: "until",
            header: "距到期",
            cell: (segment) =>
              segment.expiresAt === null ? (
                "—"
              ) : segment.state === "soon" || segment.state === "expired" ? (
                <Badge tone={segment.state === "soon" ? "warn" : "bad"}>
                  {untilLabel(segment.expiresAt, now)}
                </Badge>
              ) : (
                untilLabel(segment.expiresAt, now)
              ),
          },
        ]}
      />
    </details>
  );
}

/** Balance column caption: the soonest live credit expiry, never the token expiry. */
export function BalanceExpiry({ credits, now }: { credits: RecordValue | null; now: number }) {
  // 持久化的 soonest_expiry 在两次同步之间会过期，必须和 tab 一样从各段重算。
  const b = credits ? creditBreakdown(credits, now) : null;
  return (
    <small className={s.expiry}>
      {!b ? (
        "尚未同步"
      ) : b.unlimited ? (
        "企业无限额度"
      ) : b.soonest ? (
        <>
          最近到期 <span>{dateLabel(b.soonest.at, now)}</span>
        </>
      ) : b.segmentCount > 0 && b.expired.count === b.segmentCount ? (
        "已全部过期，待同步"
      ) : (
        "无到期信息"
      )}
    </small>
  );
}

/** Official credit tab: snapshot health, expiry pressure and per-package composition. */
export function CreditsPanel({ credential, now }: { credential: Credential; now: number }) {
  const syncError =
    typeof credential.sync_error === "string" && credential.sync_error
      ? credential.sync_error
      : null;
  const raw = credential.credits;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return (
      <Panel title="额度概览">
        {syncError && <ErrorNotice message={`最近同步失败：${syncError}`} />}
        <Empty title="尚未同步官方额度">点击上方「同步余额」图标获取。</Empty>
      </Panel>
    );
  }
  const b = creditBreakdown(raw as RecordValue, now);
  const age = b.fetchedAt === null ? null : agoLabel(b.fetchedAt, now);
  const notices = [
    syncError
      ? `最近同步失败：${syncError}${age ? `；以下为 ${age}的快照` : ""}`
      : b.stale && age
        ? `额度快照更新于 ${age}，可能已变化`
        : null,
    b.partial ? "上游分页未取全，额度可能偏少" : null,
    b.expired.count
      ? `快照中有 ${b.expired.count} 段共 ${metric(b.expired.remaining)} 积分已过期，下次同步后移除`
      : null,
  ].filter((line): line is string => line !== null);
  return (
    <>
      <Panel title="额度概览">
        {notices.length > 0 && (
          <div className={s.notice} role="status">
            <Icon name="alert" size="sm" />
            <div>
              {notices.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        )}
        <div className={s.tiles}>
          <div>
            <span>官方剩余</span>
            <strong>{b.unlimited ? "无限" : metric(b.total)}</strong>
            <small>
              {b.unlimited
                ? "企业配额不参与余额折算"
                : `${b.packages.length} 个套餐 · ${b.segmentCount} 段`}
            </small>
          </div>
          <div>
            <span>7 天内到期</span>
            <strong className={b.soon.remaining > 0 ? s.warn : undefined}>
              {b.unlimited ? "—" : metric(b.soon.remaining)}
            </strong>
            <small>{b.soon.count ? `${b.soon.count} 段` : "暂无"}</small>
          </div>
          <div>
            <span>最近到期</span>
            <strong>{b.soonest ? dateLabel(b.soonest.at, now) : "—"}</strong>
            <small>
              {b.soonest
                ? `${untilLabel(b.soonest.at, now)} · ${metric(b.soonest.remaining)}`
                : "无到期信息"}
            </small>
          </div>
          <div>
            <span>同步时间</span>
            <strong>{age ?? "未知"}</strong>
            <small>{b.fetchedAt === null ? "—" : dateLabel(b.fetchedAt, now)}</small>
          </div>
        </div>
        {b.categories.length > 0 && (
          <div className={s.mix}>
            <div
              className={s.mixBar}
              role="img"
              aria-label={`额度构成：${b.categories
                .map((c) => `${CATEGORY_LABELS[c.category]} ${metric(c.remaining)}`)
                .join("，")}`}
            >
              {b.categories.map((c) => (
                <i
                  key={c.category}
                  {...category(c.category)}
                  style={{ width: `${c.share * 100}%` }}
                />
              ))}
            </div>
            <ul className={s.legend}>
              {b.categories.map((c) => (
                <li key={c.category} {...category(c.category)}>
                  <span className={s.dot} aria-hidden="true" />
                  {CATEGORY_LABELS[c.category]}
                  <strong>{metric(c.remaining)}</strong>
                  <small>{c.share < 0.01 ? "<1%" : `${Math.round(c.share * 100)}%`}</small>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>
      {b.packages.length > 0 && (
        <Panel title="套餐明细" hint="按剩余额度排序，展开查看每段到期时间">
          <div className={s.packages}>
            {b.packages.map((pkg) => (
              <PackageRow key={pkg.key} pkg={pkg} now={now} />
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}
