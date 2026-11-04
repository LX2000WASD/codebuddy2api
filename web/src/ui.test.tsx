import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  Badge,
  Drawer,
  DrawerPresence,
  Segmented,
  Table,
  type TableColumn,
  type TableSort,
} from "./ui";

/**
 * The design system's contracts, not its pixels.
 *
 * jsdom applies no stylesheet, so "the selected label is visible" and "the actions column
 * stays on screen" cannot be asserted from computed style. They are asserted two ways
 * instead: the rendered structure that makes the defect impossible (a segmented bar that
 * contains nothing but buttons; a card layout with one dl per row and the actions inside
 * it), and a read of the stylesheet that owns the pinned geometry. The three defects this
 * file guards are the P1s from 10-缺陷清单.md.
 */

const UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "ui");
const readModule = (name: string) => readFileSync(resolve(UI_DIR, name), "utf8");

function setViewport(width: number) {
  window.innerWidth = width;
  fireEvent(window, new Event("resize"));
}

afterEach(() => setViewport(1024));

describe("Segmented", () => {
  function Harness() {
    const [value, setValue] = useState("ready");
    return (
      <Segmented
        label="状态筛选"
        value={value}
        onChange={setValue}
        options={[
          { value: "all", label: "全部" },
          { value: "ready", label: "就绪", amount: "7", detail: "7 / 8 就绪" },
        ]}
      />
    );
  }

  const pressedLabel = () => {
    const group = screen.getByRole("group", { name: "状态筛选" });
    const pressed = within(group)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    return pressed[0];
  };

  it("keeps the selected label in the segment's own text, with no overlay above it", () => {
    render(<Harness />);
    // The selected segment shows its label: it is the button's own text content, not a
    // sibling element painted on top of it.
    const selected = pressedLabel();
    expect(selected.textContent).toContain("就绪");
    expect(within(selected).getByText("就绪")).toBeTruthy();
    // The bar is a group of buttons and nothing else. P1-1 was an aria-hidden, absolutely
    // positioned "thumb" inserted next to them and painted over the label; there is no
    // element here for such a block to be, and no decoration is rendered at all.
    const group = screen.getByRole("group", { name: "状态筛选" });
    expect(Array.from(group.children).every((child) => child.tagName === "BUTTON")).toBe(true);
    expect(group.querySelector("[aria-hidden]")).toBeNull();
  });

  it("moves the pressed state with the selection, and never positions an indicator", () => {
    render(<Harness />);
    expect(pressedLabel().textContent).toContain("就绪");
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(pressedLabel().textContent).toContain("全部");
    // The rule that made P1-1 impossible in the first place: no absolute element in this
    // module at all, and the pressed state painted by the segment itself.
    const scss = readModule("Segmented.module.scss");
    expect(scss).not.toMatch(/position:\s*absolute/);
    expect(scss).toMatch(/\.segment\[aria-pressed="true"\]\s*\{[^}]*background:/s);
  });
});

type Row = { id: string; model: string; status: string };

const rows: Row[] = [
  { id: "a", model: "claude-sonnet-4.6", status: "成功" },
  { id: "b", model: "gpt-5", status: "失败" },
];

const columns: TableColumn<Row>[] = [
  { id: "model", header: "模型/产品", sortable: true, cell: (row) => <strong>{row.model}</strong> },
  {
    id: "status",
    header: "状态",
    cell: (row) => <Badge tone={row.status === "成功" ? "good" : "bad"}>{row.status}</Badge>,
  },
  {
    id: "actions",
    header: "操作",
    actions: true,
    cell: (row) => <button type="button">查看详情 {row.id}</button>,
  },
];

function TableHarness({ sort = null }: { sort?: TableSort }) {
  return (
    <Table
      label="请求记录"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      sort={sort}
      onSort={vi.fn()}
    />
  );
}

describe("Table", () => {
  it("renders a table with a sortable header and a data column for the actions", () => {
    setViewport(1440);
    const { container } = render(<TableHarness sort={{ id: "model", desc: true }} />);
    const table = screen.getByRole("table", { name: "请求记录" });
    expect(table).toBeTruthy();
    const header = container.querySelector('th[data-column="model"]');
    expect(header?.getAttribute("aria-sort")).toBe("descending");
    // Every row carries the actions cell, and the cell carries the row's only entry point:
    // the stylesheet pins that column to the right edge, so scrolling cannot hide it.
    const cells = container.querySelectorAll('tbody td[data-column="actions"]');
    expect(cells).toHaveLength(rows.length);
    expect(
      within(cells[0] as HTMLElement).getByRole("button", { name: /查看详情 a/ }),
    ).toBeTruthy();
    const scss = readModule("Table.module.scss");
    expect(scss).toMatch(/\.actionsCell\s*\{[^}]*position:\s*sticky[^}]*right:\s*0/s);
    expect(scss).toMatch(/\.headCell\s*\{[^}]*position:\s*sticky/s);
  });

  it("turns every row into a dl of dt/dd pairs below 900px, actions included", () => {
    setViewport(390);
    const { container } = render(<TableHarness />);
    // No table at all: the horizontal overflow P1-2 measured cannot exist without it.
    expect(container.querySelector("table")).toBeNull();
    const list = screen.getByRole("list", { name: "请求记录" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(rows.length);
    const lists = container.querySelectorAll("dl");
    expect(lists).toHaveLength(rows.length);
    // One dl per row, one pair per column, label and value both present.
    const pairs = Array.from(lists[0].children);
    expect(pairs.map((pair) => pair.getAttribute("data-column"))).toEqual([
      "model",
      "status",
      "actions",
    ]);
    expect(within(lists[0] as HTMLElement).getByText("模型/产品")).toBeTruthy();
    expect(within(lists[0] as HTMLElement).getByText("claude-sonnet-4.6")).toBeTruthy();
    // The operations are inside the card, in its last pair, and are reachable.
    const actions = lists[0].lastElementChild as HTMLElement;
    expect(actions.getAttribute("data-column")).toBe("actions");
    expect(within(actions).getByRole("button", { name: /查看详情 a/ })).toBeTruthy();
  });
});

describe("Overlay", () => {
  it("closes on Escape, unlocks the page and gives focus back to the opener", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            查看详情
          </button>
          <DrawerPresence>
            {open && (
              <Drawer title="请求详情" closeLabel="关闭抽屉" onClose={() => setOpen(false)}>
                <p>详情内容</p>
              </Drawer>
            )}
          </DrawerPresence>
        </>
      );
    }
    const opened = render(<Harness />);
    const opener = screen.getByRole("button", { name: "查看详情" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The scroll lock is shared with the old drawers (modal.ts), not re-invented here.
    expect(document.body.style.position).toBe("fixed");
    expect(opened.container.textContent).toContain("详情内容");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.style.position).toBe("");
    expect(document.activeElement).toBe(opener);
  });
});

describe("design system rules", () => {
  it("keeps every primitive free of colour and size literals", () => {
    // Contract §3.1: ui/ may only read tokens. design/base.scss and theme.scss are the two
    // places a value may be written down, so a px or a colour here means a second source of
    // truth for something the palette already owns.
    const modules = readdirSync(UI_DIR).filter((name) => name.endsWith(".module.scss"));
    expect(modules.length).toBeGreaterThan(0);
    // Comments are stripped first: they explain the defects and quote the measured pixels
    // (P2-4's "59px inside a 132px slot"), which is documentation, not a declaration.
    const strip = (scss: string) =>
      scss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const name of modules) {
      const scss = strip(readModule(name));
      expect(scss, name + " 出现 px 字面量").not.toMatch(/[\s:(]\d+px/);
      expect(scss, name + " 出现颜色字面量").not.toMatch(
        /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl|oklch)\(/,
      );
    }
  });
});
