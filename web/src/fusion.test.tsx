import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LineChart, StackedBars, type ChartBucket } from "./charts";
import { countdownText, useDebouncedValue, useOptimisticOverrides } from "./hooks";
import {
  FUSION_DEVELOPMENT,
  FusionAbortError,
  fusionGet,
  fusionMutate,
  useFusionResource,
} from "./fusion/client";
import { __resetFusionMock, __setFusionLatency, mockRequest } from "./fusion/mock";
import { Alerts } from "./pages/Alerts";
import { Credits } from "./pages/Credits";
import { Diagnostics } from "./pages/Diagnostics";
import { Trends } from "./pages/Trends";

beforeEach(() => {
  __resetFusionMock();
  __setFusionLatency(0);
});
afterEach(() => {
  // A failing assertion inside a fake-timer test must not leak fake timers into
  // later tests (they would freeze the mock latency forever).
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mock fixture respects the fusion contract", () => {
  it("serves status, diagnostic and credits shapes", () => {
    const status = mockRequest("GET", "/admin/status");
    expect(status.status).toBe(200);
    const statusData = status.data as Record<string, unknown>;
    expect(statusData.service).toBe("codebuddy2api");
    const pool = statusData.pool as Record<string, unknown>;
    expect(typeof pool.total).toBe("number");
    expect(typeof pool.servable).toBe("boolean");
    const diagnostic = mockRequest("GET", "/admin/diagnostic").data as Record<string, unknown>;
    expect(Array.isArray(diagnostic.accounts)).toBe(true);
    expect(Array.isArray(diagnostic.model_locks)).toBe(true);
    const credits = mockRequest("GET", "/admin/credits/expiry").data as Record<string, unknown>;
    expect(credits.threshold_days).toBe(3);
    expect(Array.isArray(credits.items)).toBe(true);
  });
  it("validates series dimension/key pairing exactly as documented", () => {
    expect(() =>
      mockRequest(
        "GET",
        "/admin/stats/series",
        new URLSearchParams({ dimension: "global", key: "x" }),
      ),
    ).toThrow();
    expect(() =>
      mockRequest("GET", "/admin/stats/series", new URLSearchParams({ dimension: "model" })),
    ).toThrow();
    const ok = mockRequest(
      "GET",
      "/admin/stats/series",
      new URLSearchParams({
        days: "1",
        granularity: "hour",
        dimension: "model",
        key: "deepseek-chat",
      }),
    ).data as Record<string, unknown>;
    const series = ok.series as Array<Record<string, unknown>>;
    expect(series).toHaveLength(24);
    expect(typeof series[0]?.bucket).toBe("number");
    // Quantiles stay null for empty buckets instead of being invented as 0.
    expect(
      series[0]?.latency_p95_ms === null || typeof series[0]?.latency_p95_ms === "number",
    ).toBe(true);
  });
  it("keeps buckets deterministic per params", () => {
    const seed = { dimension: "model", key: "deepseek-chat" };
    const a = mockRequest("GET", "/admin/stats/series", new URLSearchParams(seed)).data as Record<
      string,
      unknown
    >;
    const b = mockRequest("GET", "/admin/stats/series", new URLSearchParams(seed)).data as Record<
      string,
      unknown
    >;
    expect((a.series as unknown[]).length).toEqual((b.series as unknown[]).length);
    expect((a.summary as Record<string, unknown>).requests).toEqual(
      (b.summary as Record<string, unknown>).requests,
    );
  });
  it("toggles paused and never echoes secrets from the channels read endpoint", () => {
    const paused = mockRequest("PATCH", "/admin/credentials/cn-mainland-b", new URLSearchParams(), {
      paused: true,
    }).data as Record<string, unknown>;
    expect(paused).toMatchObject({ field: "paused", paused: true, enabled: false });
    const after = mockRequest("GET", "/admin/diagnostic").data as Record<string, unknown>;
    const account = ((after.accounts as Array<Record<string, unknown>>).find(
      (row) => row.id === "cn-mainland-b",
    ) ?? {}) as Record<string, unknown>;
    expect(account.paused).toBe(true);
    expect(account.disabled_reason).toBe("人工停用");
    const channels = mockRequest("GET", "/admin/alerts/channels").data as Record<string, unknown>;
    const list = channels.channels as Record<string, Record<string, unknown>>;
    expect(String(list.webhook?.url_masked)).toBe("https://hook.example.com/ingest");
    expect(String(list.bark?.key_masked)).toMatch(/\*\*\*\*/);
    // An unset SMTP password is null per the contract, never a fake mask.
    expect(list.email?.password_masked).toBeNull();
  });
  it("masks secrets after a full channel overwrite and cannot test an unenabled channel", () => {
    const saved = mockRequest("PUT", "/admin/alerts/channels", new URLSearchParams(), {
      channels: {
        webhook: { enabled: false, url: "" },
        bark: { enabled: true, server: "", key: "abcdef1234", sound: "bell" },
        email: {
          enabled: true,
          smtp_host: "smtp.example.com",
          smtp_port: 465,
          username: "alert@example.com",
          password: "leak-check-secret-value",
          from: "alert@example.com",
          to: ["ops@example.com"],
          use_tls: true,
        },
      },
    }).data as Record<string, unknown>;
    const list = saved.channels as Record<string, Record<string, unknown>>;
    expect(list.bark?.enabled).toBe(true);
    expect(list.webhook?.enabled).toBe(false);
    expect(list.email?.password_masked).toBe("********");
    // The written secret never comes back readable (has_secret is only a flag).
    expect(JSON.stringify(saved)).not.toContain("leak-check-secret-value");
    expect(() =>
      mockRequest("POST", "/admin/alerts/test", new URLSearchParams({ channel: "webhook" })),
    ).toThrow();
    const test = mockRequest("POST", "/admin/alerts/test", new URLSearchParams({ channel: "bark" }))
      .data as Record<string, unknown>;
    expect(typeof test.ok).toBe("boolean");
  });
  it("returns 404 envelopes for unimplemented paths", () => {
    expect(mockRequest("GET", "/admin/nope").status).toBe(404);
  });
});

describe("fusion client", () => {
  it("is in development mode against the local fixture while the backend lands", () => {
    expect(FUSION_DEVELOPMENT).toBe(true);
  });
  it("resolves contract-shaped payloads and surfaces backend errors", async () => {
    const status = (await fusionGet("/admin/status")) as Record<string, unknown>;
    expect(status.service).toBe("codebuddy2api");
    await expect(fusionGet("/admin/nope")).rejects.toThrow(/尚未部署|未实现/);
  });
  it("mutates through the same seam as reads", async () => {
    const result = (await fusionMutate("PATCH", "/admin/credentials/cn-mainland-a", {
      paused: true,
    })) as Record<string, unknown>;
    expect(result).toMatchObject({ field: "paused", paused: true, enabled: false });
  });
  it("loads resources on demand and surfaces failures that are not aborts", async () => {
    const { result } = renderHook(() =>
      useFusionResource("/admin/status", null, (value) => value as Record<string, unknown>),
    );
    await waitFor(() => expect(result.current.data?.service).toBe("codebuddy2api"));
    expect(result.current.error).toBeNull();
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data?.service).toBe("codebuddy2api"));
    const failing = renderHook(() =>
      useFusionResource("/admin/nope", null, (value) => value as Record<string, unknown>),
    );
    await waitFor(() => expect(failing.result.current.error).toBeTruthy());
  });
  it("does not surface abort rejections as phantom errors", async () => {
    const controller = new AbortController();
    __setFusionLatency(50);
    const promise = fusionGet("/admin/status", new URLSearchParams(), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(FusionAbortError);
  });
});

describe("charts", () => {
  const rows: ChartBucket[] = [
    {
      bucket: 1000,
      date: "2026-10-01",
      requests: 10,
      success: 9,
      error: 1,
      total_tokens: 100,
      tokens_per_s: 30,
    },
    {
      bucket: 86400 + 1000,
      date: "2026-10-02",
      requests: 20,
      success: 18,
      error: 2,
      total_tokens: 200,
      tokens_per_s: 40,
    },
  ];
  it("draws stacked bars, the mean reference and peak annotation with hover detail", () => {
    render(<StackedBars rows={rows} granularity="day" />);
    const chart = screen.getByRole("img");
    expect(chart.querySelectorAll("rect").length).toBeGreaterThanOrEqual(4);
    expect(chart.textContent ?? "").toContain("均值");
    expect(chart.textContent ?? "").toContain("峰值");
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({
      left: 0,
      width: 1160,
    } as DOMRect);
    fireEvent(chart, new MouseEvent("pointermove", { bubbles: true, clientX: 1100 }));
    expect(screen.getByRole("status").textContent).toContain("2026-10-02");
    fireEvent.keyDown(chart, { key: "Home" });
    expect(screen.getByRole("status").textContent).toContain("2026-10-01");
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("renders an empty state without fabricating data", () => {
    render(<StackedBars rows={[]} granularity="day" />);
    expect(screen.getByText("当前时间范围内暂无请求")).toBeTruthy();
  });
  it("breaks percentile lines on unknown buckets and always keeps one series", () => {
    const partial: ChartBucket[] = [
      {
        bucket: 1000,
        date: "2026-10-01",
        latency_p50_ms: 100,
        latency_p95_ms: 300,
        latency_p99_ms: 900,
      },
      {
        bucket: 90000,
        date: "2026-10-02",
        latency_p50_ms: null,
        latency_p95_ms: null,
        latency_p99_ms: null,
      },
      {
        bucket: 180000,
        date: "2026-10-03",
        latency_p50_ms: 150,
        latency_p95_ms: 350,
        latency_p99_ms: 950,
      },
    ];
    render(
      <LineChart
        rows={partial}
        granularity="day"
        metrics={[
          { key: "latency_p50_ms", label: "P50", unit: "ms", color: "accent" },
          { key: "latency_p95_ms", label: "P95", unit: "ms", color: "strong" },
          { key: "latency_p99_ms", label: "P99", unit: "ms", color: "error" },
        ]}
      />,
    );
    const chart = screen.getByRole("img");
    // Every metric splits into two segments around the null bucket.
    expect(chart.querySelectorAll("polyline").length).toBe(6);
    const buttons = screen.getAllByRole("button");
    fireEvent.click(buttons[2]!); // hide P99
    expect(chart.querySelectorAll("polyline").length).toBe(4);
    fireEvent.click(buttons[1]!); // hide P95
    expect(chart.querySelectorAll("polyline").length).toBe(2);
    fireEvent.click(buttons[1]!); // show P95 again
    expect(chart.querySelectorAll("polyline").length).toBe(4);
    fireEvent.click(buttons[0]!); // hide P50, leaving P95
    expect(chart.querySelectorAll("polyline").length).toBe(2);
    fireEvent.click(buttons[1]!); // hiding the last visible series is refused
    expect(chart.querySelectorAll("polyline").length).toBe(2);
  });

  // WCAG 1.4.1: colour may not be the only channel. These two tests fail if a
  // refactor drops the dash cycle or the marker shapes back to colour-only.
  it("encodes every line series with its own dash pattern and marker shape", () => {
    const rows: ChartBucket[] = [0, 86400, 172800].map((bucket, index) => ({
      bucket,
      date: `2026-10-0${index + 1}`,
      latency_p50_ms: 100 + index * 10,
      latency_p95_ms: 300 + index * 10,
      latency_p99_ms: 900 + index * 10,
      tokens_per_s: 20 + index,
    }));
    const metrics = [
      { key: "latency_p50_ms", label: "P50", unit: "ms", color: "accent" as const },
      { key: "latency_p95_ms", label: "P95", unit: "ms", color: "strong" as const },
      { key: "latency_p99_ms", label: "P99", unit: "ms", color: "error" as const },
    ];
    render(<LineChart rows={rows} metrics={metrics} />);
    const chart = screen.getByRole("img");
    const series = [...chart.querySelectorAll("g[data-series]")];
    expect(series.map((node) => node.getAttribute("data-series"))).toEqual([
      "latency_p50_ms",
      "latency_p95_ms",
      "latency_p99_ms",
    ]);
    // Distinct dash per series; the first one is solid (no strokeDasharray attr).
    const dashes = series.map(
      (node) => node.querySelector("polyline")?.getAttribute("stroke-dasharray") ?? "solid",
    );
    expect(dashes).toEqual(["solid", "6 4", "2 4"]);
    // Distinct marker shape per series: circle, square (path), triangle (polygon).
    const shapes = series.map((node) =>
      node.querySelector("circle, polygon, path:not(polyline)")?.tagName.toLowerCase(),
    );
    expect(shapes).toEqual(["circle", "path", "polygon"]);
    // One marker per data point, so a single-point segment is still identifiable.
    for (const node of series)
      expect(node.querySelectorAll("circle, polygon, path").length).toBe(3);
  });

  it("draws a legend key with the dash preview, not a bare colour chip", () => {
    const rows: ChartBucket[] = [
      { bucket: 0, date: "2026-10-01", latency_p50_ms: 10, latency_p95_ms: 20, latency_p99_ms: 30 },
    ];
    render(
      <LineChart
        rows={rows}
        metrics={[
          { key: "latency_p50_ms", label: "P50", unit: "ms", color: "accent" },
          { key: "latency_p95_ms", label: "P95", unit: "ms", color: "strong" },
        ]}
      />,
    );
    const legend = screen.getByRole("group", { name: "曲线图例" });
    const keys = [...legend.querySelectorAll("button i")];
    // Two chips per series: the shape and the dash preview.
    expect(keys.length).toBe(4);
    expect(
      keys.some((node) => (node.getAttribute("style") ?? "").includes("repeating-linear-gradient")),
    ).toBe(true);
  });

  it("lets the stacked bars hide one outcome and shrinks the stack instead of leaving a gap", () => {
    render(<StackedBars rows={rows} granularity="day" />);
    const chart = screen.getByRole("img");
    const legend = screen.getByRole("group", { name: "曲线图例" });
    const [success, error] = [...legend.querySelectorAll("button")];
    expect(success!.getAttribute("aria-pressed")).toBe("true");
    // 2 bars x (success + error + hatch) = 6 painted rects while both are on.
    expect(chart.querySelectorAll("rect").length).toBe(6);
    fireEvent.click(success!);
    expect(success!.getAttribute("aria-pressed")).toBe("false");
    // Only the error segment and its hatch remain, at the reduced height.
    expect(chart.querySelectorAll("rect").length).toBe(4);
    // Hiding the last visible series is refused, same rule as the line chart.
    fireEvent.click(error!);
    expect(error!.getAttribute("aria-pressed")).toBe("true");
    expect(chart.querySelectorAll("rect").length).toBe(4);
  });
});

describe("shared hooks", () => {
  it("formats countdowns and treats unset deadlines as unknown", () => {
    const now = Date.parse("2026-10-11T01:00:00Z");
    vi.useFakeTimers().setSystemTime(now);
    expect(countdownText(now / 1000 + 92, "—", now)).toBe("1:32");
    expect(countdownText(now / 1000 + 3725, "—", now)).toBe("1:02:05");
    expect(countdownText(0, "无熔断", now)).toBe("无熔断");
    expect(countdownText(null, "—", now)).toBe("—");
    vi.useRealTimers();
  });
  it("defers rapidly changing values", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 100), {
      initialProps: { value: "a" },
    });
    expect(result.current).toBe("a");
    rerender({ value: "b" });
    expect(result.current).toBe("a");
    await act(async () => {
      vi.advanceTimersByTime(120);
    });
    expect(result.current).toBe("b");
    vi.useRealTimers();
  });
});

describe("Trends page", () => {
  it("shows skeletons first and loads series only after mount", async () => {
    render(<Trends />);
    expect(screen.getByRole("status", { name: "趋势图加载中" })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("img", { name: "按日请求量" })).toBeTruthy(), {
      timeout: 4000,
    });
    fireEvent.click(screen.getByRole("tab", { name: "延迟分位" }));
    await waitFor(() => expect(screen.getByText("P95")).toBeTruthy());
  });
  it("auto-selects the first key when switching to a split dimension", async () => {
    render(<Trends />);
    await waitFor(() => expect(screen.getByRole("img", { name: "按日请求量" })).toBeTruthy(), {
      timeout: 4000,
    });
    fireEvent.change(screen.getByLabelText("切分维度"), { target: { value: "model" } });
    await waitFor(() => expect(screen.getByLabelText("切分对象")).toBeTruthy());
    await waitFor(() => expect(screen.getByRole("img", { name: "按日请求量" })).toBeTruthy(), {
      timeout: 4000,
    });
  });
});
describe("Diagnostics page", () => {
  it("renders the transport failure badge and counter from the live contract", async () => {
    render(<Diagnostics />);
    await waitFor(() => expect(screen.getByText("intl-work-1.info")).toBeTruthy(), {
      timeout: 4000,
    });
    // Diagnostics.tsx:243 — an active penalty window wins over the plain counter.
    expect(screen.getByText("传输连败出池 120s")).toBeTruthy();
    // Diagnostics.tsx:250 — failures without a remaining penalty show the count.
    expect(screen.getByText("传输连败 3 次")).toBeTruthy();
    // Exactly one account is out of the pool, so exactly one badge may render.
    expect(screen.getAllByText(/传输连败出池/)).toHaveLength(1);
  });

  it("falls back to the normal state when an account has no fault at all", async () => {
    render(<Diagnostics />);
    await waitFor(() => expect(screen.getByText("mainland-a.info")).toBeTruthy(), {
      timeout: 4000,
    });
    // Diagnostics.tsx:257-262 — no disabled_reason, no sync_error, zero failures.
    const row = screen.getByText("mainland-a.info").closest("tr")!;
    expect(within(row).getByText("正常")).toBeTruthy();
    // A circuit-broken account explains itself instead of claiming to be normal.
    const broken = screen.getByText("mainland-b.info").closest("tr")!;
    expect(within(broken).queryByText("正常")).toBeNull();
    expect(within(broken).getByText("认证熔断")).toBeTruthy();
  });

  it("drops the circuit badge once the cooldown deadline has passed", async () => {
    render(<Diagnostics />);
    await waitFor(() => expect(screen.getByText("expired-cooldown.info")).toBeTruthy(), {
      timeout: 4000,
    });
    const row = screen.getByText("expired-cooldown.info").closest("tr")!;
    // The backend keeps reporting the stale reason until an explicit reset
    // (converter.py clear_cooldowns), so the view is the last line of defence:
    // fail_until is a positive epoch that is already in the past.
    expect(within(row).queryByText("无熔断")).toBeTruthy();
    expect(within(row).queryByText(/已结束|认证熔断|429/)).toBeNull();
    // A live deadline still renders, so the gate is not a blanket suppression.
    const live = screen.getByText("mainland-b.info").closest("tr")!;
    expect(within(live).queryByText("无熔断")).toBeNull();
    expect(within(live).getByText("backend HTTP 401")).toBeTruthy();
  });
});
describe("useOptimisticOverrides", () => {
  type Row = { id: string; enabled: boolean; paused: boolean };
  it("overlays the optimistic patch, then rolls the view back to the authoritative row", () => {
    const { result } = renderHook(() => useOptimisticOverrides<string>());
    const authoritative: Row = { id: "a", enabled: true, paused: false };
    expect(result.current.view(authoritative)).toEqual(authoritative);

    // The write is issued: the toggle flips before the server answers.
    act(() => result.current.apply("a", { enabled: false, paused: true }));
    expect(result.current.view(authoritative)).toEqual({ id: "a", enabled: false, paused: true });

    // The write rejects: the page calls clear(), so the row must return to the
    // authoritative value rather than keeping the phantom flip.
    act(() => result.current.clear("a"));
    expect(result.current.view(authoritative)).toEqual(authoritative);
  });

  it("keeps each key independent and ignores clearing an unknown key", () => {
    const { result } = renderHook(() => useOptimisticOverrides<string>());
    act(() => result.current.apply("a", { paused: true }));
    act(() => result.current.apply("b", { enabled: false }));
    expect(result.current.view({ id: "a", enabled: true, paused: false }).paused).toBe(true);
    expect(result.current.view({ id: "b", enabled: true, paused: false }).enabled).toBe(false);
    expect(result.current.view({ id: "c", enabled: true, paused: false }).paused).toBe(false);
    // Clearing a key that was never overridden must not disturb the others.
    act(() => result.current.clear("zzz"));
    expect(result.current.view({ id: "a", enabled: true, paused: false }).paused).toBe(true);
  });
});
describe("Alerts page", () => {
  it("lists the alert events with severity labels and the channel overview", async () => {
    render(<Alerts />);
    // Wait for an actual event, not the panel title, which renders before the fetch.
    await waitFor(() => expect(screen.getByText("积分即将到期")).toBeTruthy(), { timeout: 4000 });
    // eventsFixture() (fusion/mock.ts:196) ships one event per ALERT_KINDS entry.
    expect(screen.getByText("全池无可服务账号")).toBeTruthy();
    // Severity resolves through t() rather than the raw contract value.
    expect(screen.getAllByText("严重").length).toBeGreaterThan(0);
    // The channel overview is a second, independent fetch: await it rather than
    // asserting while its skeleton (role="status") is still on screen.
    // channelsFixture() enables webhook only, so the summary counts exactly one.
    await waitFor(() => expect(screen.getByText(/已启用通道 1 个/)).toBeTruthy(), {
      timeout: 4000,
    });
    expect(screen.getByText("Webhook")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getAllByText("未启用")).toHaveLength(2);
  });

  it("narrows the stream when the severity filter changes", async () => {
    render(<Alerts />);
    await waitFor(() => expect(screen.getByText("积分即将到期")).toBeTruthy(), { timeout: 4000 });
    fireEvent.change(screen.getByLabelText("事件级别"), { target: { value: "critical" } });
    // The critical-only refetch drops the warning-severity events (Alerts.tsx:71-76).
    await waitFor(() => expect(screen.queryByText("积分即将到期")).toBeNull(), { timeout: 4000 });
    expect(screen.getByText("全池无可服务账号")).toBeTruthy();
  });

  it("renders the empty state for a severity the backend has no events for", async () => {
    render(<Alerts />);
    await waitFor(() => expect(screen.getByText("积分即将到期")).toBeTruthy(), { timeout: 4000 });
    // The fixture holds warning/critical events only, so filtering by info must
    // exercise the empty branch (Alerts.tsx:172-174) through the real mock.
    fireEvent.change(screen.getByLabelText("事件级别"), { target: { value: "info" } });
    await waitFor(() => expect(screen.getByText("暂无告警事件")).toBeTruthy(), { timeout: 4000 });
    expect(
      screen.getByText("触发条件（余额耗尽、积分将到期、认证熔断等）满足时自动记录。"),
    ).toBeTruthy();
  });
});

describe("Credits page", () => {
  it("orders the FEFO batches by soonest expiry and flags the urgent account", async () => {
    render(<Credits />);
    await waitFor(() => expect(screen.getByText("mainland-a.info")).toBeTruthy(), {
      timeout: 4000,
    });
    // mock creditsExpiry (fusion/mock.ts:783) sorts by days_remaining ascending.
    expect(screen.getAllByText(/\.info$/).map((node) => node.textContent)).toEqual([
      "mainland-a.info",
      "work-buddy.info",
      "intl-pro.info",
    ]);
    // mainland-a expires in 2.1 days, inside the 3-day threshold.
    const card = screen.getByText("mainland-a.info").closest("section")!;
    expect(within(card).getByText("紧急")).toBeTruthy();
    expect(within(card).getByText("旗舰版连续包月")).toBeTruthy();
    expect(screen.getByText("到期分布")).toBeTruthy();
  });

  it("marks a non-urgent account with its days-to-expiry instead of the urgent badge", async () => {
    render(<Credits />);
    await waitFor(() => expect(screen.getByText("intl-pro.info")).toBeTruthy(), { timeout: 4000 });
    const card = screen.getByText("intl-pro.info").closest("section")!;
    expect(within(card).queryByText("紧急")).toBeNull();
    expect(within(card).getByText(/天后到期/)).toBeTruthy();
  });

  it("reveals batches outside the default window when the display window widens", async () => {
    render(<Credits />);
    await waitFor(() => expect(screen.getByText("mainland-a.info")).toBeTruthy(), {
      timeout: 4000,
    });
    // mainland-a's 44-day batch is excluded at the default 30-day window...
    expect(screen.queryByText("团队版年付")).toBeNull();
    fireEvent.change(screen.getByLabelText("展示窗口"), { target: { value: "90" } });
    // ...and included once the window covers it.
    await waitFor(() => expect(screen.getByText("团队版年付")).toBeTruthy(), { timeout: 4000 });
  });
});
