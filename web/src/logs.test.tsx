import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, useResource } from "./api";
import { Logs } from "./pages/Logs";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  useResource: vi.fn(),
}));

function pending() {
  let resolve!: (value: { data: unknown }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ data: unknown }>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useResource).mockReturnValue({
    data: {
      items: [
        { id: "request-a", model: "model-a", outcome: "success", client_ip: "198.51.100.9" },
        { id: "request-b", model: "model-b", outcome: "success" },
      ],
      has_more: false,
      next_cursor: null,
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  });
});

function open(index = 0) {
  fireEvent.click(screen.getAllByRole("button", { name: "查看详情" })[index]!);
}

function close() {
  fireEvent.click(screen.getByRole("button", { name: "关闭抽屉" }));
}

describe("runtime event labels", () => {
  it("renders kind, action and outcome in Chinese with raw values on hover", () => {
    vi.mocked(useResource).mockReturnValue({
      data: {
        items: [
          { id: "event-1", kind: "runtime", action: "credential.sync", started_at: 1 },
          {
            id: "event-2",
            kind: "admin",
            action: "mystery.action",
            details: { outcome: "success" },
          },
        ],
        has_more: false,
        next_cursor: null,
      },
      loading: false,
      error: null,
      reload: vi.fn(),
    });
    render(<Logs />);
    fireEvent.click(screen.getByRole("tab", { name: "运行事件" }));
    expect(screen.getByTitle("credential.sync").textContent).toBe("凭证同步");
    expect(screen.getByTitle("runtime").textContent).toBe("运行事件");
    expect(screen.getByText("mystery.action")).toBeTruthy();
    expect(screen.getByText("成功")).toBeTruthy();
  });
});

describe("request client metadata", () => {
  it("shows the client IP and filters requests by it", () => {
    render(<Logs />);
    expect(screen.getByText("198.51.100.9")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("筛选客户端 IP"), {
      target: { value: "198.51.100.9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "应用筛选" }));
    const call = vi.mocked(useResource).mock.calls.at(-1)![0] as string;
    expect(call).toContain("client_ip=198.51.100.9");
  });
});

describe("log detail request lifetime", () => {
  it("does not reopen a closed drawer when its response arrives", async () => {
    const request = pending();
    const get = vi.spyOn(api, "get").mockReturnValue(request.promise);
    render(<Logs />);
    open();
    expect(screen.getByRole("status").textContent).toContain("正在加载详情");
    close();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => request.resolve({ data: { id: "late-a" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["success", "failure"])(
    "ignores stale %s without changing the next request's loading state",
    async (outcome) => {
      const first = pending();
      const second = pending();
      vi.spyOn(api, "get").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      render(<Logs />);
      open();
      close();
      expect(screen.getAllByRole("button", { name: "查看详情" })[1]).toHaveProperty(
        "disabled",
        false,
      );
      open(1);
      await act(async () => {
        if (outcome === "success") first.resolve({ data: { id: "stale-a" } });
        else first.reject(new Error("stale failure"));
      });
      expect(screen.getByRole("status").textContent).toContain("正在加载详情");
      expect(screen.queryByText("stale-a")).toBeNull();
      expect(screen.queryByText("stale failure")).toBeNull();
      await act(async () => second.resolve({ data: { id: "current-b", attempts: [] } }));
      expect(within(screen.getByRole("dialog")).getByText("current-b")).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
    },
  );

  it("aborts on unmount and ignores a late rejection", async () => {
    const request = pending();
    const get = vi.spyOn(api, "get").mockReturnValue(request.promise);
    const view = render(<Logs />);
    open();
    view.unmount();
    expect(get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => request.reject(new Error("late failure")));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cancels detail loading when switching log kind", async () => {
    const request = pending();
    const get = vi.spyOn(api, "get").mockReturnValue(request.promise);
    render(<Logs />);
    open();
    fireEvent.click(screen.getByRole("tab", { name: "运行事件" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(get.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    open();
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => request.resolve({ data: { id: "stale-request" } }));
    expect(screen.queryByText("stale-request")).toBeNull();
  });

  it("keeps current request failures visible", async () => {
    const request = pending();
    vi.spyOn(api, "get").mockReturnValue(request.promise);
    render(<Logs />);
    open();
    await act(async () => request.reject(new Error("current failure")));
    expect(screen.getByRole("alert").textContent).toBe("current failure");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("request trace timeline", () => {
  // The shape the backend stores: attempts in the order they happened, each with the
  // stage, the dial it belongs to and (only sometimes) a duration.
  const attempts = [
    {
      stage: "upstream_attempt",
      attempt_index: 1,
      credential: "acct-a",
      upstream_request_id: "up-req-1",
    },
    { stage: "upstream_http", attempt_index: 1, status_code: 429, duration_ms: 120 },
    { stage: "upstream_http_error", attempt_index: 1, status_code: 429, error_code: "429001" },
    { stage: "failover_recovered", code: "upstream_429" },
    { stage: "upstream_attempt", attempt_index: 2, credential: "acct-b" },
    { stage: "upstream_http", attempt_index: 2, status_code: 200, duration_ms: 380 },
  ];

  it("renders the recorded attempts as an ordered timeline instead of a flat dump", async () => {
    const request = pending();
    vi.spyOn(api, "get").mockReturnValue(request.promise);
    const { container } = render(<Logs />);
    open();
    await act(async () =>
      request.resolve({ data: { id: "current-b", duration_ms: 640, attempts } }),
    );
    const steps = [...container.querySelectorAll("[data-trace-stage]")];
    expect(steps.map((row) => row.getAttribute("data-trace-stage"))).toEqual([
      "upstream_attempt",
      "upstream_http",
      "upstream_http_error",
      "failover_recovered",
      "upstream_attempt",
      "upstream_http",
    ]);
    // A stage with an error code is visually separated from the ones that succeeded.
    expect(steps[2].getAttribute("data-trace-tone")).toBe("failed");
    expect(steps[2].textContent).toContain("429001");
    // The cumulative total follows the recorded order, not a re-sort by duration.
    expect(steps[1].textContent).toContain("累计 120 ms");
    expect(steps[5].textContent).toContain("累计 500 ms");
    expect(
      within(screen.getByRole("dialog")).getByText(
        "6 段 · 请求总计 640 ms，其中 500 ms 有分段记录",
      ),
    ).toBeTruthy();
  });

  it("still says so when a request recorded no attempts", async () => {
    const request = pending();
    vi.spyOn(api, "get").mockReturnValue(request.promise);
    render(<Logs />);
    open();
    await act(async () => request.resolve({ data: { id: "empty", attempts: [] } }));
    expect(screen.getByText("暂无尝试记录。")).toBeTruthy();
  });
});

it("shows the persisted daily Buddy warning from event details", () => {
  vi.mocked(useResource).mockReturnValue({
    data: {
      items: [
        {
          id: "buddy-warning",
          action: "buddy.attention_required",
          kind: "runtime",
          details: { outcome: "warning", stage: "buddy_tasks" },
        },
      ],
      has_more: false,
      next_cursor: null,
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  });
  render(<Logs />);
  fireEvent.click(screen.getByRole("tab", { name: "运行事件" }));
  expect(screen.getByText("警告")).toBeTruthy();
});
