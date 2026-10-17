import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, useResource } from "./api";
import { Settings } from "./pages/Settings";

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

function resource(data: unknown) {
  vi.mocked(useResource).mockReturnValue({ data, error: null, loading: false, reload: vi.fn() });
}

describe("concurrency limit setting", () => {
  it("renders the schema-provided key as an editable number input with its bounds", () => {
    resource(settings);
    render(<Settings />);
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
    resource(settings);
    const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: {} });
    render(<Settings />);
    fireEvent.change(screen.getByLabelText("推理并发上限（0 不限制）"), { target: { value: "8" } });
    expect(screen.getByText("1 项待保存")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings", {
        revision: 3,
        values: { max_concurrent: 8 },
      }),
    );
  });

  it("accepts zero, which the backend reads as unlimited", async () => {
    resource(settings);
    const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: {} });
    render(<Settings />);
    fireEvent.change(screen.getByLabelText("推理并发上限（0 不限制）"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings", {
        revision: 3,
        values: { max_concurrent: 0 },
      }),
    );
  });

  it("shows the key as externally locked when an environment variable sets it", () => {
    resource({
      ...settings,
      items: [{ ...maxConcurrent, source: "environment", locked: true }],
    });
    render(<Settings />);
    fireEvent.click(screen.getByRole("tab", { name: /外部锁定/ }));
    expect(screen.getByText("环境变量")).toBeTruthy();
    expect(screen.getByText("请在启动配置中修改。")).toBeTruthy();
    expect(screen.queryByLabelText("推理并发上限（0 不限制）")).toBeNull();
  });
});
