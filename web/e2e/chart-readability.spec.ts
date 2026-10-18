import { expect, test, type Page } from "@playwright/test";

// Regression for the fusion charts' narrow-screen legibility.
//
// charts.tsx used to draw into a fixed 1160x220 viewBox scaled with
// preserveAspectRatio="xMidYMid meet" inside a width:100% card. On a 390px phone the
// SVG was 307px wide, so the uniform scale was ~0.26 and the 11px tick labels
// rendered at ~4px (measured: 4px @390, 6px @900, 11px only @1440). The viewBox now
// follows the measured container width (1 user unit = 1 CSS px), so the labels keep
// their designed size everywhere without stretching the plot.
const MIN_TICK_PX = 10;

async function openTrends(page: Page) {
  await page.route("**/admin/session", (route) =>
    route.fulfill({ json: { authenticated: true, csrf_token: "chart-fixture" } }),
  );
  await page.goto("/dashboard/trends");
  const chart = page.getByRole("img", { name: "按日请求量" });
  await expect(chart).toBeVisible();
  await chart.scrollIntoViewIfNeeded();
  return chart;
}

/** Rendered tick-label height plus the axis scale used for the plot geometry. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector("svg[role=img]") as SVGSVGElement;
    const ctm = svg.getScreenCTM()!;
    const ticks = Array.from(svg.querySelectorAll("text")).map((element) => {
      const box = element.getBoundingClientRect();
      return { text: element.textContent ?? "", width: box.width, height: box.height };
    });
    // A rect keeps its authored width/height only when the viewBox is not stretched.
    const rect = svg.querySelector("rect")!;
    const painted = rect.getBoundingClientRect();
    return {
      tickHeights: ticks.map((tick) => tick.height),
      tickLabels: ticks.map((tick) => tick.text),
      scaleX: ctm.a,
      scaleY: ctm.d,
      rectScaleX: painted.width / Number(rect.getAttribute("width")),
      rectScaleY: painted.height / Number(rect.getAttribute("height")),
      viewBox: svg.getAttribute("viewBox"),
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
}

test("fusion chart tick labels stay readable at 390px without distorting the plot", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const chart = await openTrends(page);
  const metrics = await measure(page);

  expect(metrics.tickHeights.length).toBeGreaterThan(0);
  // Every tick label — axis values, the mean reference and the peak annotation.
  expect(Math.min(...metrics.tickHeights)).toBeGreaterThanOrEqual(MIN_TICK_PX);
  expect(metrics.tickLabels).toContain("均值 29.43");

  // No distortion: one user unit maps to one CSS pixel on both axes, so the plot is
  // scaled uniformly rather than stretched to fill the card.
  expect(metrics.scaleX).toBeCloseTo(metrics.scaleY, 3);
  expect(metrics.rectScaleX).toBeCloseTo(metrics.rectScaleY, 3);
  expect(metrics.scaleX).toBeGreaterThan(0.95);
  expect(metrics.pageOverflow).toBe(false);

  // The viewBox follows the rendered width instead of the old fixed 1160 canvas.
  expect(Number(metrics.viewBox?.split(" ")[2])).toBeLessThan(400);

  // Hover detail still lands on the bucket under the cursor at this width.
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2, { steps: 3 });
  const left = await page.locator("[role=status]").first().textContent();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2, { steps: 3 });
  const right = await page.locator("[role=status]").first().textContent();
  expect(left).toContain("2026-10-12");
  expect(right).toContain("2026-10-18");
});

test("fusion chart keeps readable ticks on a desktop viewport too", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openTrends(page);
  const metrics = await measure(page);
  expect(Math.min(...metrics.tickHeights)).toBeGreaterThanOrEqual(MIN_TICK_PX);
  expect(metrics.scaleX).toBeCloseTo(metrics.scaleY, 3);
  expect(metrics.rectScaleX).toBeCloseTo(metrics.rectScaleY, 3);
  // The old fixed 1160-wide viewBox was scaled down to 0.88 here; text should not be
  // shrunk at all on a wide card either.
  expect(metrics.scaleX).toBeGreaterThan(0.98);
});
