import { expect, test } from "@playwright/test";
import { mockDashboard, mockSettings } from "./mock";

test("debug account save", async ({ page }) => {
  page.on("console", (m) => console.log("[console]", m.type(), m.text()));
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/admin/session")
      return route.fulfill({ json: { authenticated: true, csrf_token: "old-csrf", bootstrap: true } });
    if (path === "/admin/settings") return route.fulfill({ json: mockSettings });
    if (path === "/admin/dashboard") return route.fulfill({ json: mockDashboard });
    if (path === "/admin/account" && request.method() === "GET")
      return route.fulfill({ json: { username: "admin", password_source: "user", bootstrap: true, changed_at: 1789200000 } });
    if (path === "/admin/account" && request.method() === "PUT") {
      console.log("[PUT body]", request.postData());
      console.log("[PUT csrf]", request.headers()["x-csrf-token"]);
      return route.fulfill({ json: { username: "root", bootstrap: false, csrf_token: "new-csrf" } });
    }
    console.log("[other]", request.method(), path);
    return route.fulfill({ json: {} });
  });
  await page.goto("/dashboard/system?tab=account");
  await page.getByLabel("用户名", { exact: true }).fill("root");
  await page.getByLabel("当前管理密码", { exact: true }).fill("old-password");
  await page.getByLabel("新密码", { exact: true }).fill("new-password");
  await page.getByLabel("再次输入新密码", { exact: true }).fill("new-password");
  await page.getByRole("button", { name: "保存账户更改" }).click();
  await page.waitForTimeout(1500);
  console.log("[toasts]", await page.locator("[class*=toast]").count());
  console.log("[strong texts]", JSON.stringify(await page.locator("strong").allTextContents()));
  console.log("[alerts]", JSON.stringify(await page.locator("[role=alert]").allTextContents()));
  expect(true).toBe(true);
});

