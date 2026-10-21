import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, useSession } from "./api";
import { AppRoutes } from "./App";
import { areaForPath, navAreas, sectionFor, sectionTarget } from "./navigation";

function Location() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname + location.search}</span>;
}

function mount(path: string) {
  useSession.setState({ status: "authenticated", csrf: "synthetic" });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
      <Location />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  // Every page under test renders inside an area; none of them may reach the network
  // for this suite. Each endpoint still needs a payload its parser accepts, otherwise
  // the page throws instead of rendering and the test measures an unrelated failure.
  vi.spyOn(api, "get").mockImplementation(async (path) => ({
    data:
      path === "/models"
        ? { revision: 0, models: [] }
        : path === "/credentials"
          ? { credentials: [] }
          : { revision: 0, items: [], values: [], events: [], channels: [], models: [] },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("navigation consolidation", () => {
  it("exposes exactly five task areas, each with the sections it absorbed", () => {
    expect(navAreas.map((area) => area.path)).toEqual([
      "/dashboard",
      "/dashboard/requests",
      "/dashboard/usage",
      "/dashboard/routing",
      "/dashboard/system",
    ]);
    const absorbed = navAreas.flatMap((area) => area.sections.map((section) => section.key));
    // Ten former pages must all still be reachable as a section — consolidation is
    // navigation-only, so a missing key here would be a silently dropped feature.
    expect(absorbed.sort()).toEqual(
      [
        "alerts",
        "credentials",
        "credits",
        "diagnostics",
        "models",
        "overview",
        "requests",
        "settings",
        "storage",
        "trends",
      ].sort(),
    );
  });

  it("resolves the area for a path, preferring the longest match", () => {
    expect(areaForPath("/dashboard")?.key).toBe("overview");
    expect(areaForPath("/dashboard/routing")?.key).toBe("routing");
    expect(areaForPath("/dashboard/routing/")?.key).toBe("routing");
    expect(areaForPath("/dashboard/nowhere")).toBeUndefined();
  });

  it("falls back to the first section for an unknown or missing section value", () => {
    const routing = navAreas.find((area) => area.key === "routing")!;
    expect(sectionFor(routing, null).key).toBe("models");
    expect(sectionFor(routing, "credentials").key).toBe("credentials");
    expect(sectionFor(routing, "bogus").key).toBe("models");
    // The first section is addressed by the bare area path so the common case has
    // no query string to keep in sync with the backend page whitelist.
    expect(sectionTarget(routing, "models")).toBe("/dashboard/routing");
    expect(sectionTarget(routing, "credentials")).toBe("/dashboard/routing?section=credentials");
  });

  it.each([
    ["/dashboard/models", "/dashboard/routing"],
    ["/dashboard/credentials", "/dashboard/routing?section=credentials"],
    ["/dashboard/logs", "/dashboard/requests"],
    ["/dashboard/trends", "/dashboard/usage"],
    ["/dashboard/credits", "/dashboard/usage?section=credits"],
    ["/dashboard/settings", "/dashboard/system"],
    ["/dashboard/storage", "/dashboard/system?section=storage"],
    ["/dashboard/alerts", "/dashboard/system?section=alerts"],
    ["/dashboard/diagnostics", "/dashboard/system?section=diagnostics"],
  ])("redirects the retired page %s to %s instead of 404ing", (from, to) => {
    mount(from);
    expect(screen.getByTestId("location").textContent).toBe(to);
  });

  it("renders the section switcher only where an area holds more than one page", async () => {
    // A single-section area must not grow a one-button switcher; the page itself may
    // still render tabs of its own, so the query is scoped to the named landmark.
    const single = mount("/dashboard/requests");
    expect(screen.queryByRole("navigation", { name: "请求分区" })).toBeNull();
    single.unmount();
    mount("/dashboard/system");
    const switcher = await screen.findByRole("navigation", { name: "系统分区" });
    const buttons = Array.from(switcher.querySelectorAll("button"));
    expect(buttons.map((button) => button.textContent)).toEqual([
      "系统设置",
      "存储管理",
      "告警中心",
      "诊断",
    ]);
    expect(buttons[0].getAttribute("aria-current")).toBe("page");
    expect(buttons[1].getAttribute("aria-current")).toBeNull();
  });

  it("switches sections through the URL so the choice survives a reload", async () => {
    mount("/dashboard/routing");
    const switcher = await screen.findByRole("navigation", { name: "路由与账号分区" });
    fireEvent.click(within(switcher).getByRole("button", { name: "凭证管理" }));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/dashboard/routing?section=credentials",
      ),
    );
    // The breadcrumb follows the active section rather than staying on the area name.
    expect(screen.getByText(/路由与账号 \/ 凭证管理/)).toBeTruthy();
  });

  it("keeps the area highlighted while one of its sections is open", async () => {
    mount("/dashboard/routing?section=credentials");
    const link = await screen.findByRole("link", { name: "路由与账号" });
    expect(link.className).toMatch(/_active_/);
  });
});

describe("command palette", () => {
  it("opens on Cmd+K, jumps to a page and closes", async () => {
    mount("/dashboard");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText("搜索页面或动作…");
    fireEvent.change(input, { target: { value: "告警" } });
    const option = screen.getByRole("option", { name: /告警中心/ });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/dashboard/system?section=alerts"),
    );
    expect(screen.queryByPlaceholderText("搜索页面或动作…")).toBeNull();
    void option;
  });

  it("runs actions, not only navigation", async () => {
    mount("/dashboard");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByPlaceholderText("搜索页面或动作…");
    // Theme and language are real state changes the palette owns, so it is a
    // launcher rather than a second, slower sidebar.
    fireEvent.change(input, { target: { value: "深色" } });
    fireEvent.click(screen.getByRole("option", { name: /外观：深色/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.queryByPlaceholderText("搜索页面或动作…")).toBeNull();
  });

  it("closes on Escape and reports an empty result set", async () => {
    mount("/dashboard");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText("搜索页面或动作…");
    fireEvent.change(input, { target: { value: "zzz-no-match" } });
    expect(screen.getByText("没有匹配的页面或动作")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByPlaceholderText("搜索页面或动作…")).toBeNull();
  });
});
