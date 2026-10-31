// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { AxiosHeaders, type AxiosAdapter } from "axios";
import { api, SNAPSHOT_TTL_MS, useResource } from "./api";
import { Storage } from "./pages/Storage";
import { ToastRegion } from "./toast";

const storagePayload = {
  degraded: false,
  db_bytes: 5 * 1024 * 1024,
  wal_bytes: 1024,
  shm_bytes: 32,
  logical_bytes: 2 * 1024 * 1024,
  request_count: 120,
  event_count: 8,
  retention_days: 30,
  page_count: 1300,
  freelist_pages: 512,
  reclaimable_bytes: 512 * 4096,
  pending_cleanup: false,
  archives: ["audit-20260901-000000-abcdef12.jsonl"],
};

afterEach(() => vi.restoreAllMocks());

describe("storage page", () => {
  it("shows sizes with reclaimable estimate and archives old logs on demand", async () => {
    const get = vi.spyOn(api, "get").mockResolvedValue({ data: storagePayload });
    const post = vi.spyOn(api, "post").mockResolvedValue({
      data: { ok: true, archived_requests: 4, archived_events: 2, file: "audit-x.jsonl" },
    });
    render(<Storage />);
    expect(await screen.findByText("可回收空间")).toBeTruthy();
    expect(screen.getAllByText("2.0 MB").length).toBeGreaterThan(0);
    expect(screen.getByText(/约可回收 2.0 MB/)).toBeTruthy();
    expect(screen.getByText("audit-20260901-000000-abcdef12.jsonl")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "归档并删除" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/storage/archive", { days: 7 }));
    expect(await screen.findByText(/已归档 6 条/)).toBeTruthy();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });
});

const asMarker = (value: unknown) => value as { marker: string };
const CACHE_OPTS = { cache: true };

/**
 * Contract of the shared snapshot layer (web/src/api.ts):
 *   - `cache: true` seeds the first render synchronously, so a remount paints the
 *     previous payload instead of a spinner;
 *   - a path fetched inside the TTL is NOT refetched (that is the whole point —
 *     Models → Credentials → Models must not re-pull /models);
 *   - `reload()` and any write bypass the TTL, because those are the user telling
 *     us the snapshot is wrong;
 *   - once the TTL lapses the next mount refetches.
 * Every case below asserts the *request count*, not just the rendered text: a
 * cache that never revalidates would still pass a rendering-only assertion.
 */
describe("shared snapshot layer", () => {
  function Probe({ path, reloadKey = 0 }: { path: string; reloadKey?: number }) {
    const { data, loading, reload } = useResource(path, asMarker, CACHE_OPTS);
    // Exposed so a test can press the same "refresh" a page would.
    if (reloadKey === -1) void reload;
    if (loading || !data) return <span>加载中</span>;
    return (
      <>
        <span>{data.marker}</span>
        <button onClick={reload}>重新加载</button>
      </>
    );
  }

  function countingGet() {
    let call = 0;
    const get = vi
      .spyOn(api, "get")
      .mockImplementation(
        (path: string) =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ data: { marker: `fresh-${path}-${++call}` } }), 5),
          ),
      );
    return get;
  }

  it("paints the cached snapshot on remount without refetching inside the TTL", async () => {
    const get = countingGet();
    const first = render(<Probe path="/cache-probe" />);
    expect(await screen.findByText("fresh-/cache-probe-1")).toBeTruthy();
    first.unmount();
    // Second mount: the snapshot shows synchronously and the TTL answers for it.
    render(<Probe path="/cache-probe" />);
    expect(screen.queryByText("加载中")).toBeNull();
    expect(screen.getByText("fresh-/cache-probe-1")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("refetches when reload() is pressed, bypassing the TTL", async () => {
    const get = countingGet();
    render(<Probe path="/cache-probe" />);
    expect(await screen.findByText("fresh-/cache-probe-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(await screen.findByText("fresh-/cache-probe-2")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("refetches once the TTL has lapsed", async () => {
    const get = countingGet();
    const first = render(<Probe path="/cache-probe" />);
    expect(await screen.findByText("fresh-/cache-probe-1")).toBeTruthy();
    first.unmount();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + SNAPSHOT_TTL_MS + 1);
    render(<Probe path="/cache-probe" />);
    expect(await screen.findByText("fresh-/cache-probe-2")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  it("drops the snapshot after a write so the next read cannot show stale data", async () => {
    const get = countingGet();
    const first = render(<Probe path="/cache-probe" />);
    expect(await screen.findByText("fresh-/cache-probe-1")).toBeTruthy();
    first.unmount();
    // The write goes through the real axios pipeline (adapter stubbed, not the
    // `post` method itself) so the invalidation interceptor actually runs — spying
    // on api.post would bypass the very layer under test.
    const writes: string[] = [];
    api.defaults.adapter = ((config) => {
      writes.push(`${config.method} ${config.url}`);
      return Promise.resolve({
        data: { marker: "written" },
        status: 200,
        statusText: "OK",
        headers: new AxiosHeaders(),
        config,
      });
    }) satisfies AxiosAdapter;
    // A mutation anywhere in the app invalidates; the reader must not be served
    // the pre-write payload even though it is well inside the TTL.
    await api.post("/models/some-model", { enabled: false });
    expect(writes).toEqual(["post /models/some-model"]);
    render(<Probe path="/cache-probe" />);
    expect(await screen.findByText("fresh-/cache-probe-2")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("configuration backups", () => {
  it("backs up on demand and saves the automatic schedule from its drawer", async () => {
    const get = vi.spyOn(api, "get").mockImplementation(async (path) =>
      path === "/settings"
        ? {
            data: {
              revision: 4,
              items: [
                { key: "backup_auto", value: false, locked: false },
                { key: "backup_interval_hours", value: 24, locked: false },
                { key: "backup_keep", value: 7, locked: true },
              ],
            },
          }
        : {
            data: {
              ...storagePayload,
              backups: [
                {
                  name: "auto-1.5.0-20261020-120000.tar.gz",
                  kind: "auto",
                  version: "1.5.0",
                  created_at: 1792497600,
                  size: 4096,
                },
              ],
              backup_schedule: { enabled: false, interval_hours: 24, keep: 7 },
            },
          },
    );
    const post = vi
      .spyOn(api, "post")
      .mockResolvedValue({ data: { created: "manual-1.5.0-20261020-130000.tar.gz" } });
    const patch = vi.spyOn(api, "patch").mockResolvedValue({ data: {} });
    render(
      <>
        <Storage />
        <ToastRegion />
      </>,
    );
    const item = (await screen.findByTitle("auto-1.5.0-20261020-120000.tar.gz")).closest("li")!;
    expect(within(item).getByText("自动")).toBeTruthy();
    expect(within(item).getByText(/v1\.5\.0/)).toBeTruthy();
    expect(screen.getByText("自动备份未开启")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "立即备份" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/storage/backups"));
    expect(await screen.findByText("manual-1.5.0-20261020-130000.tar.gz")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "自动备份" }));
    const enabled = await screen.findByRole("switch", { name: "启用自动备份" });
    expect(screen.getByRole("spinbutton", { name: "备份上限（份）" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole("combobox", { name: "备份间隔" }));
    fireEvent.click(screen.getByRole("option", { name: "每 6 小时" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    // The locked limit stays out of the write, which would otherwise be refused.
    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith("/settings", {
        revision: 4,
        values: { backup_auto: true, backup_interval_hours: 6 },
      }),
    );
    expect(await screen.findByText("自动备份设置已保存")).toBeTruthy();
    expect(get.mock.calls.filter(([path]) => path === "/storage").length).toBeGreaterThan(1);

    fireEvent.click(screen.getByRole("button", { name: "恢复步骤" }));
    expect(
      await screen.findByText(/cp -a \/tmp\/codebuddy-restore\/data\/control\.sqlite3/),
    ).toBeTruthy();
  });
});
