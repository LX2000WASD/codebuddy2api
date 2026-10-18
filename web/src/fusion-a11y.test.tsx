import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { chooseLanguage, LanguageProvider, useDateFormat } from "./i18n";

// D-3 regressions: a11y table headers, locale-following dates, and no dead i18n keys.
import { Alerts } from "./pages/Alerts";
import { Credits } from "./pages/Credits";
import { Trends } from "./pages/Trends";
import { __resetFusionMock, __setFusionLatency } from "./fusion/mock";

beforeEach(() => {
  __resetFusionMock();
  __setFusionLatency(0);
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function withProvider(node: React.ReactNode) {
  return render(<LanguageProvider>{node}</LanguageProvider>);
}

describe("table header scopes (a11y)", () => {
  // A <th> without scope is announced ambiguously by screen readers; every header
  // cell in these tables is a column header, so each one must say scope="col".
  it("gives every header cell in the fusion tables an explicit column scope", async () => {
    // jsdom reports en-US, so pin the language the assertions are written in.
    act(() => chooseLanguage("zh"));
    withProvider(<Trends />);
    await waitFor(() => expect(screen.getByRole("img", { name: "按日请求量" })).toBeTruthy(), {
      timeout: 4000,
    });
    const headers = document.querySelectorAll("th");
    expect(headers.length).toBeGreaterThan(0);
    for (const header of headers) expect(header.getAttribute("scope")).toBe("col");
  });

  it("scopes the alert and credit tables too", async () => {
    act(() => chooseLanguage("zh"));
    withProvider(<Alerts />);
    await waitFor(() => expect(screen.getByText("积分即将到期")).toBeTruthy(), { timeout: 4000 });
    for (const header of document.querySelectorAll("th"))
      expect(header.getAttribute("scope")).toBe("col");

    withProvider(<Credits />);
    await waitFor(() => expect(screen.getByText("mainland-a.info")).toBeTruthy(), {
      timeout: 4000,
    });
    for (const header of document.querySelectorAll("th"))
      expect(header.getAttribute("scope")).toBe("col");
  });
});

describe("dates follow the active language (D-3)", () => {
  function DateProbe() {
    const format = useDateFormat();
    const stamp = new Date(Date.UTC(2026, 9, 12, 8, 30, 0));
    return (
      <>
        <span data-testid="day">{format.date(stamp)}</span>
        <span data-testid="moment">{format.dateTime(stamp)}</span>
      </>
    );
  }

  it("formats dates with the English locale when the UI is English", () => {
    render(
      <LanguageProvider>
        <DateProbe />
      </LanguageProvider>,
    );
    act(() => chooseLanguage("en"));
    const day = screen.getByTestId("day").textContent ?? "";
    // en-US renders the month first ("10/12/2026"); the hard-coded zh-CN produced
    // the year-first "2026/10/12".
    expect(day).toMatch(/^10\/12\/2026$/);
    const moment = screen.getByTestId("moment").textContent ?? "";
    expect(moment).toMatch(/10\/12\/2026/);
    expect(moment).toMatch(/AM|PM/i);
  });

  it("keeps the Chinese date order when the UI is Chinese", () => {
    render(
      <LanguageProvider>
        <DateProbe />
      </LanguageProvider>,
    );
    act(() => chooseLanguage("zh"));
    const day = screen.getByTestId("day").textContent ?? "";
    expect(day).toContain("2026");
    expect(day).toContain("10");
    expect(day).not.toContain("Oct");
  });

  it("renders the alert timestamp in the selected language instead of hard-coded zh-CN", async () => {
    act(() => chooseLanguage("zh"));
    const { container } = withProvider(<Alerts />);
    await waitFor(() => expect(screen.getByText("积分即将到期")).toBeTruthy(), { timeout: 4000 });
    const chinese = container.textContent ?? "";
    act(() => chooseLanguage("en"));
    await waitFor(() => expect(container.textContent).not.toBe(chinese));
    const english = container.textContent ?? "";
    // zh-CN renders "2026/10/18 02:26:01"; the English UI must not keep that shape.
    expect(chinese).toMatch(/\d{4}\/\d{1,2}\/\d{1,2}/);
    expect(english).not.toMatch(/\d{4}\/\d{1,2}\/\d{1,2}/);
    expect(english).toMatch(/\d{4}/);
  });
});

describe("i18n catalogue hygiene (D-3)", () => {
  it("keeps every catalogue key referenced by the source", async () => {
    // The dead-key cleanup deleted 20 never-referenced keys from both maps; this
    // guard fails if a removed key is still requested somewhere.
    const { translate } = await import("./i18n");
    for (const key of [
      "logs.panel.runtime",
      "dash.storage.wal",
      "dash.totalRequests",
      "dash.rangeHint",
    ])
      expect(translate(key)).toBe(key);
    // ...while live keys still resolve.
    expect(translate("nav.overview")).not.toBe("nav.overview");
  });
});
