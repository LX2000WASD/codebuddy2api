import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { useState } from "react";
import type { SortingState } from "@tanstack/react-table";
import {
  ColumnMenu,
  DataTable,
  useColumnVisibility,
  useUrlParams,
  writeUrlParams,
  type DataTableColumn,
} from "./dataTable";

type Row = { id: string; name: string; rate: number | undefined; notes?: string };

const rows: Row[] = [
  { id: "c", name: "charlie", rate: 3 },
  { id: "a", name: "alpha", rate: 1 },
  { id: "b", name: "bravo", rate: undefined },
];

const columns: DataTableColumn<Row>[] = [
  {
    id: "name",
    header: "名称",
    cell: (row) => row.name,
    sortValue: (row) => row.name,
  },
  {
    id: "rate",
    header: "倍率",
    cell: (row) => (row.rate === undefined ? "未知" : String(row.rate)),
    sortValue: (row) => row.rate,
    sortUndefined: "last",
  },
  { id: "notes", header: "备注", cell: (row) => row.notes ?? "—" },
  { id: "extra", header: "次要列", cell: () => "次要", optional: true },
];

/** Mirrors how a page wires the table: sort state lives in the page, not the table. */
function Harness({
  data = rows,
  selection,
  hidden = [],
  empty,
  loading,
  tableColumns = columns,
  loadingLabel,
}: {
  data?: Row[];
  selection?: {
    selected: ReadonlySet<string>;
    onChange: (next: ReadonlySet<string>) => void;
  };
  hidden?: string[];
  empty?: React.ReactNode;
  loading?: boolean;
  tableColumns?: DataTableColumn<Row>[];
  loadingLabel?: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([]);
  return (
    <DataTable
      rows={data}
      columns={tableColumns}
      loadingLabel={loadingLabel}
      hidden={hidden}
      rowId={(row) => row.id}
      sorting={sorting}
      onSortingChange={setSorting}
      selection={
        selection && {
          ...selection,
          rowLabel: (row) => `选择 ${row.name}`,
          selectAllLabel: "全选当前列表",
        }
      }
      empty={empty}
      loading={loading}
    />
  );
}

function SelectionHarness({ initial = [] as string[] }: { initial?: string[] }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initial));
  return (
    <>
      <Harness selection={{ selected, onChange: setSelected }} />
      <output data-testid="selected">{[...selected].sort().join(",")}</output>
    </>
  );
}

function columnOrder() {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, "", "/dashboard/models");
});

describe("sorting", () => {
  it("sorts on the first click and flips on the second, and reports it on the header", () => {
    render(<Harness />);
    expect(columnOrder()).toEqual(["charlie", "alpha", "bravo"]);
    const header = screen.getByRole("columnheader", { name: /名称/ });
    expect(header.getAttribute("aria-sort")).toBeNull();
    fireEvent.click(within(header).getByRole("button", { name: /名称/ }));
    expect(columnOrder()).toEqual(["alpha", "bravo", "charlie"]);
    expect(header.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(within(header).getByRole("button", { name: /名称/ }));
    expect(columnOrder()).toEqual(["charlie", "bravo", "alpha"]);
    expect(header.getAttribute("aria-sort")).toBe("descending");
    // A third click flips back instead of returning to an "unsorted" state.
    fireEvent.click(within(header).getByRole("button", { name: /名称/ }));
    expect(columnOrder()).toEqual(["alpha", "bravo", "charlie"]);
    expect(header.getAttribute("aria-sort")).toBe("ascending");
  });

  it("keeps rows without a value at the bottom in both directions", () => {
    render(<Harness />);
    const header = screen.getByRole("columnheader", { name: /倍率/ });
    fireEvent.click(within(header).getByRole("button", { name: /倍率/ }));
    // Unknown sinks regardless of direction — it must not pose as the cheapest model.
    expect(columnOrder()).toEqual(["alpha", "charlie", "bravo"]);
    fireEvent.click(within(header).getByRole("button", { name: /倍率/ }));
    expect(columnOrder()).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("renders an unsortable column as plain text, not a dead button", () => {
    render(<Harness />);
    const header = screen.getByRole("columnheader", { name: "备注" });
    expect(within(header).queryByRole("button")).toBeNull();
  });
});

describe("column visibility", () => {
  it("hides a column through the menu and persists the choice", () => {
    function Toggle() {
      const { hidden, toggle } = useColumnVisibility({
        storageKey: "test.columns",
        columns,
        defaultHidden: [],
      });
      return (
        <>
          <ColumnMenu
            label="列可见性"
            columns={columns
              .filter((column) => column.optional)
              .map(({ id, header }) => ({ id, header }))}
            hidden={hidden}
            onToggle={toggle}
          />
          <Harness hidden={hidden} />
        </>
      );
    }
    const { unmount } = render(<Toggle />);
    expect(screen.getByRole("columnheader", { name: "次要列" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "列可见性" }));
    const menu = screen.getByRole("group", { name: "列可见性" });
    fireEvent.click(within(menu).getByRole("checkbox", { name: "次要列" }));
    expect(screen.queryByRole("columnheader", { name: "次要列" })).toBeNull();
    expect(localStorage.getItem("test.columns")).toBe('["extra"]');
    unmount();
    render(<Toggle />);
    expect(screen.queryByRole("columnheader", { name: "次要列" })).toBeNull();
  });

  it("closes the menu with Escape and returns focus to the trigger", () => {
    render(
      <ColumnMenu
        label="列可见性"
        columns={[{ id: "extra", header: "次要列" }]}
        hidden={[]}
        onToggle={() => undefined}
      />,
    );
    const trigger = screen.getByRole("button", { name: "列可见性" });
    fireEvent.click(trigger);
    expect(screen.getByRole("group", { name: "列可见性" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "列可见性" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("hides narrow-screen columns by default and drops them when the window shrinks", async () => {
    const responsive: DataTableColumn<Row>[] = [
      ...columns,
      { id: "wide", header: "宽屏列", cell: () => "宽", optional: true, hideBelow: 1200 },
    ];
    function Narrow() {
      const { hidden, toggle } = useColumnVisibility({
        storageKey: "test.narrow",
        columns: responsive,
        defaultHidden: [],
      });
      return (
        <>
          <ColumnMenu
            label="列可见性"
            columns={responsive
              .filter((column) => column.optional)
              .map(({ id, header }) => ({ id, header }))}
            hidden={hidden}
            onToggle={toggle}
          />
          <Harness hidden={hidden} tableColumns={responsive} />
        </>
      );
    }
    window.innerWidth = 1440;
    render(<Narrow />);
    expect(screen.getByRole("columnheader", { name: "宽屏列" })).toBeTruthy();
    window.innerWidth = 900;
    fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "宽屏列" })).toBeNull());
  });
});

describe("selection", () => {
  it("selects every visible row and reports the tri-state", () => {
    render(<SelectionHarness />);
    const all = screen.getByRole("checkbox", { name: "全选当前列表" }) as HTMLInputElement;
    expect(all.indeterminate).toBe(false);
    fireEvent.click(all);
    expect(screen.getByTestId("selected").textContent).toBe("a,b,c");
    expect(all.checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 alpha" }));
    expect(screen.getByTestId("selected").textContent).toBe("b,c");
    // Neither all nor none: the header box must paint the indeterminate bar.
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
    fireEvent.click(all);
    expect(screen.getByTestId("selected").textContent).toBe("a,b,c");
    fireEvent.click(all);
    expect(screen.getByTestId("selected").textContent).toBe("");
  });

  it("selects only the rows left after sorting, never the whole catalog", () => {
    function Filtered() {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set<string>());
      const visible = rows.filter((row) => row.rate !== undefined);
      return (
        <>
          <DataTable
            rows={visible}
            columns={columns}
            rowId={(row) => row.id}
            sorting={[]}
            onSortingChange={() => undefined}
            selection={{
              selected,
              onChange: setSelected,
              rowLabel: (row) => `选择 ${row.name}`,
              selectAllLabel: "全选当前列表",
            }}
          />
          <output data-testid="selected">{[...selected].sort().join(",")}</output>
        </>
      );
    }
    render(<Filtered />);
    fireEvent.click(screen.getByRole("checkbox", { name: "全选当前列表" }));
    // bravo is filtered out, so it must not be selected behind the user's back.
    expect(screen.getByTestId("selected").textContent).toBe("a,c");
  });
});

describe("loading and empty", () => {
  it("shows the table skeleton before the first payload and the empty slot after", () => {
    const { rerender } = render(<Harness data={[]} loading loadingLabel="加载中" />);
    expect(screen.getByRole("status", { name: "加载中" })).toBeTruthy();
    rerender(<Harness data={[]} empty={<p>没有匹配的模型</p>} />);
    expect(screen.getByText("没有匹配的模型")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("view state in the URL", () => {
  function Reader() {
    const params = useUrlParams();
    return <output data-testid="params">{params.get("q") ?? "none"}</output>;
  }

  it("writes and clears view state without pushing history entries", () => {
    const before = window.history.length;
    render(<Reader />);
    expect(screen.getByTestId("params").textContent).toBe("none");
    act(() => writeUrlParams({ q: "alpha" }));
    expect(screen.getByTestId("params").textContent).toBe("alpha");
    expect(window.location.search).toBe("?q=alpha");
    // replaceState, not pushState: filtering must not fill the back button.
    expect(window.history.length).toBe(before);
    act(() => writeUrlParams({ q: "" }));
    expect(screen.getByTestId("params").textContent).toBe("none");
    expect(window.location.search).toBe("");
  });

  it("keeps unrelated parameters untouched", () => {
    window.history.replaceState(null, "", "/dashboard/models?section=routing&q=old");
    render(<Reader />);
    act(() => writeUrlParams({ q: "new" }));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("q")).toBe("new");
    expect(params.get("section")).toBe("routing");
  });
});
