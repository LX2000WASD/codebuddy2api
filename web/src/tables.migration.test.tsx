import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { api, useResource } from "./api";
import { Credentials } from "./pages/Credentials";
import { Diagnostics } from "./pages/Diagnostics";
import { Credits } from "./pages/Credits";
import { __resetFusionMock, __setFusionLatency } from "./fusion/mock";

/**
 * The three hand-written tables (credentials list, diagnostics x2, credits
 * batches) now render through DataTable. These tests pin the behaviour the
 * migration was not allowed to change, and the two capabilities DataTable had to
 * grow for it: `manualSorting` (sort before the page slice) and
 * `selection.headerCheckbox: false` (the page keeps its own select-all).
 *
 * They assert through the rendered table rather than the component's internals,
 * because the failure this guards against is visible: a header that sorts while
 * the cells stay put, or a second select-all that selects a different set.
 */

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  useResource: vi.fn(),
}));

function credential(overrides: Record<string, unknown> = {}) {
  return {
    id: "one",
    name: "one.info",
    enabled: true,
    paused: false,
    profile: "cn-cli",
    health: "ready",
    ...overrides,
  };
}

function mockCredentials(rows: Record<string, unknown>[]) {
  vi.mocked(useResource).mockReturnValue({
    data: rows,
    reload: vi.fn(),
    loading: false,
    error: null,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __resetFusionMock();
  __setFusionLatency(0);
  window.history.replaceState(null, "", "/dashboard/credentials");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The list view, which is the view that now renders through DataTable. */
function showListView() {
  fireEvent.click(screen.getByRole("button", { name: "列表视图" }));
}

/** Header labels without the decorative sort arrow DataTable appends. */
function headerLabels(table: HTMLElement) {
  return within(table)
    .getAllByRole("columnheader")
    .map((th) => th.textContent?.replace(/[↕▲▼]/g, "").trim());
}

/** First text column of each body row (the selection box lives in its own cell). */
function nameColumn(table: HTMLElement, column = 0) {
  return within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[column].textContent ?? "");
}

describe("credentials list migrated to DataTable", () => {
  it("renders the same columns and row actions as before", () => {
    mockCredentials([credential()]);
    vi.spyOn(api, "get").mockResolvedValue({ data: { items: [] } });
    render(<Credentials />);
    showListView();

    const table = screen.getAllByRole("table")[0];
    expect(headerLabels(table)).toEqual([
      "",
      "凭证 / 产品",
      "目录与同步状态",
      "官方余额 / 到期",
      "请求与用量",
      "认证与启用",
      "操作",
    ]);
    // Row actions survive: the detail drawer opener, the danger action and the
    // two orthogonal switches (enabled + paused).
    expect(screen.getByRole("button", { name: "详情" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "启用状态 one.info" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "暂停账号 one.info" })).toBeTruthy();
    // The optimistic overlay still feeds the row renderer.
    expect(screen.getByText("已启用")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
  });

  it("sorts the whole result set, not just the visible page", () => {
    // 12 rows against a page size of 10: if the sort ran inside the table it
    // would only reorder the first ten (a..j) and leave k, l on page 2.
    const rows = Array.from({ length: 12 }, (_, index) =>
      credential({ id: `row-${index}`, name: `${String.fromCharCode(97 + index)}.info` }),
    );
    mockCredentials(rows);
    vi.spyOn(api, "get").mockResolvedValue({ data: { items: [] } });
    render(<Credentials />);
    fireEvent.change(screen.getByLabelText("每页显示数量"), { target: { value: "10" } });
    showListView();

    const table = screen.getAllByRole("table")[0];
    // The backend order is preserved until a column is clicked.
    expect(nameColumn(table, 1)[0]).toContain("a.info");

    const header = within(table).getByRole("columnheader", { name: /凭证 \/ 产品/ });
    fireEvent.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");

    // Ascending leaves a..j on page 1 — unchanged, because they already were.
    // The second click is the discriminating one: descending must surface l,
    // which lives on page 2 unless the sort ran before the slice.
    fireEvent.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("descending");
    expect(nameColumn(table, 1)[0]).toContain("l.info");
    expect(nameColumn(table, 1)).toHaveLength(10);
  });

  it("keeps the toolbar's select-all and does not add a competing header box", () => {
    mockCredentials([credential(), credential({ id: "two", name: "two.info" })]);
    vi.spyOn(api, "get").mockResolvedValue({ data: { items: [] } });
    render(<Credentials />);
    showListView();

    // Exactly one select-all on the screen: the toolbar's, which means the pool.
    expect(screen.getAllByLabelText("选择全部凭证")).toHaveLength(1);
    // Per-row checkboxes still exist and still drive the export count.
    fireEvent.click(screen.getByLabelText("选择 two.info"));
    expect(screen.getByRole("button", { name: "导出已选 (1)" })).toBeTruthy();
  });
});

describe("diagnostics tables migrated to DataTable", () => {
  it("keeps every account cell and sorts by the account name", async () => {
    render(<Diagnostics />);
    await waitFor(() => expect(screen.getByText("mainland-b.info")).toBeTruthy(), {
      timeout: 4000,
    });

    // The account table is the one whose first header is the account column; the
    // page also renders a smaller by-profile table above it.
    const table = screen
      .getAllByRole("table")
      .find((candidate) => within(candidate).queryByText("mainland-b.info"))!;
    const header = within(table).getByRole("columnheader", { name: /账号 \/ 产品/ });
    expect(header.getAttribute("aria-sort")).toBeNull();
    fireEvent.click(within(header).getByRole("button"));
    expect(header.getAttribute("aria-sort")).toBe("ascending");

    // Sorting is presentation only: every column and its badges survive.
    const row = within(table).getAllByRole("row")[1];
    expect(within(row).getAllByRole("cell")).toHaveLength(5);
    expect(within(table).getByText("传输连败出池 120s")).toBeTruthy();
    expect(within(table).getAllByText("认证熔断").length).toBeGreaterThan(0);
  });

  it("sorts the model lock table by the number of locked accounts", async () => {
    render(<Diagnostics />);
    await waitFor(() => expect(screen.getByText("模型额度冷却")).toBeTruthy(), { timeout: 4000 });
    const lockedHeader = screen.getByRole("columnheader", { name: /锁定账号/ });
    fireEvent.click(within(lockedHeader).getByRole("button"));
    expect(lockedHeader.getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByText("后端模型不可用")).toBeTruthy();
  });
});

describe("credits batches migrated to DataTable", () => {
  it("renders the FEFO batches and sorts each account's list independently", async () => {
    render(<Credits />);
    await waitFor(() => expect(screen.getByText("mainland-a.info")).toBeTruthy(), {
      timeout: 4000,
    });
    expect(screen.getByText("旗舰版连续包月")).toBeTruthy();
    expect(screen.getByText("p_tcaca_m_x")).toBeTruthy();

    // One table per account card; the first one is mainland-a's. Each account has
    // a single batch inside the 30-day window (its 44-day batch is filtered out),
    // so this asserts the table renders that batch and sorts on its own state.
    const table = screen.getAllByRole("table")[0];
    expect(within(table).getByText("120 / 500")).toBeTruthy();
    const remainingHeader = within(table).getByRole("columnheader", { name: /剩余 \/ 总量/ });
    fireEvent.click(within(remainingHeader).getByRole("button"));
    // The remaining column reads largest-first by default.
    expect(remainingHeader.getAttribute("aria-sort")).toBe("descending");
    expect(within(table).getByText("120 / 500")).toBeTruthy();
    // The other cards keep their own (untouched) sort state.
    const other = screen.getAllByRole("table")[1];
    expect(
      within(other)
        .getByRole("columnheader", { name: /剩余 \/ 总量/ })
        .getAttribute("aria-sort"),
    ).toBeNull();
  });

  it("marks the batch table up as a real table with column scopes", async () => {
    render(<Credits />);
    await waitFor(() => expect(screen.getByText("mainland-a.info")).toBeTruthy(), {
      timeout: 4000,
    });
    expect(document.querySelectorAll("thead").length).toBeGreaterThan(0);
    for (const header of document.querySelectorAll("th"))
      expect(header.getAttribute("scope")).toBe("col");
  });
});
