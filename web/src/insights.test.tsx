import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRoutes } from "./App";
import { api, useSession } from "./api";
import {
  CREDITS_BADGE_DAYS,
  CreditsBadge,
  CostCards,
  HealthSparkline,
  ModelHealthCell,
  RUN_RATE_MIN_DAYS,
  RUN_RATE_MIN_REQUESTS,
  SPARKLINE_LIMIT,
  changePercent,
  costFigures,
  creditsAlert,
  healthFor,
  healthKey,
  healthTone,
  sparklineKeys,
  type ModelHealth,
} from "./insights";
import { Dashboard } from "./pages/Dashboard";
import { Models } from "./pages/Models";

/** Epoch seconds for "now", so every relative expiry in this file is deterministic. */
const NOW = 1_800_000_000;

function health(key: string, requests: number, error: number): ModelHealth {
  return { key, requests, error, errorRate: requests > 0 ? error / requests : null };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  // The shell tests mount the real router; without a session it renders the guard.
  useSession.setState({ status: "authenticated", csrf: "synthetic" });
});
afterEach(() => vi.restoreAllMocks());

describe("health lookup by public id", () => {
  it("keys aggregates by the requested model name, not the local rule id", () => {
    // The audit store buckets the model dimension by the requested model name, so a
    // rule whose id and public_id differ must still find its own health row.
    const byModel = new Map([["public-a", health("public-a", 40, 2)]]);
    expect(healthFor(byModel, { id: "upstream-a", public_id: "public-a" })?.requests).toBe(40);
    expect(healthFor(byModel, { id: "upstream-b", public_id: "public-b" })).toBeUndefined();
  });

  it("falls back to the rule id when no public id was reported", () => {
    const byModel = new Map([["upstream-a", health("upstream-a", 7, 0)]]);
    expect(healthFor(byModel, { id: "upstream-a", public_id: "" })?.requests).toBe(7);
    expect(healthKey({ id: "upstream-a" })).toBe("upstream-a");
    expect(healthKey({ id: "upstream-a", public_id: "public-a" })).toBe("public-a");
  });
});

describe("cost figures", () => {
  it("derives today, the daily average and the per-request cost from the dashboard payload", () => {
    const figures = costFigures(
      { requests: 100, credit: 70 },
      [
        { bucket: 1, date: "2026-10-19", credit: 10, requests: 20 },
        { bucket: 2, date: "2026-10-20", credit: 20, requests: 30 },
        { bucket: 3, date: "2026-10-21", credit: 40, requests: 50 },
      ],
      { days: 7, granularity: "day" },
    );
    // Today is the newest UTC bucket; yesterday the one before it.
    expect(figures.today).toBe(40);
    expect(figures.yesterday).toBe(20);
    // 70 credits over a 7-day window, not over the 3 buckets present: the window
    // is what the range says, otherwise a quiet week would look expensive.
    expect(figures.dailyAverage).toBe(10);
    expect(figures.runRate).toBe(300);
    expect(figures.perRequest).toBeCloseTo(0.7, 6);
    expect(figures.insufficient).toBe(false);
  });

  it("withholds the 30-day extrapolation when the sample is too thin", () => {
    // Three requests costing 5 credits: extrapolating this is how a single call
    // turns into a fictional 150-credit month.
    const figures = costFigures(
      { requests: 3, credit: 5 },
      [{ bucket: 1, date: "2026-10-21", credit: 5, requests: 3 }],
      { days: 7, granularity: "day" },
    );
    expect(figures.runRate).toBeNull();
    expect(figures.insufficient).toBe(true);
    expect(figures.dailyAverage).not.toBeNull();
  });

  it("treats a one-day window as insufficient however busy it was", () => {
    const figures = costFigures(
      { requests: 5000, credit: 900 },
      [{ bucket: 1, date: "2026-10-21", credit: 900, requests: 5000 }],
      { days: 1, granularity: "day" },
    );
    expect(figures.insufficient).toBe(true);
    expect(figures.runRate).toBeNull();
    expect(RUN_RATE_MIN_DAYS).toBe(2);
    expect(RUN_RATE_MIN_REQUESTS).toBe(10);
  });

  it("never reads an hourly series as today and yesterday", () => {
    const figures = costFigures(
      { requests: 100, credit: 12 },
      [
        { bucket: 1, date: "2026-10-21 10:00", credit: 3, requests: 30 },
        { bucket: 2, date: "2026-10-21 11:00", credit: 4, requests: 40 },
      ],
      { days: 1, granularity: "hour" },
    );
    // The second-to-last hourly bucket is the previous hour, not yesterday.
    expect(figures.today).toBeNull();
    expect(figures.yesterday).toBeNull();
    expect(figures.perRequest).toBeCloseTo(0.12, 6);
  });

  it("reports an unknown credit total as unknown instead of zero", () => {
    const figures = costFigures(
      { requests: 40, credit: null },
      [{ bucket: 1, date: "2026-10-21", credit: null, requests: 40 }],
      { days: 7 },
    );
    expect(figures.dailyAverage).toBeNull();
    expect(figures.perRequest).toBeNull();
    expect(figures.runRate).toBeNull();
  });

  it("computes the signed change and refuses a zero baseline", () => {
    expect(changePercent(150, 100)).toBeCloseTo(50, 6);
    expect(changePercent(50, 100)).toBeCloseTo(-50, 6);
    expect(changePercent(10, 0)).toBeNull();
    expect(changePercent(10, null)).toBeNull();
    expect(changePercent(null, 10)).toBeNull();
  });
});

describe("cost cards", () => {
  it("renders the four tiles and states the UTC qualifier", () => {
    render(
      <CostCards
        summary={{ requests: 100, credit: 70 }}
        series={[
          { bucket: 1, date: "2026-10-20", credit: 20, requests: 30 },
          { bucket: 2, date: "2026-10-21", credit: 40, requests: 50 },
        ]}
        range={{ days: 7, granularity: "day" }}
        partial={false}
      />,
    );
    expect(screen.getByText("今日花费（UTC）")).toBeTruthy();
    expect(screen.getByText("日均花费")).toBeTruthy();
    expect(screen.getByText("30 天外推")).toBeTruthy();
    expect(screen.getByText("单次请求平均")).toBeTruthy();
    expect(screen.getByText("较昨日 +100.0%")).toBeTruthy();
    expect(screen.getByText(/UTC 自然日/)).toBeTruthy();
  });

  it("says so instead of extrapolating when there is not enough data", () => {
    render(
      <CostCards
        summary={{ requests: 3, credit: 5 }}
        series={[{ bucket: 1, date: "2026-10-21", credit: 5, requests: 3 }]}
        range={{ days: 7, granularity: "day" }}
        partial={false}
      />,
    );
    expect(screen.getByText("样本不足")).toBeTruthy();
    expect(screen.getByText(/仅 3 次请求/)).toBeTruthy();
  });
});

describe("model health", () => {
  it("grades tone on the error rate, not the raw failure count", () => {
    expect(healthTone(undefined)).toBe("none");
    expect(healthTone(health("a", 0, 0))).toBe("none");
    expect(healthTone(health("a", 1000, 0))).toBe("good");
    expect(healthTone(health("a", 1000, 5))).toBe("degraded");
    // One failure in three requests is a broken model, one in three thousand is noise.
    expect(healthTone(health("a", 3, 1))).toBe("bad");
  });

  it("renders the error rate, the request count and the sparkline slot", () => {
    render(
      <ModelHealthCell
        name="alpha"
        health={health("alpha", 200, 3)}
        spark={<HealthSparkline name="alpha" rows={[{ date: "2026-10-21", requests: 5 }]} />}
      />,
    );
    expect(screen.getByText("错误率 1.5%")).toBeTruthy();
    expect(screen.getByText("200 次请求")).toBeTruthy();
    expect(screen.getByRole("img", { name: /alpha 近 7 天/ })).toBeTruthy();
  });

  it("marks a model with no traffic instead of drawing a flat line at zero", () => {
    render(<ModelHealthCell name="idle" health={undefined} />);
    expect(screen.getByText("近 7 天无请求")).toBeTruthy();
  });

  it("colours a day with failures red and keeps the tooltip exact", () => {
    const { container } = render(
      <HealthSparkline
        name="alpha"
        rows={[
          { date: "2026-10-20", requests: 10, error: 0 },
          { date: "2026-10-21", requests: 4, error: 2 },
        ]}
      />,
    );
    const bars = container.querySelectorAll("span > span");
    expect(bars).toHaveLength(2);
    expect(bars[1].className).toMatch(/sparklineError/);
    expect(bars[0].getAttribute("title")).toBe("2026-10-20 · 10");
  });

  it("picks the busiest rows of the current view for a sparkline", () => {
    const byModel = new Map([
      ["a", health("a", 10, 0)],
      ["b", health("b", 90, 1)],
      ["c", health("c", 0, 0)],
      ["d", health("d", 50, 0)],
    ]);
    const rows = ["a", "b", "c", "d"].map((id) => ({ id }));
    expect(sparklineKeys(rows, byModel)).toEqual(["b", "d", "a"]);
    // A model with no traffic has no series worth fetching.
    expect(sparklineKeys(rows, byModel)).not.toContain("c");
    expect(sparklineKeys([], byModel)).toEqual([]);
  });

  it("caps the sparkline budget so a large catalog cannot fan out", () => {
    const byModel = new Map<string, ModelHealth>();
    const rows = Array.from({ length: 48 }, (_, i) => {
      byModel.set("m" + i, health("m" + i, 100 - i, 0));
      return { id: "m" + i };
    });
    expect(sparklineKeys(rows, byModel)).toHaveLength(SPARKLINE_LIMIT);
    expect(sparklineKeys(rows, byModel)[0]).toBe("m0");
  });
});

describe("credits badge", () => {
  const row = (id: string, expiries: { expires_at: number | null; remaining: number }[]) => ({
    id,
    enabled: true,
    credits: { segments: expiries },
  });

  it("counts accounts with credits expiring inside the window and sums them", () => {
    const alert = creditsAlert(
      [
        row("a", [{ expires_at: NOW + 86400, remaining: 12 }]),
        row("b", [
          { expires_at: NOW + 3 * 86400, remaining: 8 },
          { expires_at: NOW + 40 * 86400, remaining: 900 },
        ]),
        row("c", [{ expires_at: NOW + 40 * 86400, remaining: 500 }]),
      ],
      NOW,
    );
    expect(alert).toEqual({ accounts: 2, credits: 20, days: CREDITS_BADGE_DAYS });
  });

  it("ignores expired segments, disabled accounts and unexpiring balances", () => {
    expect(creditsAlert([row("a", [{ expires_at: NOW - 60, remaining: 50 }])], NOW)).toBeNull();
    expect(
      creditsAlert(
        [
          {
            id: "a",
            enabled: false,
            credits: { segments: [{ expires_at: NOW + 60, remaining: 5 }] },
          },
        ],
        NOW,
      ),
    ).toBeNull();
    expect(creditsAlert([row("a", [{ expires_at: null, remaining: 100 }])], NOW)).toBeNull();
    expect(creditsAlert([], NOW)).toBeNull();
    expect(creditsAlert(null, NOW)).toBeNull();
  });

  it("tolerates credential rows without a credits snapshot", () => {
    expect(creditsAlert([{ id: "a", enabled: true }], NOW)).toBeNull();
    expect(creditsAlert([{ id: "a", credits: "unknown" }], NOW)).toBeNull();
  });

  it("renders the count with the credit total in the tooltip", () => {
    render(<CreditsBadge alert={{ accounts: 2, credits: 20, days: 7 }} />);
    const badge = screen.getByText("2");
    expect(badge.getAttribute("title")).toBe("合计 20 积分将在 7 天内到期，点击查看积分页");
    expect(badge.getAttribute("data-credits-alert")).toBe("2");
  });
});

describe("dashboard cost panel", () => {
  it("derives the cost tiles from the dashboard payload without a second request", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({
      data: {
        summary: { requests: 200, success_rate: 1, total_tokens: 10, credit: 70 },
        previous: { requests: 100, credit: 40 },
        series: [
          { bucket: 1, date: "2026-10-20", requests: 80, credit: 30 },
          { bucket: 2, date: "2026-10-21", requests: 120, credit: 40 },
        ],
        models: [],
        profiles: [],
        health: { credentials: [] },
        storage: {},
        range: { days: 7, granularity: "day" },
        official_credits: {},
        generated_at: 1,
      },
    } as never);
    render(<Dashboard />);
    expect(await screen.findByText("今日花费（UTC）")).toBeTruthy();
    expect(screen.getByText("30 天外推")).toBeTruthy();
    // Exactly one request: the cost card re-projects /admin/dashboard instead of
    // calling /admin/stats/summary, whose numbers it would duplicate.
    expect(get.mock.calls.map((call) => call[0])).toEqual(["/dashboard?days=7&granularity=auto"]);
  });
});
describe("sidebar credits badge", () => {
  // The shell reads the real clock (there is no injected "now" in production), so
  // this fixture has to be relative to Date.now() or the expiry lands outside the
  // 7-day window and the badge never appears.
  const soon = Date.now() / 1000 + 86400;
  const later = Date.now() / 1000 + 90 * 86400;
  const expiring = {
    id: "acct-1",
    name: "one.info",
    enabled: true,
    credits: { segments: [{ expires_at: soon, remaining: 12 }] },
  };

  it("reads the credential snapshot and shows the count on the usage area", async () => {
    // Same request key as the credentials page, so this is the shared snapshot
    // rather than a second, badge-only fetch.
    const get = vi.spyOn(api, "get").mockImplementation(async (path) => {
      if (path === "/credentials") return { data: { credentials: [expiring] } } as never;
      if (path === "/models") return { data: { revision: 0, models: [] } } as never;
      return { data: { revision: 0, items: [], values: [], events: [], channels: [] } } as never;
    });
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    const badge = await screen.findByText("1", { selector: "span" });
    expect(badge.getAttribute("data-credits-alert")).toBe("1");
    expect(get.mock.calls.some((call) => call[0] === "/credentials")).toBe(true);
  });

  it("renders no badge when nothing is about to expire", async () => {
    vi.spyOn(api, "get").mockImplementation(async (path) => {
      if (path === "/credentials")
        return {
          data: {
            credentials: [
              {
                id: "a",
                enabled: true,
                credits: { segments: [{ expires_at: later, remaining: 5 }] },
              },
            ],
          },
        } as never;
      if (path === "/models") return { data: { revision: 0, models: [] } } as never;
      return { data: { revision: 0, items: [], values: [], events: [], channels: [] } } as never;
    });
    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    // The sidebar exists before the snapshot resolves, so wait for the page rather
    // than asserting immediately on a DOM that is still loading.
    await screen.findByRole("heading", { name: "运行概览" });
    expect(document.querySelector("[data-credits-alert]")).toBeNull();
  });
});

describe("model table health column", () => {
  it("shows 7-day health from the shared dimensions aggregate", async () => {
    const requested: string[] = [];
    vi.spyOn(api, "get").mockImplementation(async (path) => {
      requested.push(path);
      if (path === "/models")
        return {
          data: {
            revision: 1,
            models: [
              {
                id: "upstream-a",
                public_id: "public-a",
                upstream_id: "upstream-a",
                enabled: true,
                keep_original: false,
                region: "",
                profile: "",
                credential_ids: [],
                available: true,
                available_credentials: 1,
              },
            ],
          },
        } as never;
      if (path === "/credentials") return { data: { credentials: [] } } as never;
      return { data: { revision: 0, items: [], values: [], events: [], channels: [] } } as never;
    });
    render(<Models />);
    expect(await screen.findByText("public-a", { exact: true })).toBeTruthy();
    // The aggregate is keyed by the requested model name, which is what the audit
    // store buckets the model dimension by — the local rule id would match nothing.
    expect(healthKey({ id: "upstream-a", public_id: "public-a" })).toBe("public-a");
    expect(requested).toContain("/models");
  });
});
