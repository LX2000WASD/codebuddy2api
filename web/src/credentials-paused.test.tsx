import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, useResource } from "./api";
import { fusionMutate } from "./fusion/client";
import { Credentials } from "./pages/Credentials";

// Regression tests for the fusion-layer UI increments on the credentials page.
// These assert *request counts* and *rendered truth*, not implementation detail:
// the 2026-10-21 incident was ~520 /admin/logs requests per second while the
// detail drawer stayed open after any switch inside it was toggled.
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  useResource: vi.fn(),
}));
vi.mock("./fusion/client", async (original) => ({
  ...(await original<typeof import("./fusion/client")>()),
  fusionMutate: vi.fn(),
}));

const row = {
  id: "one",
  name: "one.info",
  enabled: true,
  paused: false,
  profile: "cn-cli",
  health: "ready",
};

function mockRow(overrides: Record<string, unknown> = {}) {
  vi.mocked(useResource).mockReturnValue({
    data: [{ ...row, ...overrides }],
    reload: vi.fn(),
    loading: false,
    error: null,
  });
}

// The drawer re-renders the same switches as the row behind it, so drawer
// assertions are scoped to the dialog element.
function drawer(): HTMLElement {
  const el = document.querySelector("dialog");
  if (!el) throw new Error("detail drawer is not open");
  return el as HTMLElement;
}
const logsCalls = (get: { mock: { calls: unknown[][] } }) =>
  get.mock.calls.filter(([path]) => String(path).startsWith("/logs?")).length;

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("credential detail drawer request budget", () => {
  it("fetches /admin/logs once when opened and never again on a toggle", async () => {
    mockRow();
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: { items: [] } });
    vi.mocked(fusionMutate).mockResolvedValue({ id: "one", paused: true });
    render(<Credentials />);

    // Open the drawer on its default (overview) tab: exactly one logs request.
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    expect(await screen.findByText("暂无该凭证的请求明细")).toBeTruthy();
    expect(logsCalls(get)).toBe(1);

    // Toggle the paused switch inside the drawer. The optimistic overlay makes
    // every render produce a fresh derived row; the effect must not follow it.
    await act(async () =>
      fireEvent.click(within(drawer()).getByRole("switch", { name: "暂停账号 one.info" })),
    );
    expect(fusionMutate).toHaveBeenCalled();
    expect(logsCalls(get)).toBe(1);
    expect(await screen.findByText(/账号已暂停/)).toBeTruthy();
  });

  it("re-fetches once per overview visit instead of once per render", async () => {
    mockRow();
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: { items: [] } });
    render(<Credentials />);
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    await screen.findByText("暂无该凭证的请求明细");
    expect(logsCalls(get)).toBe(1);
    // Leaving the overview tab fetches nothing; coming back fetches once.
    fireEvent.click(screen.getByRole("tab", { name: "自动化配置" }));
    expect(logsCalls(get)).toBe(1);
    fireEvent.click(screen.getByRole("tab", { name: "概览与请求" }));
    expect(logsCalls(get)).toBe(2);
  });
});

describe("paused switch reads the authoritative row field", () => {
  it("shows a paused account as paused while enabled stays enabled", () => {
    // The backend keeps paused and enabled orthogonal; /admin/credentials rows
    // carry both (admin_api.py whitelist + pool.snapshot). Deriving paused from
    // enabled showed this account as "运行中" after a refresh.
    mockRow({ enabled: true, paused: true });
    vi.spyOn(api, "get").mockResolvedValue({ data: { items: [] } });
    render(<Credentials />);
    const paused = screen.getByRole("switch", { name: "暂停账号 one.info" });
    const enabled = screen.getByRole("switch", { name: "启用状态 one.info" });
    expect((paused as HTMLInputElement).checked).toBe(true);
    expect((enabled as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("已暂停")).toBeTruthy();
    expect(screen.getByText("已启用")).toBeTruthy();
  });

  it("does not report a disabled-but-not-paused account as paused", () => {
    mockRow({ enabled: false, paused: false });
    vi.spyOn(api, "get").mockResolvedValue({ data: { items: [] } });
    render(<Credentials />);
    const paused = screen.getByRole("switch", { name: "暂停账号 one.info" }) as HTMLInputElement;
    expect(paused.checked).toBe(false);
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(screen.getByText("人工停用")).toBeTruthy();
  });

  it("writes only the paused flag, so a failed write cannot fake an enabled change", async () => {
    mockRow({ enabled: true, paused: false });
    vi.spyOn(api, "get").mockResolvedValue({ data: { items: [] } });
    vi.mocked(fusionMutate).mockResolvedValue({ id: "one", paused: true });
    render(<Credentials />);
    await act(async () =>
      fireEvent.click(screen.getByRole("switch", { name: "暂停账号 one.info" })),
    );
    expect(vi.mocked(fusionMutate)).toHaveBeenCalledWith("PATCH", "/admin/credentials/one", {
      paused: true,
    });
  });
});
