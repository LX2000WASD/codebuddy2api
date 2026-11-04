import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AppRoutes } from "./App";
import { api, useSession } from "./api";
import { Drawer, Fields } from "./components";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  useSession.setState({ status: "checking", csrf: null });
});
describe("shared dialog behavior", () => {
  it("dismisses from the backdrop but not when dragging from inside", () => {
    const close = vi.fn();
    render(
      <Drawer title="Test drawer" onClose={close}>
        <p>Inner content</p>
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog"),
      inner = screen.getByText("Inner content");
    fireEvent.pointerDown(inner, { button: 0 });
    fireEvent.click(dialog);
    expect(close).not.toHaveBeenCalled();
    fireEvent.pointerDown(dialog, { button: 0 });
    fireEvent.click(dialog);
    expect(close).toHaveBeenCalledOnce();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("does not dismiss a pending dangerous operation", () => {
    const close = vi.fn();
    render(
      <Drawer title="Busy" dismissDisabled onClose={close}>
        Saving
      </Drawer>,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.pointerDown(dialog, { button: 0 });
    fireEvent.click(dialog);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "关闭抽屉" })).toHaveProperty("disabled", true);
  });
  it("restores scrolling and focus after StrictMode cleanup", () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const before = document.body.style.cssText;
    const view = render(
      <StrictMode>
        <Drawer title="Modal" onClose={vi.fn()}>
          Content
        </Drawer>
      </StrictMode>,
    );
    expect(document.body.style.position).toBe("fixed");
    expect(document.documentElement.style.overflow).toBe("hidden");
    view.unmount();
    expect(document.body.style.cssText).toBe(before);
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it("keeps the lock until the last nested dialog is gone", () => {
    const outer = render(
      <Drawer title="Outer" onClose={vi.fn()}>
        Outer
      </Drawer>,
    );
    const inner = render(
      <Drawer title="Inner" onClose={vi.fn()}>
        Inner
      </Drawer>,
    );
    inner.unmount();
    expect(document.body.style.position).toBe("fixed");
    outer.unmount();
    expect(document.body.style.position).toBe("");
  });
});
describe("structured metadata", () => {
  it("shows nested values and labels instead of JSON without rewriting identifiers", () => {
    const { container } = render(
      <Fields
        data={{
          model: "cn-cli",
          profile: "cn-cli",
          enabled: false,
          db_bytes: 1024,
          rows: [{ name: "Example", requests: 2 }],
          total_tokens: null,
          credit: 0,
        }}
      />,
    );
    expect(screen.getByText("cn-cli")).toBeTruthy();
    expect(screen.getByText("大陆 · CodeBuddy")).toBeTruthy();
    expect(screen.getByText("已停用")).toBeTruthy();
    expect(screen.getByText("1.0 KiB")).toBeTruthy();
    expect(screen.getByText("Example")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("0")).toBeTruthy();
    expect(container.textContent).not.toContain('"name":');
  });
  it("treats prototype-shaped field names and status values as plain data", () => {
    render(
      <Fields
        data={JSON.parse(
          '{"__proto__":"kept","profile":"__proto__","status":"constructor","toString":"retained"}',
        )}
      />,
    );
    expect(screen.getByText("kept")).toBeTruthy();
    expect(screen.getByText("retained")).toBeTruthy();
    expect(screen.getByText("__proto__")).toBeTruthy();
    expect(screen.getByText("constructor")).toBeTruthy();
  });
  it("keeps raw diagnostics folded and never interprets HTML", () => {
    const { container } = render(
      <Fields
        data={{ request_preview: '{"model":"safe"}', name: "<img src=x onerror=alert(1)>" }}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("pre")?.textContent).toContain('"model": "safe"');
  });
});
describe("collapsible navigation", () => {
  function mount() {
    useSession.setState({ status: "authenticated", csrf: "synthetic" });
    return render(
      <MemoryRouter initialEntries={["/dashboard/models"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
  }
  it("remembers icon mode while keeping every destination accessible", async () => {
    vi.spyOn(api, "get").mockImplementation(async (path) => ({
      data: path === "/models" ? { revision: 0, models: [] } : { credentials: [] },
    }));
    const first = mount();
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(screen.getByRole("button", { name: "展开侧栏" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    // The ten former pages are sections of five task areas now; the sidebar links to
    // the area, and /dashboard/models still redirects into the routing area.
    expect(screen.getByRole("link", { name: "路由与账号" }).getAttribute("href")).toBe(
      "/dashboard/routing",
    );
    expect(localStorage.getItem("codebuddy.sidebar.collapsed")).toBe("true");
    first.unmount();
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "展开侧栏" })).toBeTruthy());
    expect(screen.getByRole("link", { name: "系统" }).getAttribute("href")).toBe(
      "/dashboard/system",
    );
  });
  it("can still fold when preference storage is blocked", () => {
    vi.spyOn(api, "get").mockReturnValue(new Promise(() => {}));
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "收起侧栏" }));
    expect(screen.getByRole("button", { name: "展开侧栏" })).toBeTruthy();
  });
});

/**
 * The drawer range (<900px). jsdom answers no media query at all, which is the wide
 * layout, so these cases stub matchMedia with the exact query the shell asks for: the
 * drawer is then measured through the same switch the stylesheet and the component
 * share instead of being force-mounted into a layout it does not belong to.
 */
describe("narrow navigation drawer", () => {
  const original = Object.getOwnPropertyDescriptor(window, "matchMedia");
  function stubNarrow(matches: boolean) {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      }),
    });
  }
  function mount() {
    useSession.setState({ status: "authenticated", csrf: "synthetic" });
    vi.spyOn(api, "get").mockImplementation(async (path) => ({
      data: path === "/models" ? { revision: 0, models: [] } : { credentials: [] },
    }));
    return render(
      <MemoryRouter initialEntries={["/dashboard/models"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
  }
  afterEach(() => {
    if (original) Object.defineProperty(window, "matchMedia", original);
    else delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it("takes the navigation out of the page flow", async () => {
    stubNarrow(true);
    mount();
    // No sidebar block above the content: below the breakpoint there is no rail at
    // all, so the first screen belongs to the page (defect P2-6).
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.querySelector('[data-nav="drawer"]')).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开导航" }));
    const drawer = await screen.findByRole("dialog", { name: "主导航" });
    expect(within(drawer).getByRole("link", { name: "路由与账号" }).getAttribute("href")).toBe(
      "/dashboard/routing",
    );
    // Picking a destination closes the sheet instead of leaving it over the new page.
    fireEvent.click(within(drawer).getByRole("link", { name: "路由与账号" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("locks the page, then hands focus back to the trigger", async () => {
    stubNarrow(true);
    mount();
    const opener = screen.getByRole("button", { name: "打开导航" });
    opener.focus();
    fireEvent.click(opener);
    const drawer = await screen.findByRole("dialog", { name: "主导航" });
    expect(document.body.style.position).toBe("fixed");
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    // ESC is reachable as a key event and (in a browser) as the dialog's cancel event;
    // both routes must close the sheet.
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.style.position).toBe("");
    expect(document.activeElement).toBe(opener);
  });

  it("stays wide when the viewport is above the breakpoint", () => {
    stubNarrow(false);
    mount();
    expect(screen.getByRole("complementary")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开导航" })).toBeNull();
    expect(screen.getByRole("button", { name: "收起侧栏" })).toBeTruthy();
  });
});
