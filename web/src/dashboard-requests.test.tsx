import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { api } from "./api";
import { Dashboard } from "./pages/Dashboard";

// The dashboard used to issue a second, byte-identical /dashboard request
// (~1.35 MB) whenever it asked for hourly buckets, and to prefetch the hourly
// series unconditionally in auto mode even for users who never zoom.
afterEach(() => vi.restoreAllMocks());

function fixture(grain: "hour" | "day", length: number) {
  return {
    data: {
      summary: { requests: 2, success_rate: 1, total_tokens: 10, credit: 1 },
      series: Array.from({ length }, (_, i) => ({
        bucket: 1789344000 + i * (grain === "hour" ? 3600 : 86400),
        date: `2026-09-14 ${i}`,
        requests: 1,
        success: 1,
        error: 0,
        total_tokens: 1,
        credit: 0,
      })),
      models: [],
      profiles: [],
      health: { credentials: [] },
      storage: {},
      range: { granularity: grain },
    },
  };
}

function mockDashboard() {
  return vi.spyOn(api, "get").mockImplementation(async (path) => {
    const query = new URL(String(path), "https://isolated.invalid").searchParams;
    const hourly = query.get("granularity") === "hour" || query.get("days") === "1";
    return hourly ? fixture("hour", 24) : fixture("day", 7);
  });
}

const dashboardCalls = (get: { mock: { calls: unknown[][] } }) =>
  get.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith("/dashboard"));

describe("dashboard request budget", () => {
  it("does not fetch the same hourly payload twice", async () => {
    const get = mockDashboard();
    render(<Dashboard />);
    await screen.findByRole("img", { name: "按日用量趋势" });
    fireEvent.change(screen.getByLabelText("统计粒度"), { target: { value: "hour" } });
    await screen.findByRole("img", { name: "按小时用量趋势" });
    // Let any trailing effect fire before counting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const hourly = dashboardCalls(get).filter((path) => path.endsWith("granularity=hour"));
    expect(hourly).toEqual(["/dashboard?days=7&granularity=hour"]);
  });

  it("does not prefetch hourly buckets in auto mode", async () => {
    const get = mockDashboard();
    render(<Dashboard />);
    await screen.findByRole("img", { name: "按日用量趋势" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(dashboardCalls(get).filter((path) => path.includes("granularity=hour"))).toEqual([]);
    expect(dashboardCalls(get)).toEqual(["/dashboard?days=7&granularity=auto"]);
  });

  it("loads hourly buckets once the user zooms in", async () => {
    const get = mockDashboard();
    render(<Dashboard />);
    const chart = await screen.findByRole("img", { name: "按日用量趋势" });
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({ left: 0, width: 780 } as DOMRect);
    // The first zoom is the demand signal for the hourly series.
    fireEvent.wheel(chart, { deltaY: -100, clientX: 400, cancelable: true, bubbles: true });
    await waitFor(() =>
      expect(dashboardCalls(get).filter((path) => path.includes("granularity=hour"))).toEqual([
        "/dashboard?days=7&granularity=hour",
      ]),
    );
  });
});
