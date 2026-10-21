import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, type ModelLock, type ModelRule } from "./api";
import { AvailabilityCell, Models, bulkPayload, locksForModel, worstLock } from "./pages/Models";

/** Account-bound row: replaying it must keep the binding list intact. */
const bound: ModelRule = {
  id: "upstream-a",
  public_id: "public-a",
  upstream_id: "upstream-a",
  enabled: true,
  keep_original: true,
  region: "",
  profile: "",
  credential_ids: ["acct-1", "acct-2"],
  available: true,
  available_credentials: 2,
  credits: 0,
  capabilities: { images: "supported", tools: "supported", reasoning: "supported" },
  metadata_by_profile: { "intl-work": [{ id: "upstream-a", name: "Alpha" }] },
};
/** Auto-routed row with no candidate account right now. */
const orphan: ModelRule = {
  id: "upstream-b",
  public_id: "public-b",
  upstream_id: "upstream-b",
  enabled: true,
  keep_original: false,
  region: "",
  profile: "",
  credential_ids: [],
  available: false,
  available_credentials: 0,
  credits: 1,
  metadata_by_profile: { "cn-cli": [{ id: "upstream-b", name: "Beta" }] },
};
const off: ModelRule = {
  id: "upstream-c",
  public_id: "public-c",
  upstream_id: "upstream-c",
  enabled: false,
  keep_original: false,
  region: "cn",
  profile: "",
  credential_ids: [],
  available: true,
  available_credentials: 1,
  credits: 0.5,
};
/** Legacy row mixing accounts with a region scope: replaying it would be rejected. */
const legacy: ModelRule = {
  id: "upstream-d",
  public_id: "public-d",
  upstream_id: "upstream-d",
  enabled: true,
  keep_original: false,
  region: "intl",
  profile: "intl-work",
  credential_ids: ["acct-1"],
  available: true,
  available_credentials: 1,
  credits: 0,
};
const credentials = [
  { id: "acct-1", name: "one.info", profile: "intl-work", enabled: true },
  { id: "acct-2", name: "two.info", profile: "intl-work", enabled: true },
  { id: "acct-3", name: "three.info", profile: "cn-cli", enabled: true },
];

/** Routes GETs to /models and /credentials and records the model list requests. */
function mockApi(models: ModelRule[], revision = 7) {
  const loads: string[] = [];
  vi.spyOn(api, "get").mockImplementation(async (path) => {
    loads.push(path);
    if (path === "/models")
      return {
        data: { revision, models, model_guard: true, model_capability_guard: true },
      } as never;
    return { data: { credentials } } as never;
  });
  return loads;
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => vi.restoreAllMocks());

async function selectRow(name: string) {
  fireEvent.click(await screen.findByRole("checkbox", { name: `选择 ${name}` }));
}

describe("bulk enable/disable", () => {
  it("chains the revision returned by each write and replays the full rule", async () => {
    mockApi([bound, orphan]);
    const puts: { path: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(api, "put").mockImplementation(async (path, body) => {
      const payload = body as Record<string, unknown>;
      puts.push({ path, body: payload });
      return { data: { revision: Number(payload.revision) + 1, model: {} } } as never;
    });
    render(<Models />);
    await selectRow("public-a");
    await selectRow("public-b");
    expect(screen.getByRole("region", { name: "批量操作" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "批量停用" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("public-a")).toBeTruthy();
    expect(within(drawer).getByText("public-b")).toBeTruthy();
    expect(within(drawer).getByText("绑定 2 个账号")).toBeTruthy();
    expect(within(drawer).getByText("当前无候选账号")).toBeTruthy();
    fireEvent.click(within(drawer).getByRole("button", { name: "确认停用" }));
    await waitFor(() => expect(puts).toHaveLength(2));
    // The second write must carry the revision the first one returned, not the page's.
    expect(puts[0].body.revision).toBe(7);
    expect(puts[1].body.revision).toBe(8);
    // A body carrying only {revision, enabled} would silently clear these fields.
    expect(puts[0].body).toEqual({
      revision: 7,
      public_id: "public-a",
      upstream_id: "upstream-a",
      enabled: false,
      keep_original: true,
      region: null,
      profile: null,
      credential_ids: ["acct-1", "acct-2"],
    });
    expect(puts[1].body).toEqual({
      revision: 8,
      public_id: "public-b",
      upstream_id: "upstream-b",
      enabled: false,
      keep_original: false,
      region: null,
      profile: null,
      credential_ids: [],
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: "批量操作" })).toBeNull());
    expect(screen.getByText("已停用 2 个模型。")).toBeTruthy();
  });

  it("stops on the first 409, keeps the unfinished rows selected and reloads once", async () => {
    const loads = mockApi([bound, orphan, off]);
    const put = vi
      .spyOn(api, "put")
      .mockResolvedValueOnce({ data: { revision: 8 } } as never)
      .mockRejectedValueOnce(
        Object.assign(new Error("conflict"), {
          isAxiosError: true,
          response: { status: 409, data: {} },
        }),
      );
    render(<Models />);
    await selectRow("public-a");
    await selectRow("public-b");
    await selectRow("public-c");
    fireEvent.click(screen.getByRole("button", { name: "批量启用" }));
    const drawer = await screen.findByRole("dialog");
    fireEvent.click(within(drawer).getByRole("button", { name: "确认启用" }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/已完成 1 \/ 3 后停止/)).toBeTruthy();
    // The two rows that never ran stay selected so a retry does not lose them.
    const bar = screen.getByRole("region", { name: "批量操作" });
    expect(within(bar).getByText("2")).toBeTruthy();
    // One initial load plus exactly one reload after the batch.
    expect(loads.filter((path) => path === "/models")).toHaveLength(2);
  });

  it("selects only the rows left by the current filter, not the whole catalog", async () => {
    mockApi([bound, orphan, off]);
    render(<Models />);
    await screen.findByText("public-a");
    fireEvent.change(screen.getByRole("textbox", { name: "搜索模型" }), {
      target: { value: "Beta" },
    });
    expect(screen.queryByText("public-a")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前列表" }));
    expect(screen.getByRole("checkbox", { name: "选择 public-b" })).toHaveProperty("checked", true);
    expect(screen.getByRole("region", { name: "批量操作" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清空选择" }));
    expect(screen.queryByRole("region", { name: "批量操作" })).toBeNull();
    // Unfiltered, select-all covers every visible row and reports the tri-state.
    fireEvent.change(screen.getByRole("textbox", { name: "搜索模型" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前列表" }));
    const bar = screen.getByRole("region", { name: "批量操作" });
    expect(within(bar).getByText("3")).toBeTruthy();
  });

  it("skips legacy combined scopes instead of replaying a rejected rule", async () => {
    mockApi([legacy]);
    const put = vi.spyOn(api, "put");
    render(<Models />);
    await selectRow("public-d");
    fireEvent.click(screen.getByRole("button", { name: "批量启用" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("旧联合范围，跳过")).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: "确认启用" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("builds a complete PUT body and nulls empty region/profile", () => {
    expect(bulkPayload(orphan, true, 4)).toEqual({
      revision: 4,
      public_id: "public-b",
      upstream_id: "upstream-b",
      enabled: true,
      keep_original: false,
      region: null,
      profile: null,
      credential_ids: [],
    });
    expect(bulkPayload(bound, false, 9)).toEqual({
      revision: 9,
      public_id: "public-a",
      upstream_id: "upstream-a",
      enabled: false,
      keep_original: true,
      region: null,
      profile: null,
      credential_ids: ["acct-1", "acct-2"],
    });
  });
});

describe("availability badges", () => {
  it("renders N/M from available_credentials and explains an empty candidate set", async () => {
    mockApi([bound, orphan, off]);
    render(<Models />);
    expect(await screen.findByText("2/3 账号")).toBeTruthy();
    expect(screen.getByText("无可用账号")).toBeTruthy();
    // A disabled model says so instead of claiming zero candidates.
    expect(screen.getByTitle("模型已停用，不参与选路。")).toBeTruthy();
    expect(
      screen.getByTitle("当前没有账号能路由到该模型：绑定、熔断、额度或目录限制。"),
    ).toBeTruthy();
  });

  it("shows the most severe lock and keeps every lock in the tooltip", () => {
    const locks: ModelLock[] = [
      {
        profile: "intl-work",
        model: "upstream-a",
        locked_accounts: 1,
        account_ids: ["acct-1"],
        earliest_unlock_at: 1,
        latest_unlock_at: 1,
        all_unlock_in_seconds: 60,
        kind: "rate_limit",
        reason: "模型额度冷却",
      },
      {
        profile: "intl-cli",
        model: "upstream-a",
        locked_accounts: 2,
        account_ids: ["acct-2", "acct-3"],
        earliest_unlock_at: 2,
        latest_unlock_at: 2,
        all_unlock_in_seconds: 120,
        kind: "model_block",
        reason: "后端模型不可用",
      },
    ];
    const matched = locksForModel(locks, bound);
    expect(matched).toHaveLength(2);
    expect(worstLock(matched)?.kind).toBe("model_block");
    expect(worstLock(locksForModel(locks, orphan))).toBeNull();

    render(<AvailabilityCell model={bound} total={3} locks={matched} />);
    expect(screen.getByText("2/3 账号")).toBeTruthy();
    const badge = screen.getByText("后端不可用 +1");
    // The tooltip keeps every lock, not just the worst one.
    expect(badge.getAttribute("title")).toContain("限流冷却");
    expect(badge.getAttribute("title")).toContain("后端不可用");
  });
});

describe("column visibility", () => {
  it("hides the secondary columns by default and persists the choice", async () => {
    mockApi([bound]);
    const { unmount } = render(<Models />);
    await screen.findByText("public-a");
    expect(screen.queryByRole("columnheader", { name: "上下文窗口" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "可用性" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "列可见性" }));
    const menu = screen.getByRole("group", { name: "列可见性" });
    fireEvent.click(within(menu).getByRole("checkbox", { name: "上下文窗口" }));
    expect(screen.getByRole("columnheader", { name: "上下文窗口" })).toBeTruthy();
    expect(localStorage.getItem("codebuddy.models.columns")).toBe('["output","effort"]');
    unmount();
    render(<Models />);
    await screen.findByText("public-a");
    expect(screen.getByRole("columnheader", { name: "上下文窗口" })).toBeTruthy();
  });

  it("closes the menu with Escape and returns focus to the trigger", async () => {
    mockApi([bound]);
    render(<Models />);
    await screen.findByText("public-a");
    const trigger = screen.getByRole("button", { name: "列可见性" });
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "列可见性" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "列可见性" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
