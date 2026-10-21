import { useMemo, useState } from "react";
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
import type { CreditExpiryResponse, CreditSegment } from "../fusion/types";
import { profileLabel } from "../values";
import { t, useDateFormat, useT } from "../i18n";
import { DataTable, type DataTableColumn, type SortingState } from "../dataTable";
import s from "../ui.module.scss";

function normalizeExpiry(value: unknown): CreditExpiryResponse {
  const data = object(value, t("fusion.credits.context"));
  if (!Array.isArray(data.items)) throw new Error(t("fusion.credits.itemsMissing"));
  return data as CreditExpiryResponse;
}

// Values are day counts; labels resolve through t("fusion.credits.days") at render.
const WINDOWS = ["7", "14", "30", "90"] as const;
const BURNS = ["1", "7", "14", "30"] as const;

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
  // `label` holds an i18n key: it doubles as the React key and the aria-label
  // source, so it must stay stable across language switches.
  const bands = [
    { label: "fusion.credits.band.expired", max: 0, credits: 0, accounts: new Set<string>() },
    { label: "fusion.credits.band.d3", max: 3, credits: 0, accounts: new Set<string>() },
    { label: "fusion.credits.band.d7", max: 7, credits: 0, accounts: new Set<string>() },
    { label: "fusion.credits.band.d30", max: 30, credits: 0, accounts: new Set<string>() },
    { label: "fusion.credits.band.d90", max: 90, credits: 0, accounts: new Set<string>() },
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

/**
 * One account's FEFO batch list.
 *
 * It is a component of its own because sorting is per-card state: the page shows
 * several accounts side by side, and a sort chosen on one account's batches must
 * not reorder the others. DataTable supplies the header, the sticky row and the
 * empty shell; the ordering the backend returns (soonest expiry first) is what the
 * "batch" column documents, and the two numeric columns are sortable on top of it.
 */
function SegmentTable({
  segments,
  format,
}: {
  segments: CreditSegment[];
  format: ReturnType<typeof useDateFormat>;
}) {
  const t = useT();
  const [sorting, setSorting] = useState<SortingState>([]);
  // A segment carries no id of its own, so the row key is derived once here —
  // source + expiry + position, because two batches of the same package can share
  // both source and expiry and only their order tells them apart.
  const rows = useMemo(
    () =>
      segments.map((segment, index) => ({
        ...segment,
        key: `${segment.source}|${segment.expires_at}|${index}`,
      })),
    [segments],
  );
  const columns = useMemo<DataTableColumn<(typeof rows)[number]>[]>(
    () => [
      {
        id: "batch",
        header: t("fusion.credits.colBatch"),
        sortValue: (segment) => segment.source,
        cell: (segment) => (
          <>
            <strong>{text(segment.source)}</strong>
            <small>{segment.package_code ?? t("fusion.credits.noPackageCode")}</small>
          </>
        ),
      },
      {
        id: "remaining",
        header: t("fusion.credits.colRemainingTotal"),
        sortValue: (segment) => segment.remaining,
        sortDescFirst: true,
        cell: (segment) => `${metric(segment.remaining)} / ${metric(segment.total)}`,
      },
      {
        id: "expiry",
        header: t("fusion.credits.colExpiry"),
        sortValue: (segment) => segment.expires_at,
        sortUndefined: "last",
        cell: (segment) =>
          number(segment.expires_at) === null
            ? t("fusion.common.unknown")
            : format.date(new Date(segment.expires_at * 1000)),
      },
    ],
    [t, format],
  );
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowId={(segment) => segment.key}
      sorting={sorting}
      onSortingChange={setSorting}
      empty={<Empty title={t("fusion.credits.noBatches")} />}
    />
  );
}

export function Credits() {
  const t = useT();
  const format = useDateFormat();
  const [days, setDays] = useState("30");
  const [burnDays, setBurnDays] = useState("7");
  const params = new URLSearchParams({ days, burn_days: burnDays });
  const resource = useFusionResource("/admin/credits/expiry", params, normalizeExpiry);
  const data = resource.data;
  const dist = data ? distribution(data.items) : null;

  return (
    <>
      <PageTitle
        title={t("fusion.credits.pageTitle")}
        description={t("fusion.credits.pageDesc")}
        actions={
          <>
            {FUSION_DEVELOPMENT && <Badge tone="warn">{t("fusion.common.demoData")}</Badge>}
            <button onClick={resource.reload} disabled={resource.loading}>
              <Icon name="refresh" />
              {t("fusion.common.refresh")}
            </button>
          </>
        }
      />
      <Panel
        title={t("fusion.credits.windowPanel")}
        hint={t("fusion.credits.windowHint", { days: data?.threshold_days ?? 3 })}
      >
        <div className={s.fusionControls}>
          <label className={s.field}>
            {t("fusion.credits.displayWindow")}
            <select
              aria-label={t("fusion.credits.displayWindow")}
              value={days}
              onChange={(e) => setDays(e.target.value)}
            >
              {WINDOWS.map((value) => (
                <option value={value} key={value}>
                  {t("fusion.credits.days", { days: value })}
                </option>
              ))}
            </select>
          </label>
          <label className={s.field}>
            {t("fusion.credits.burnWindow")}
            <select
              aria-label={t("fusion.credits.burnWindow")}
              value={burnDays}
              onChange={(e) => setBurnDays(e.target.value)}
            >
              {BURNS.map((value) => (
                <option value={value} key={value}>
                  {t("fusion.credits.days", { days: value })}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      {resource.error ? (
        <ErrorNotice message={resource.error} retry={resource.reload} />
      ) : resource.loading ? (
        <Skeleton variant="card" label={t("fusion.credits.loading")} />
      ) : data ? (
        <>
          <div className={s.stats}>
            <StatCard
              label={t("fusion.credits.expiringCredits")}
              value={metric(data.summary.expiring_credits)}
              hint={t("fusion.credits.accountCount", { count: data.summary.expiring_accounts })}
              icon="coin"
            />
            <StatCard
              label={t("fusion.credits.urgentAccounts")}
              value={String(data.summary.urgent_accounts)}
              hint={t("fusion.credits.expiringWithin", { days: data.threshold_days })}
              icon="alert"
            />
            <StatCard
              label={t("fusion.credits.totalRemaining")}
              value={metric(data.summary.total_credits)}
              hint={t("fusion.credits.allAccounts")}
              icon="leaf"
            />
            <StatCard
              label={t("fusion.credits.dailyBurn")}
              value={
                data.summary.daily_burn_known
                  ? t("fusion.credits.perDay", { value: metric(data.summary.daily_burn) })
                  : t("fusion.common.unknown")
              }
              hint={t("fusion.credits.burnEstimate", { days: data.burn_window_days })}
              icon="chart"
            />
          </div>

          {dist && dist.total > 0 && (
            <Panel
              title={t("fusion.credits.distribution")}
              hint={t("fusion.credits.distributionHint")}
            >
              <div className={s.distribution}>
                {dist.bands.map((band) => (
                  <div key={band.label}>
                    <div>
                      <strong>{t(band.label)}</strong>
                      <span>{metric(band.credits)}</span>
                    </div>
                    <progress
                      max={dist.peak || 1}
                      value={band.credits}
                      aria-label={t("fusion.credits.bandAria", {
                        band: t(band.label),
                        credits: metric(band.credits),
                        accounts: band.accounts.size,
                      })}
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
                      {item.urgent
                        ? t("fusion.credits.urgent")
                        : t("fusion.credits.expiresInDays", {
                            days: metric(item.days_remaining),
                          })}
                    </Badge>
                  </div>
                  <dl className={s.creditMetrics}>
                    <div>
                      <dt>{t("fusion.credits.accountRemaining")}</dt>
                      <dd>
                        {item.remaining_credits === null
                          ? t("fusion.common.unknown")
                          : metric(item.remaining_credits)}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("fusion.credits.dailyBurn")}</dt>
                      <dd>
                        {item.daily_burn === null
                          ? t("fusion.common.unknown")
                          : t("fusion.credits.perDay", { value: metric(item.daily_burn) })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("fusion.credits.projectedExhaustion")}</dt>
                      <dd>
                        {item.projected_exhaustion_days === null
                          ? t("fusion.common.unknown")
                          : t("fusion.credits.daysValue", {
                              days: metric(item.projected_exhaustion_days),
                            })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("fusion.credits.soonestExpiry")}</dt>
                      <dd>
                        {item.soonest_expiry === null ? (
                          t("fusion.common.unknown")
                        ) : (
                          <>
                            <Countdown until={item.soonest_expiry} fallback="" />
                            <small>{format.date(new Date(item.soonest_expiry * 1000))}</small>
                          </>
                        )}
                      </dd>
                    </div>
                  </dl>
                  <SegmentTable segments={item.segments} format={format} />
                </section>
              ))}
            </div>
          ) : (
            <Panel title={t("fusion.credits.batches")}>
              <Empty title={t("fusion.credits.noBatches")}>
                {t("fusion.credits.noBatchesHint", { days })}
              </Empty>
            </Panel>
          )}
        </>
      ) : (
        <Empty title={t("fusion.credits.noSnapshot")} />
      )}
    </>
  );
}
