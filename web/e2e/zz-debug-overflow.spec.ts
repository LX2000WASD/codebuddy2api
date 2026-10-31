import { test } from "@playwright/test";
import { mockDashboard, mockSettings } from "./mock";

test("debug nav items", async ({ page }) => {
  await page.route("**/admin/**", (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/admin/session") return route.fulfill({ json: { authenticated: true, csrf_token: "fixture-only" } });
    if (path === "/admin/settings") return route.fulfill({ json: mockSettings });
    if (path === "/admin/dashboard") return route.fulfill({ json: mockDashboard });
    if (path === "/admin/credentials") return route.fulfill({ json: { credentials: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/dashboard");
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".navItem, [class*=navItem]")].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent || "").trim().slice(0, 12),
        cls: String(el.className),
        w: Math.round(r.width),
        scrollW: (el as HTMLElement).scrollWidth,
        left: Math.round(r.left),
      };
    });
    const aside = document.querySelector("aside")!;
    const cs = getComputedStyle(aside);
    return { items, asideWidth: cs.width, display: cs.display, grid: cs.gridTemplateColumns, html: aside.outerHTML.slice(0, 400) };
  });
  console.log("[navitems]", JSON.stringify(info, null, 1));
});

