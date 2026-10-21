import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, useResource } from "./api";
import { Settings } from "./pages/Settings";
import { CONFIRM_PHRASE, usePendingRestart } from "./settingsSchema";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  useResource: vi.fn(),
}));
beforeEach(() => vi.restoreAllMocks());

/** Shape returned by GET /admin/settings for max_concurrent once it is in SCHEMA. */
const maxConcurrent = {
  key: "max_concurrent",
  label: "推理并发上限（0 不限制）",
  value: 64,
  stored: null,
  source: "default",
  mode: "hot",
  type: "integer",
  min: 0,
  max: 1024,
  locked: false,
};
const settings = {
  revision: 3,
  items: [maxConcurrent],
  audit: { degraded: false, logical_bytes: 0 },
  session: { degraded: false, last_error: null, path: "/tmp/admin-sessions.json" },
};
const base = {
  stored: null,
  source: "default",
  mode: "hot",
  type: "string",
  locked: false,
};

function resource(data: unknown) {
  vi.mocked(useResource).mockReturnValue({ data, error: null, loading: false, reload: vi.fn() });
}
function page(items: unknown[]) {
  resource({ ...settings, items });
}
function wrap() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}
/** max_concurrent is a high-risk key: saving it must pass the typed confirmation. */
function confirmHighRisk() {
  fireEvent.change(screen.getByLabelText(`输入“${CONFIRM_PHRASE}”以继续`), {
    target: { value: CONFIRM_PHRASE },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认修改" }));
}

describe("concurrency limit setting", () => {
  it("renders the schema-provided key as an editable number input with its bounds", () => {
    page([maxConcurrent]);
    wrap();
    const input = screen.getByLabelText("推理并发上限（0 不限制）") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.value).toBe("64");
    expect(input.min).toBe("0");
    expect(input.max).toBe("1024");
    expect(input.step).toBe("1");
    expect(input.disabled).toBe(false);
    expect(screen.getByText("即时生效")).toBeTruthy();
    expect(screen.getByText("默认值")).toBeTruthy();
  });

  it("submits the edited limit through PATCH /settings with the revision", async () => {
    page([maxConcurrent]);
    const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: {} });
    wrap();
    fireEvent.change(screen.getByLabelText("推理并发上限（0 不限制）"), { target: { value: "8" } });
    expect(screen.getByText("1 项待保存", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    expect(patch).not.toHaveBeenCalled();
    confirmHighRisk();
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings", {
        revision: 3,
        values: { max_concurrent: 8 },
      }),
    );
  });

  it("accepts zero, which the backend reads as unlimited", async () => {
    page([maxConcurrent]);
    const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: {} });
    wrap();
    fireEvent.change(screen.getByLabelText("推理并发上限（0 不限制）"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    confirmHighRisk();
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings", {
        revision: 3,
        values: { max_concurrent: 0 },
      }),
    );
  });

  it("shows the key as externally locked when an environment variable sets it", () => {
    page([{ ...maxConcurrent, source: "environment", locked: true }]);
    wrap();
    fireEvent.click(screen.getByRole("tab", { name: /并发与超时/ }));
    expect(screen.getByText("环境变量")).toBeTruthy();
    expect(screen.getByText(/由环境变量锁定/)).toBeTruthy();
    expect(screen.queryByLabelText("推理并发上限（0 不限制）")).toBeNull();
  });

  it("names the environment variable to edit when the backend ships it", () => {
    page([
      {
        ...maxConcurrent,
        source: "environment",
        locked: true,
        env: "CODEBUDDY2API_MAX_CONCURRENT",
      },
    ]);
    wrap();
    fireEvent.click(screen.getByRole("tab", { name: /并发与超时/ }));
    // "set by the environment" leaves the operator hunting; the variable name is actionable.
    expect(
      screen.getByText("由环境变量 CODEBUDDY2API_MAX_CONCURRENT 锁定，请修改启动配置后重启。"),
    ).toBeTruthy();
    expect(screen.queryByText(/^由环境变量锁定/)).toBeNull();
  });

  it("falls back to the generic wording when no variable name is shipped", () => {
    page([{ ...maxConcurrent, source: "environment", locked: true }]);
    wrap();
    fireEvent.click(screen.getByRole("tab", { name: /并发与超时/ }));
    expect(screen.getByText("由环境变量锁定，请修改启动配置后重启。")).toBeTruthy();
  });
});

describe("domain grouping", () => {
  it("splits keys into the seven domains instead of one flat list", () => {
    page([
      maxConcurrent,
      { ...base, key: "alert_retry_count", label: "告警投递重试次数", type: "integer" },
      { ...base, key: "audit_retention_days", label: "审计明细保留天数", type: "integer" },
    ]);
    wrap();
    expect(screen.getByRole("tab", { name: /并发与超时/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /存储与审计/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /告警/ })).toBeTruthy();
    // Only the selected domain's rows render.
    expect(screen.queryByText("告警投递重试次数")).toBeNull();
  });

  it("keeps a backend key the metadata table has never seen in an ungrouped bucket", () => {
    page([
      { ...base, key: "brand_new_knob", label: "全新的后端开关", type: "boolean", value: true },
    ]);
    wrap();
    expect(screen.getByRole("tab", { name: /未分组/ })).toBeTruthy();
    expect(screen.getByText("全新的后端开关")).toBeTruthy();
  });

  it("hides retired switches that nothing in the codebase reads", () => {
    page([
      {
        ...base,
        key: "alert_credits_burn_days",
        label: "积分日均需耗统计窗口（天）",
        type: "integer",
      },
      {
        ...base,
        key: "stats_tokens_rate_ttfb_ms",
        label: "tokens/s 扣除 TTFB 阈值",
        type: "number",
      },
      { ...base, key: "alert_retry_count", label: "告警投递重试次数", type: "integer" },
    ]);
    wrap();
    expect(screen.queryByText("积分日均需耗统计窗口（天）")).toBeNull();
    expect(screen.queryByText("tokens/s 扣除 TTFB 阈值")).toBeNull();
    expect(screen.getByText("告警投递重试次数")).toBeTruthy();
  });
});

describe("finding a setting", () => {
  it("filters the current domain by key, label and alias", () => {
    page([
      maxConcurrent,
      { ...base, key: "max_inflight_per_account", label: "单账号在途上限", type: "integer" },
      { ...base, key: "read_timeout", label: "上游流式读取超时秒数", type: "number" },
    ]);
    wrap();
    const search = screen.getByLabelText("搜索配置项");
    // Alias match: "concurrency" is not in the key or the Chinese label.
    fireEvent.change(search, { target: { value: "concurrency" } });
    expect(screen.getByText("推理并发上限（0 不限制）")).toBeTruthy();
    expect(screen.queryByText("上游流式读取超时秒数")).toBeNull();
    fireEvent.change(search, { target: { value: "读取" } });
    expect(screen.getByText("上游流式读取超时秒数")).toBeTruthy();
    expect(screen.queryByText("推理并发上限（0 不限制）")).toBeNull();
    fireEvent.change(search, { target: { value: "read_timeout" } });
    expect(screen.getByText("上游流式读取超时秒数")).toBeTruthy();
  });

  it("searches every domain, not only the one on screen", () => {
    page([
      maxConcurrent,
      { ...base, key: "alert_retry_count", label: "告警投递重试次数", type: "integer" },
    ]);
    wrap();
    // The default tab is 并发与超时; the alert key lives in 告警.
    expect(screen.queryByText("告警投递重试次数")).toBeNull();
    fireEvent.change(screen.getByLabelText("搜索配置项"), { target: { value: "重试次数" } });
    expect(screen.getByText("告警投递重试次数")).toBeTruthy();
    expect(screen.queryByText("推理并发上限（0 不限制）")).toBeNull();
  });

  it("shows a human-readable size next to a byte budget", () => {
    page([
      { ...base, key: "audit_max_bytes", label: "审计明细预算", type: "integer", value: 268435456 },
    ]);
    wrap();
    expect(screen.getByText("256 MiB")).toBeTruthy();
  });
});

describe("restart semantics", () => {
  it("flags keys that were saved but are not live until the process restarts", () => {
    page([
      {
        ...base,
        key: "port",
        label: "监听端口",
        type: "integer",
        mode: "restart",
        value: 8787,
        stored: 9090,
      },
      {
        ...base,
        key: "alert_retry_count",
        label: "告警投递重试次数",
        type: "integer",
        value: 2,
        stored: 2,
      },
    ]);
    wrap();
    expect(screen.getByRole("status").textContent).toContain("1 项已保存但尚未生效");
    expect(screen.getByText("docker compose restart")).toBeTruthy();
    expect(screen.getByRole("button", { name: "复制命令" })).toBeTruthy();
  });

  it("stays quiet when every restart key is already live", () => {
    page([
      {
        ...base,
        key: "port",
        label: "监听端口",
        type: "integer",
        mode: "restart",
        value: 8787,
        stored: 8787,
      },
    ]);
    wrap();
    expect(screen.queryByText(/已保存但尚未生效/)).toBeNull();
  });

  it("explains what a restart-mode key actually does", () => {
    page([
      {
        ...base,
        key: "upstream_keepalive",
        label: "上游连接复用",
        type: "boolean",
        mode: "restart",
        value: false,
      },
    ]);
    wrap();
    expect(screen.getByText(/重启后立即生效/)).toBeTruthy();
    expect(screen.getByText("重启后生效")).toBeTruthy();
  });
});

describe("high-risk confirmation", () => {
  it("does not write anything until the confirmation phrase is typed", () => {
    page([maxConcurrent]);
    const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: {} });
    wrap();
    fireEvent.change(screen.getByLabelText("推理并发上限（0 不限制）"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    const confirm = screen.getByRole("button", { name: "确认修改" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByRole("heading", { name: "确认修改高风险配置" })).toBeTruthy();
    expect(screen.getByText(/以下 1 项会立刻改变线上行为/)).toBeTruthy();
    expect(screen.getByText("64 → 8")).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it("saves a routine change without asking", async () => {
    page([
      { ...base, key: "alert_retry_count", label: "告警投递重试次数", type: "integer", value: 2 },
    ]);
    const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: {} });
    wrap();
    fireEvent.change(screen.getByLabelText("告警投递重试次数"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings", {
        revision: 3,
        values: { alert_retry_count: 3 },
      }),
    );
    expect(screen.queryByRole("button", { name: "确认修改" })).toBeNull();
  });
});

describe("cross-page signals", () => {
  it("publishes the pending-restart set for the sidebar dot", () => {
    page([
      {
        ...base,
        key: "port",
        label: "监听端口",
        type: "integer",
        mode: "restart",
        value: 8787,
        stored: 9090,
      },
    ]);
    const { result } = renderHook(() => usePendingRestart());
    wrap();
    expect(result.current).toEqual(["port"]);
  });

  it("clears the signal once nothing is waiting for a restart", () => {
    page([
      {
        ...base,
        key: "port",
        label: "监听端口",
        type: "integer",
        mode: "restart",
        value: 8787,
        stored: 8787,
      },
    ]);
    const { result } = renderHook(() => usePendingRestart());
    wrap();
    expect(result.current).toEqual([]);
  });
});
