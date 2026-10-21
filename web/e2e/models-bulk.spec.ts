import { expect, test } from "@playwright/test";

// Browser-level regression for the model page's bulk enable/disable.
//
// The unit tests already cover the payload and the revision chain, but the two things
// that actually break in production are (a) PUT /admin/models/{id} rewrites the whole
// rule, so a body carrying only {revision, enabled} silently unbinds accounts, and
// (b) the revision is a global CAS token, so parallel writes answer 409. This spec drives
// the real UI and asserts on the wire: the payload must replay every rule field and the
// requests must chain their revisions.
test("bulk disable replays the full rule and chains the revision", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const writes: { id: string; body: Record<string, unknown> }[] = [];
  let revision = 5;
  const models = [
    { id: "alpha", public_id: "alpha-alias", credential_ids: ["fp-a", "fp-b"], region: null },
    { id: "beta", public_id: "beta", credential_ids: [], region: "cn" },
    { id: "gamma", public_id: "gamma", credential_ids: [], region: null },
  ].map((row) => ({
    ...row,
    upstream_id: row.id,
    enabled: true,
    keep_original: row.id === "alpha",
    profile: null,
    credits: 0,
    capabilities: { images: "unknown", tools: "supported", reasoning: "unknown" },
    limits: {},
    metadata_by_profile: {},
    available: true,
    available_credentials: 2,
  }));
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/admin/session")
      return route.fulfill({ json: { authenticated: true, csrf_token: "bulk-csrf" } });
    if (path === "/admin/credentials") return route.fulfill({ json: { credentials: [] } });
    if (path === "/admin/models" && request.method() === "GET")
      return route.fulfill({
        json: { revision, model_guard: true, model_capability_guard: true, models },
      });
    if (path.startsWith("/admin/models/") && request.method() === "PUT") {
      const id = decodeURIComponent(path.slice("/admin/models/".length));
      const body = request.postDataJSON() as Record<string, unknown>;
      expect(request.headers()["x-csrf-token"]).toBe("bulk-csrf");
      // The revision must be the one the previous write returned, never a stale value.
      expect(body.revision).toBe(revision);
      writes.push({ id, body });
      const row = models.find((model) => model.id === id)!;
      Object.assign(row, { enabled: body.enabled });
      revision += 1;
      return route.fulfill({ json: { revision, model: { id, ...body } } });
    }
    return route.fulfill({ status: 404, json: { error: { message: "unknown fixture route" } } });
  });
  await page.goto("/dashboard/models");
  await expect(page.getByText("3 个模型")).toBeVisible();

  // Select every visible row through the header checkbox, then disable them in bulk.
  await page.getByRole("checkbox", { name: "全选当前列表" }).check();
  const bar = page.getByRole("region", { name: "批量操作" });
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "批量停用" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByText(/将停用以下 3 个模型/)).toBeVisible();
  // The confirmation lists the blast radius, including which rows hold account bindings.
  await expect(drawer.getByText("alpha-alias")).toBeVisible();
  await expect(drawer.getByText("绑定 2 个账号")).toBeVisible();
  await drawer.getByRole("button", { name: "确认停用" }).click();

  await expect(page.getByText(/已停用 3 个模型/)).toBeVisible();
  expect(writes.map((write) => write.id)).toEqual(["alpha", "beta", "gamma"]);
  // Every field the whole-rule PUT would otherwise drop is replayed verbatim.
  expect(writes[0].body).toEqual({
    revision: 5,
    public_id: "alpha-alias",
    upstream_id: "alpha",
    enabled: false,
    keep_original: true,
    region: null,
    profile: null,
    credential_ids: ["fp-a", "fp-b"],
  });
  // The chained revisions prove the writes were serialised, not fired in parallel.
  expect(writes.map((write) => write.body.revision)).toEqual([5, 6, 7]);
  expect(errors).toEqual([]);
});
