import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LineChart, StackedBars, type ChartBucket } from "./charts";
import { countdownText, useDebouncedValue } from "./hooks";
import {
  FUSION_DEVELOPMENT,
  FusionAbortError,
  fusionGet,
  fusionMutate,
  useFusionResource,
} from "./fusion/client";
import { __resetFusionMock, __setFusionLatency, mockRequest } from "./fusion/mock";
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
