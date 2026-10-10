import { expect, test, type Page } from "@playwright/test";

// The fusion views ship with a local fixture layer while the Fusion-B backend
// lands, so the new pages must render WITHOUT any /admin request beyond the session.
async function mockSession(page: Page) {
  const fusionPaths: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/admin/") && !url.pathname.startsWith("/admin/session"))
      fusionPaths.push(`${request.method()} ${url.pathname}`);
  });
  await page.route("**/admin/session", (route) =>
    route.fulfill({ json: { authenticated: true, csrf_token: "fusion-fixture" } }),
  );
  return () => fusionPaths;
}

test("trends renders demo data and switches metrics without upstream calls", async ({ page }) => {
  const requests = await mockSession(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/dashboard/trends");
  await expect(page.getByRole("heading", { name: "趋势分析", exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "按日请求量" })).toBeVisible();
  // Mean reference and peak annotation come from the chart content.
  await expect(page.locator("main")).toContainText("均值");
  await expect(page.locator("main")).toContainText("峰值");
  // Dimension split: picking a model loads the dimension list locally.
  await page.getByLabel("切分维度").selectOption("model");
  await page.getByLabel("切分对象").waitFor({ state: "visible" });
  await expect(page.getByRole("img", { name: "按日请求量" })).toBeVisible();
  // Metric tabs swap the chart; the legend keeps every P-series reachable.
  await page.getByRole("tab", { name: "延迟分位" }).click();
  await expect(page.getByRole("button", { name: /P95/ })).toBeVisible();
  await page.getByRole("tab", { name: "生成速率" }).click();
  await expect(page.getByRole("button", { name: /生成速率/ })).toBeVisible();
  await page.screenshot({ path: "test-results/fusion-trends.png", fullPage: true });
  expect(requests()).toEqual([]);
  expect(errors).toEqual([]);
});

test("diagnostics shows accounts and the model lock pool", async ({ page }) => {
  const requests = await mockSession(page);
  await page.goto("/dashboard/diagnostics");
  await expect(page.getByRole("heading", { name: "诊断", exact: true })).toBeVisible();
  await expect(page.getByText("mainland-b.info")).toBeVisible();
  await expect(page.getByRole("heading", { name: "账号诊断" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "模型锁池" })).toBeVisible();
  await expect(page.getByText("模型额度冷却")).toBeVisible();
  await page.screenshot({ path: "test-results/fusion-diagnostics.png", fullPage: true });
  expect(requests()).toEqual([]);
});

test("alerts shows the event stream and the channel overview", async ({ page }) => {
  const requests = await mockSession(page);
  await page.goto("/dashboard/alerts");
  await expect(page.getByRole("heading", { name: "告警中心", exact: true })).toBeVisible();
  await expect(page.getByText("积分即将到期")).toBeVisible();
  await expect(page.getByRole("button", { name: "配置通道" })).toBeVisible();
  // Severity filter narrows the stream client-side after the local fetch.
  await page.getByLabel("事件级别").selectOption("critical");
  await expect(page.getByText("全池无可服务账号")).toBeVisible();
  await expect(page.getByText("积分即将到期")).toHaveCount(0);
  await page.screenshot({ path: "test-results/fusion-alerts.png", fullPage: true });
  expect(requests()).toEqual([]);
});

test("credits expiry cards show FEFO batches and the burn rate", async ({ page }) => {
  const requests = await mockSession(page);
  await page.goto("/dashboard/credits");
  await expect(page.getByRole("heading", { name: "积分到期提醒", exact: true })).toBeVisible();
  await expect(page.getByText("旗舰版连续包月")).toBeVisible();
  await expect(page.getByRole("heading", { name: "到期分布" })).toBeVisible();
  await page.screenshot({ path: "test-results/fusion-credits.png", fullPage: true });
  expect(requests()).toEqual([]);
});

test("credential paused toggle optimistically flips and reports", async ({ page }) => {
  await page.route("**/admin/session", (route) =>
    route.fulfill({ json: { authenticated: true, csrf_token: "fusion-fixture" } }),
  );
  await page.route("**/admin/credentials", (route) =>
    route.fulfill({
      json: {
        credentials: [
          {
            id: "mock-account",
            name: "mock-account.info",
            enabled: true,
            profile: "cn-cli",
            health: "ready",
            credits: { remaining: 250 },
          },
        ],
      },
    }),
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/dashboard/credentials");
  const pause = page.getByRole("switch", { name: "暂停账号 mock-account.info" });
  await expect(pause).toBeVisible();
  await pause.click();
  // The optimistic flip lands instantly; a notice explains the routing effect.
  await expect(page.getByText(/不再参与选号/)).toBeVisible();
  await expect(pause).toBeChecked();
  expect(errors).toEqual([]);
});
