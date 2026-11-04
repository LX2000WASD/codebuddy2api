import { useMemo, useState } from "react";
import { metric, number, object, text } from "../api";
import {
  Badge,
  Button,
  Empty,
  ErrorNotice,
  Grid,
  Page,
  Panel,
  Skeleton,
  Stack,
  Stat,
  Table,
  Toolbar,
  nextSort,
  sortRows,
  type SortValue,
  type TableColumn,
  type TableSort,
} from "../ui";
import { Countdown } from "../components";
import { useFusionResource } from "../fusion/client";
import { FUSION_DEVELOPMENT } from "../fusion/client";
import type { CreditExpiryResponse, CreditSegment } from "../fusion/types";
import { profileLabel } from "../values";
import { t, useDateFormat, useT } from "../i18n";
import s from "./Credits.module.scss";

function normalizeExpiry(value: unknown): CreditExpiryResponse {
  const data = object(value, t("fusion.credits.context"));
  if (!Array.isArray(data.items)) throw new Error(t("fusion.credits.itemsMissing"));
  return data as CreditExpiryResponse;
}

// Values are day counts; labels resolve through t("fusion.credits.days") at render.
const WINDOWS = ["7", "14", "30", "90"] as const;
const BURNS = ["1", "7", "14", "30"] as const;

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
 * not reorder the others. Table supplies the header, the pinned action slot and the
 * card layout; the ordering the backend returns (soonest expiry first) is what the
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
  const [sort, setSort] = useState<TableSort>(null);
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
  const values: Record<string, SortValue<(typeof rows)[number]>> = {
    batch: (segment) => segment.source,
    remaining: (segment) => segment.remaining,
    expiry: (segment) => segment.expires_at,
  };
  const columns = useMemo<TableColumn<(typeof rows)[number]>[]>(
    () => [
      {
        id: "batch",
        header: t("fusion.credits.colBatch"),
        sortable: true,
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
        sortable: true,
        cell: (segment) => `${metric(segment.remaining)} / ${metric(segment.total)}`,
      },
      {
        id: "expiry",
        header: t("fusion.credits.colExpiry"),
        sortable: true,
        cell: (segment) =>
          number(segment.expires_at) === null
            ? t("fusion.common.unknown")
            : format.date(new Date(segment.expires_at * 1000)),
      },
    ],
    [t, format],
  );
  return (
    <Table
      label={t("fusion.credits.colBatch")}
      rows={sortRows(rows, values, sort)}
      columns={columns}
      rowKey={(segment) => segment.key}
      sort={sort}
      onSort={(id) => setSort((current) => nextSort(current, id, id === "remaining"))}
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
    <Page
      title={t("fusion.credits.pageTitle")}
      description={t("fusion.credits.pageDesc")}
      actions={
        <>
          {FUSION_DEVELOPMENT && <Badge tone="warn">{t("fusion.common.demoData")}</Badge>}
          <Button icon="refresh" onClick={resource.reload} disabled={resource.loading}>
            {t("fusion.common.refresh")}
          </Button>
        </>
      }
    >
      <Panel
        title={t("fusion.credits.windowPanel")}
        hint={t("fusion.credits.windowHint", { days: data?.threshold_days ?? 3 })}
      >
        <Grid min="sm" gap="3">
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
        </Grid>
      </Panel>

      {resource.error ? (
        <ErrorNotice
          message={resource.error}
          retry={{ label: t("common.retry"), onClick: resource.reload }}
        />
      ) : resource.loading ? (
        <Skeleton variant="card" label={t("fusion.credits.loading")} />
      ) : data ? (
        <>
          <Grid min="sm" gap="3">
            <Stat
              label={t("fusion.credits.expiringCredits")}
              value={metric(data.summary.expiring_credits)}
              hint={t("fusion.credits.accountCount", { count: data.summary.expiring_accounts })}
              icon="coin"
            />
            <Stat
              label={t("fusion.credits.urgentAccounts")}
              value={String(data.summary.urgent_accounts)}
              hint={t("fusion.credits.expiringWithin", { days: data.threshold_days })}
              icon="alert"
            />
            <Stat
              label={t("fusion.credits.totalRemaining")}
              value={metric(data.summary.total_credits)}
              hint={t("fusion.credits.allAccounts")}
              icon="leaf"
            />
            <Stat
              label={t("fusion.credits.dailyBurn")}
              value={
                data.summary.daily_burn_known
                  ? t("fusion.credits.perDay", { value: metric(data.summary.daily_burn) })
                  : t("fusion.common.unknown")
              }
              hint={t("fusion.credits.burnEstimate", { days: data.burn_window_days })}
              icon="chart"
            />
          </Grid>

          {dist && dist.total > 0 && (
            <Panel
              title={t("fusion.credits.distribution")}
              hint={t("fusion.credits.distributionHint")}
            >
              <div className={s.distribution}>
                {dist.bands.map((band) => (
                  <div key={band.label} className={s.band}>
                    <Toolbar split>
                      <strong>{t(band.label)}</strong>
                      <span>{metric(band.credits)}</span>
                    </Toolbar>
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
            <Stack gap="3">
              {data.items.map((item) => (
                <Panel
                  key={item.account_id}
                  title={item.name}
                  hint={profileLabel(item.profile)}
                  action={
                    <Badge tone={item.urgent ? "bad" : "warn"}>
                      {item.urgent
                        ? t("fusion.credits.urgent")
                        : t("fusion.credits.expiresInDays", {
                            days: metric(item.days_remaining),
                          })}
                    </Badge>
                  }
                >
                  <dl className={s.metrics}>
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
                </Panel>
              ))}
            </Stack>
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
    </Page>
  );
}
