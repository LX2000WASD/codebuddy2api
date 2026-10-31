import { test, expect, type Page } from "@playwright/test";

async function login(page: Page, remember = false) {
  await page.goto("/dashboard/login");
  await page.getByLabel("用户名", { exact: true }).fill("admin");
  await page.getByLabel("密码", { exact: true }).fill("synthetic-e2e-key");
  if (remember) await page.getByLabel("记住我", { exact: true }).check();
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
}
test("real management API: session, model alias, audit, clear, and file credentials", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  await login(page);
  await expect(page.getByText("125", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "模型路由" }).click();
  await page
    .getByRole("row", { name: /fixture-model/ })
    .getByRole("button", { name: "编辑规则" })
    .click();
  await page.getByLabel("对外 ID").fill("garden-fixture");
  await page.getByRole("button", { name: "保存规则" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const denied = await page.request.post("/v1/chat/completions", {
    data: { model: "garden-fixture", messages: [{ role: "user", content: "synthetic" }] },
  });
  expect(denied.status()).toBe(401);
  const generated = await page.request.post("/v1/chat/completions", {
    headers: { Authorization: "Bearer synthetic-e2e-key" },
    data: {
      model: "garden-fixture",
      stream: false,
      messages: [{ role: "user", content: "synthetic" }],
    },
  });
  expect(generated.status()).toBe(200);
  expect((await generated.json()).model).toBe("garden-fixture");
  await page.getByRole("button", { name: "新增模型" }).click();
  await page.getByLabel("对外 ID").fill("mapped-fixture");
  await page.getByLabel("上游 ID").fill("fixture-model");
  await page.getByRole("radio", { name: /指定账号/ }).check();
  await page.getByRole("checkbox", { name: /fixture.info/ }).check();
  await page.getByRole("button", { name: "创建模型" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const mapped = await page.request.post("/v1/chat/completions", {
    headers: { Authorization: "Bearer synthetic-e2e-key" },
    data: {
      model: "mapped-fixture",
      stream: false,
      messages: [{ role: "user", content: "synthetic mapping" }],
    },
  });
  expect(mapped.status()).toBe(200);
  expect((await mapped.json()).model).toBe("mapped-fixture");
  const credentials = (await (await page.request.get("/admin/credentials")).json()).credentials;
  expect(credentials[0].bindings).toContain("mapped-fixture");
  await page.getByRole("link", { name: "日志审计" }).click();
  await expect(page.getByText("garden-fixture", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/backend-real-audit.png", fullPage: true });
  const summaryBefore = await (await page.request.get("/admin/dashboard?days=1")).json();
  const session = await (await page.request.get("/admin/session")).json();
  const cleared = await page.request.post("/admin/logs/clear", {
    headers: { Origin: "http://127.0.0.1:5175", "X-CSRF-Token": session.csrf_token },
    data: { scope: "details" },
  });
  expect(cleared.status()).toBe(200);
  const summaryAfter = await (await page.request.get("/admin/dashboard?days=1")).json();
  expect(summaryAfter.summary.requests).toBe(summaryBefore.summary.requests);
  expect(summaryAfter.summary.credit).toBe(0);
  expect((await (await page.request.get("/admin/credentials")).json()).credentials).toHaveLength(1);
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  await expect(page.getByText("125", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/backend-real-dashboard.png", fullPage: true });
  await page.goto("/dashboard/credentials");
  await expect(page.getByText("fixture.info", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: /^125(?:\s|$)/ })).toBeVisible();
  await page.screenshot({ path: "test-results/backend-real-credentials.png", fullPage: true });
  expect((await page.request.get("/v1/missing")).status()).toBe(404);
  expect((await page.request.get("/admin/missing")).status()).toBe(404);
  expect(errors).toEqual([]);
});

test("manual trial uses the real admin API and persists success and failed-attempt backoff", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  const session = await (await page.request.get("/admin/session")).json();
  const settings = await (await page.request.get("/admin/settings")).json();
  expect(settings.items.some((item: { key: string }) => item.key === "auto_trial")).toBe(false);
  for (const uid of ["trial-timeout", "trial-success"]) {
    const response = await page.request.post("/admin/credentials/upload", {
      headers: { Origin: "http://127.0.0.1:5175", "X-CSRF-Token": session.csrf_token },
      data: {
        files: [
          {
            name: `${uid}.info`,
            content: JSON.stringify({
              account: { uid, nickname: uid },
              auth: {
                domain: "www.workbuddy.ai",
                accessToken: "synthetic-only-access",
                refreshToken: "synthetic-only-refresh",
                expiresAt: Date.now() + 86400000,
              },
            }),
          },
        ],
        replace: false,
      },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).results[0].ok).toBe(true);
  }
  await page.goto("/dashboard/credentials");
  await page.getByRole("button", { name: "更多 trial-timeout.info" }).click();
  await page.getByRole("button", { name: "领取体验积分 trial-timeout.info" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("button", { name: "确认领取" })).toBeEnabled();
  await drawer.getByRole("button", { name: "确认领取" }).click();
  await expect(drawer.getByRole("alert")).toContainText("领取请求超时");
  await expect(drawer.getByRole("button", { name: "确认领取" })).toBeDisabled();
  await page.screenshot({ path: "test-results/manual-trial-timeout.png", fullPage: true });
  await drawer.getByRole("button", { name: "刷新领取状态" }).click();
  await expect(drawer.getByRole("button", { name: "确认领取" })).toBeDisabled();
  await drawer.getByRole("button", { name: "关闭抽屉" }).click();
  await expect(drawer).toHaveCount(0);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "更多 trial-success.info" }).click();
  await page.getByRole("button", { name: "领取体验积分 trial-success.info" }).click();
  await drawer.getByRole("button", { name: "确认领取" }).click();
  await expect(drawer.getByText("已领取", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "确认领取" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/manual-trial-success-mobile.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "更多 trial-success.info" }).click();
  await page.getByRole("button", { name: "领取体验积分 trial-success.info" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "确认领取" })).toBeDisabled();
  const rows = (await (await page.request.get("/admin/credentials")).json()).credentials;
  expect(rows.find((row: { name: string }) => row.name === "trial-success.info").trial.state).toBe(
    "claimed",
  );
  expect(
    rows.find((row: { name: string }) => row.name === "trial-timeout.info").trial.can_claim,
  ).toBe(false);
  expect(errors).toEqual([]);
});

// ── H1: live-mode coverage for the four fusion views ────────────────────────
// playwright.integration.config.ts serves the PRODUCTION build (web/dist) through
// the fixture, so import.meta.env.DEV is false and fusion/client.ts:18 folds
// FUSION_DEVELOPMENT to false: every fusion request takes the live branch at
// fusion/client.ts:72-79 and the mock fixture is tree-shaken out. fusion.spec.ts
// cannot cover this — it runs the vite dev server where DEV is true and mock.ts
// answers. Verified in the bundle: "VITE_FUSION_LIVE"/"mockDelay" have 0 hits.

/** Fails with the offending path when a live field drifts from fusion/types.ts. */
function expectShape(value: unknown, fields: Record<string, string>, context: string) {
  expect(value, context).toBeTruthy();
  const record = value as Record<string, unknown>;
  for (const [key, kind] of Object.entries(fields))
    expect(typeof record[key], context + "." + key).toBe(kind);
}

test("live fusion views render the real management API shapes without page errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);

  // /admin/status — fusion/types.ts:109 ServiceStatus
  const status = await (await page.request.get("/admin/status")).json();
  expectShape(status, { service: "string", version: "string", uptime_seconds: "number" }, "status");
  expectShape(
    status.pool,
    { total: "number", healthy: "number", servable: "boolean" },
    "status.pool",
  );
  await page.goto("/dashboard/trends");
  await expect(page.getByRole("heading", { name: "趋势分析", exact: true })).toBeVisible();
  // Rendering the chart proves normalizeSeries accepted the live payload; a shape
  // mismatch would surface as the error notice instead.
  await expect(page.getByRole("img", { name: "按日请求量" })).toBeVisible();
  // The demo badge is guarded by FUSION_DEVELOPMENT, so its absence is the visible
  // proof this page took the live branch rather than the mock fixture.
  await expect(page.getByText("本地演示数据")).toHaveCount(0);

  // /admin/diagnostic — fusion/types.ts:164 DiagnosticResponse
  const diagnostic = await (await page.request.get("/admin/diagnostic")).json();
  expectShape(diagnostic, { generated_at: "number" }, "diagnostic");
  expect(Array.isArray(diagnostic.accounts)).toBe(true);
  expect(Array.isArray(diagnostic.model_locks)).toBe(true);
  expectShape(
    diagnostic.accounts[0],
    {
      id: "string",
      name: "string",
      profile: "string",
      health: "string",
      enabled: "boolean",
      paused: "boolean",
      transport_fails: "number",
      transport_penalty_remaining: "number",
    },
    "diagnostic.accounts[0]",
  );
  await page.goto("/dashboard/diagnostics");
  await expect(page.getByRole("heading", { name: "诊断", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "账号诊断" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "模型锁池" })).toBeVisible();
  await expect(page.getByText(diagnostic.accounts[0].name, { exact: true }).first()).toBeVisible();

  // /admin/alerts/{channels,events} — fusion/types.ts:194,231
  const channels = await (await page.request.get("/admin/alerts/channels")).json();
  expectShape(channels, { alert_enabled: "boolean", persisted: "boolean" }, "channels");
  expect(typeof channels.channels).toBe("object");
  const events = await (await page.request.get("/admin/alerts/events")).json();
  expectShape(events, { enabled: "boolean", has_more: "boolean" }, "events");
  expect(Array.isArray(events.items)).toBe(true);
  await page.goto("/dashboard/alerts");
  await expect(page.getByRole("heading", { name: "告警中心", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "通道总览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "配置通道" })).toBeEnabled();

  // /admin/credits/expiry — fusion/types.ts:270 CreditExpiryResponse
  const credits = await (await page.request.get("/admin/credits/expiry")).json();
  expectShape(credits, { generated_at: "number", threshold_days: "number" }, "credits");
  expect(Array.isArray(credits.items)).toBe(true);
  await page.goto("/dashboard/credits");
  await expect(page.getByRole("heading", { name: "积分到期提醒", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "提醒窗口" })).toBeVisible();

  // Every page above must have rendered from live data: ErrorNotice (components.tsx:83)
  // is the only role="alert" these views can produce.
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("live fusion views surface a backend failure instead of falling back to demo data", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  // Fail one live endpoint while the session stays valid. Interception is at the
  // network layer, so the page still runs the production (live) client branch.
  await page.route("**/admin/diagnostic", (route) =>
    route.fulfill({ status: 503, json: { error: { message: "诊断接口暂时不可用" } } }),
  );
  await page.goto("/dashboard/diagnostics");
  await expect(page.getByRole("heading", { name: "诊断", exact: true })).toBeVisible();
  await expect(page.getByRole("alert").first()).toContainText("诊断接口暂时不可用");
  // Mock-only fixture rows must never appear as a silent fallback.
  await expect(page.getByText("mainland-b.info")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("real management API: media summary, settings round-trip and asset CSP", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);

  const summary = await (await page.request.get("/admin/media")).json();
  expect(summary.available).toBe(true);
  expect(summary.configured).toBe(false);
  const catalog = await (await page.request.get("/admin/models")).json();
  expect(
    catalog.models.some(
      (model: { id: string; media_kinds?: string[] }) =>
        model.id === "hunyuan-image-v3.0" && model.media_kinds?.includes("image"),
    ),
  ).toBe(true);

  const session = await (await page.request.get("/admin/session")).json();
  const settings = await (await page.request.get("/admin/settings")).json();
  const saved = await page.request.patch("/admin/settings", {
    headers: { Origin: "http://127.0.0.1:5175", "X-CSRF-Token": session.csrf_token },
    data: {
      revision: settings.revision,
      values: { media_public_base_url: "https://media.example.com" },
    },
  });
  expect(saved.status()).toBe(200);
  const after = await (await page.request.get("/admin/media")).json();
  expect(after.configured).toBe(true);
  expect(after.base_url).toBe("https://media.example.com");

  const listed = await (await page.request.get("/admin/media/assets")).json();
  expect(listed.items.length).toBeGreaterThan(0);
  const asset = listed.items[0];
  expect(asset.public_url).toContain("/v1/media/images/");
  const content = await page.request.get(`/admin/media/assets/${asset.id}/content`);
  expect(content.status()).toBe(200);
  expect(content.headers()["content-security-policy"]).toBe("sandbox; default-src 'none'");
  expect(content.headers()["x-content-type-options"]).toBe("nosniff");
  // The public read route serves the same bytes without any session or key.
  const publicRead = await page.request.get(`/v1/media/images/${asset.id}`);
  expect(publicRead.status()).toBe(200);
  expect(publicRead.headers()["content-security-policy"]).toBe("sandbox; default-src 'none'");
  expect((await publicRead.body()).length).toBe(asset.size);
  expect(errors).toEqual([]);
});

test("real management API: cookie modes and API key lifecycle", async ({ page, context }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  await login(page);
  let cookie = (await context.cookies()).find((item) => item.name === "cb_admin_session");
  expect(cookie?.expires).toBe(-1);
  await page.reload();
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByLabel("密码", { exact: true })).toBeVisible();
  await login(page, true);
  cookie = (await context.cookies()).find((item) => item.name === "cb_admin_session");
  const now = Date.now() / 1000;
  expect(cookie?.expires).toBeGreaterThan(now + 399 * 86400);
  expect(cookie?.expires).toBeLessThan(now + 401 * 86400);

  await page.goto("/dashboard/keys");
  await page.getByRole("button", { name: "新建密钥" }).click();
  await page.getByLabel("名称", { exact: true }).fill("real-e2e-standard");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const secret = await dialog.locator("code").textContent();
  if (!secret) throw new Error("The real API did not return a key secret");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const inference = await page.request.get("/v1/models", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(inference.status()).toBe(200);
  const session = await (await page.request.get("/admin/session")).json();
  const keys = await (await page.request.get("/admin/keys")).json();
  const item = keys.items.find(
    (row: { id: string; name: string }) => row.name === "real-e2e-standard",
  );
  const deleted = await page.request.delete(`/admin/keys/${item.id}`, {
    headers: { Origin: "http://127.0.0.1:5175", "X-CSRF-Token": session.csrf_token },
    data: { version: item.version },
  });
  expect(deleted.status()).toBe(200);
  const denied = await page.request.get("/v1/models", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  expect(denied.status()).toBe(401);
});
