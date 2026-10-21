import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { deriveTrace, RequestTrace } from "./traceView";

/**
 * A recorded trail of the shape the backend actually produces for a request that hit a
 * 429 and recovered on the next dial: two dials, one HTTP error, one recovery marker.
 * Field names come from app/audit_store.py safe_attempt().
 */
const recovered: Record<string, unknown>[] = [
  {
    request_id: "root-request",
    session_source: "explicit",
    attempt_id: "dial-1",
    attempt_index: 1,
    stage: "upstream_attempt",
    profile: "cn-cli",
    upstream_model: "hy3",
    credential: "acct-a",
    upstream_request_id: "up-req-1",
  },
  {
    request_id: "root-request",
    attempt_id: "dial-1",
    attempt_index: 1,
    stage: "upstream_http",
    status_code: 429,
    duration_ms: 120,
  },
  {
    request_id: "root-request",
    attempt_id: "dial-1",
    attempt_index: 1,
    stage: "upstream_http_error",
    status_code: 429,
    error_code: "429001",
    retry_after: 2,
    upstream_request_id: "up-req-2",
  },
  { request_id: "root-request", stage: "failover_recovered", code: "upstream_429" },
  {
    request_id: "root-request",
    attempt_id: "dial-2",
    attempt_index: 2,
    stage: "upstream_attempt",
    profile: "cn-cli",
    upstream_model: "hy3",
    credential: "acct-b",
    upstream_request_id: "up-req-3",
  },
  {
    request_id: "root-request",
    attempt_id: "dial-2",
    attempt_index: 2,
    stage: "upstream_http",
    status_code: 200,
    duration_ms: 380,
  },
];

function steps(container: HTMLElement) {
  return [...container.querySelectorAll("[data-trace-stage]")];
}

describe("deriveTrace", () => {
  it("keeps the recorded order and numbers every stage from one", () => {
    const trace = deriveTrace(recovered, 640);
    expect(trace.steps.map((step) => step.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(trace.steps.map((step) => step.stage)).toEqual([
      "upstream_attempt",
      "upstream_http",
      "upstream_http_error",
      "failover_recovered",
      "upstream_attempt",
      "upstream_http",
    ]);
  });

  it("accumulates only the stages that reported a duration", () => {
    const trace = deriveTrace(recovered, 640);
    expect(trace.steps.map((step) => step.durationMs)).toEqual([null, 120, null, null, null, 380]);
    // A marker stage inherits the running total instead of adding a fake zero slice.
    expect(trace.steps.map((step) => step.cumulativeMs)).toEqual([0, 120, 120, 120, 120, 500]);
    expect(trace.knownMs).toBe(500);
  });

  it("scales against the request total so unattributed time stays visible", () => {
    // 640 ms total vs 500 ms of stages: the bar denominator must be 640, not 500,
    // otherwise the 140 ms spent outside the upstream trail silently disappears.
    expect(deriveTrace(recovered, 640).scaleMs).toBe(640);
    // Without a request total the stages are all the truth there is.
    expect(deriveTrace(recovered, undefined).scaleMs).toBe(500);
    // Never zero: a 0 ms stage must still draw a track rather than divide by zero.
    expect(deriveTrace([{ stage: "upstream_attempt", duration_ms: 0 }], 0).scaleMs).toBe(1);
  });

  it("marks failures, retries and overflow without guessing at unknown stages", () => {
    const trace = deriveTrace(
      [
        { stage: "upstream_http_error", status_code: 502, error_code: "bad_gateway" },
        { stage: "connect_retry", error_code: "ConnectError" },
        { stage: "brand_new_stage", duration_ms: 5 },
        { stage: "attempts_truncated", dropped: 7 },
      ],
      10,
    );
    expect(trace.steps.map((step) => step.tone)).toEqual(["failed", "warn", "normal", "warn"]);
    expect(trace.steps[0].errorCode).toBe("bad_gateway");
    expect(trace.steps[2].stage).toBe("brand_new_stage");
    expect(trace.dropped).toBe(7);
  });

  it("falls back to the generic code field when a stage carries no error_code", () => {
    expect(
      deriveTrace([{ stage: "failover_recovered", code: "upstream_429" }]).steps[0].errorCode,
    ).toBe("upstream_429");
  });

  it("treats a rejected dial as a failure even without a companion error stage", () => {
    // upstream_http_error is not a reliable companion: converter.py:4300 only emits it
    // when the error body carries a business code, so a bare 429/403/500 records the
    // status alone. Measured on a real 312 MB audit database (snapshot 2026-10-17):
    // 170 of 93,527 upstream_http rows were non-200 (164x429, 4x500, 2x403). That
    // snapshot predates the companion stage, so the conditional emission in the backend
    // — not the counts — is what makes this case real.
    const trace = deriveTrace(
      [
        { stage: "upstream_http", status_code: 429 },
        { stage: "upstream_http", status_code: 403 },
        { stage: "upstream_http", status_code: 500 },
        { stage: "upstream_http", status_code: 200 },
        { stage: "upstream_http" },
      ],
      10,
    );
    expect(trace.steps.map((step) => step.tone)).toEqual([
      "failed",
      "failed",
      "failed",
      "normal",
      "normal",
    ]);
  });

  it("keeps both rows of one rejected dial a failure", () => {
    // The 11128 channel rejection records both stages for a single dial; both must read
    // as failures rather than one failed and one healthy.
    const trace = deriveTrace(
      [
        { stage: "upstream_http", status_code: 400 },
        { stage: "upstream_http_error", status_code: 400, error_code: "11128" },
      ],
      10,
    );
    expect(trace.steps.map((step) => step.tone)).toEqual(["failed", "failed"]);
    expect(trace.steps[1].errorCode).toBe("11128");
  });

  it("knows the observer stage a bounded parser leaves behind", () => {
    // Observed in a real audit database: 5716 of ~193k attempt rows carried this stage
    // with code=bounded_parse_skipped. It is informational, not a failure.
    const trace = deriveTrace([{ stage: "observer", code: "bounded_parse_skipped" }], 10);
    expect(trace.steps[0].tone).toBe("warn");
  });

  it("assigns a deliberate tone to every stage the backend can record", () => {
    // A full audit of the mapping, so a new stage or a silent tone drift shows up here
    // rather than as a colour nobody questions. Every entry was checked against its
    // terminal outcome in converter.py / app/observability.py:
    //   failed — the request cannot succeed through this stage
    //   warn   — recovered, retried, or informational
    //   normal — the healthy path
    const expected: Record<string, "normal" | "failed" | "warn"> = {
      // healthy path
      upstream_attempt: "normal",
      upstream_http: "normal", // refined to "failed" for 4xx/5xx by toneFor
      intl_image_merge: "normal",
      // terminal failures
      upstream_http_error: "failed", // converter.py:4304, request fails over
      transport: "failed", // :4224, the dial never opened
      upstream_queue_full: "failed", // :4245, upstream capacity exhausted
      dsml_rejected: "failed", // :4377, markup seen but not restorable -> 502
      tool_args_exhausted: "failed", // :4390, retry budget spent -> 502
      content_filter: "failed", // :5013 final=True, upstream refusal is terminal
      request_preflight_rejected: "failed", // :2755, HTTP 400 before any dial
      // recovered / retried / informational
      dsml_repaired: "warn", // :4373, the turn succeeds with restored tool calls
      native_markup_opensource: "warn", // :4128, observed only, never rewritten
      tool_args_retry: "warn", // :4396, one more generation is attempted
      content_filter_retry: "warn", // :5013 final=False, one template retry
      connect_retry: "warn", // :4179, redialled
      write_timeout_retry: "warn", // :4179, replayed
      failover_recovered: "warn", // observability.py:293, another credential worked
      attempts_truncated: "warn", // :265, the trail itself was cut short
      observer: "warn", // :493, parsing stopped early, request may still succeed
    };
    const stages = Object.keys(expected);
    const trace = deriveTrace(
      stages.map((stage) => ({ stage, status_code: 200 })),
      10,
    );
    expect(trace.steps).toHaveLength(stages.length);
    expect(Object.fromEntries(trace.steps.map((step) => [step.stage, step.tone]))).toEqual(
      expected,
    );
  });
});

describe("RequestTrace", () => {
  it("renders every stage in order with its cumulative time", () => {
    const { container } = render(<RequestTrace attempts={recovered} requestMs={640} />);
    const rendered = steps(container);
    expect(rendered).toHaveLength(6);
    expect(rendered.map((row) => row.getAttribute("data-trace-stage"))).toEqual([
      "upstream_attempt",
      "upstream_http",
      "upstream_http_error",
      "failover_recovered",
      "upstream_attempt",
      "upstream_http",
    ]);
    // Ordinals are the visible sequence numbers, 1..6.
    expect(rendered.map((row) => row.querySelector("span")?.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
    ]);
    // The route prefix shares the meta line with the cumulative total, so the whole
    // line is the unit of assertion here. Only the "upstream_attempt" stage carries the
    // route; the HTTP stage that follows inherits the running total alone.
    expect(rendered[0].textContent).toContain("cn-cli · hy3 · acct-a · 累计 0 ms");
    expect(rendered[1].textContent).toContain("累计 120 ms");
    expect(rendered[5].textContent).toContain("累计 500 ms");
    expect(rendered[1].textContent).toContain("120 ms");
    expect(rendered[5].textContent).toContain("380 ms");
    // Stages without a duration say so instead of rendering "0 ms".
    expect(screen.getAllByText("无耗时")).toHaveLength(4);
  });

  it("does not paint an informational code as an error", () => {
    // failover_recovered and observer both carry a code; only a failed stage's code
    // should read as an error, otherwise a recovery is reported as a failure.
    const { container } = render(
      <RequestTrace
        attempts={[
          { stage: "failover_recovered", code: "upstream_429" },
          { stage: "upstream_http_error", status_code: 400, error_code: "11128" },
        ]}
        requestMs={10}
      />,
    );
    const rendered = steps(container);
    const badges = (row: Element) =>
      [...row.querySelectorAll("span")].map((node) => node.className).join(" ");
    expect(rendered[0].textContent).toContain("upstream_429");
    expect(badges(rendered[0])).not.toMatch(/_bad_/);
    expect(rendered[1].textContent).toContain("11128");
    expect(badges(rendered[1])).toMatch(/_bad_/);
  });

  it("gives a failing stage the failure treatment and its codes", () => {
    const { container } = render(<RequestTrace attempts={recovered} requestMs={640} />);
    const rendered = steps(container);
    expect(rendered[2].getAttribute("data-trace-tone")).toBe("failed");
    expect(rendered[2].textContent).toContain("429001");
    expect(rendered[2].textContent).toContain("等待 2 秒");
    // The recovery marker is a retry, not a failure.
    expect(rendered[3].getAttribute("data-trace-tone")).toBe("warn");
    // The dial that came back 429 is a failure, even though the backend never wrote a
    // companion upstream_http_error for it (no business code in the body).
    expect(rendered[1].getAttribute("data-trace-tone")).toBe("failed");
  });

  it("scales each bar against the request total", () => {
    const { container } = render(<RequestTrace attempts={recovered} requestMs={640} />);
    const widths = steps(container).map(
      (row) => (row.querySelector("[class*='traceBar'] span") as HTMLElement | null)?.style.width,
    );
    expect(widths).toEqual(["0%", "18.75%", "0%", "0%", "0%", "59.375%"]);
  });

  it("shows the route of each dial and the retry counters", () => {
    const { container } = render(<RequestTrace attempts={recovered} requestMs={640} />);
    const rendered = steps(container);
    expect(rendered[0].textContent).toContain("第 1 次拨号");
    expect(rendered[0].textContent).toContain("cn-cli · hy3 · acct-a");
    expect(rendered[4].textContent).toContain("第 2 次拨号");
    expect(rendered[4].textContent).toContain("acct-b");
  });

  it("makes the upstream request id copyable and reports clipboard failures", async () => {
    const { container } = render(<RequestTrace attempts={recovered} requestMs={640} />);
    // One copy button per stage that carries an id: dial 1 has two, dial 2 has one.
    expect(screen.getAllByRole("button", { name: "复制上游请求 ID" })).toHaveLength(3);
    const copy = screen.getAllByRole("button", { name: "复制上游请求 ID" })[0];
    // jsdom has no clipboard: the button must say the copy failed rather than claim success.
    fireEvent.click(copy);
    expect(copy.textContent).toContain("复制失败");

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    fireEvent.click(copy);
    await screen.findByText("已复制");
    expect(writeText).toHaveBeenCalledWith("up-req-1");

    // A denied clipboard (insecure context) must not leave the success label behind.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    fireEvent.click(copy);
    expect(copy.textContent).toContain("复制失败");
    expect(container.querySelectorAll("button")).toHaveLength(3);
  });

  it("reports how much of the request the stages explain", () => {
    render(<RequestTrace attempts={recovered} requestMs={640} />);
    expect(screen.getByText("6 段 · 请求总计 640 ms，其中 500 ms 有分段记录")).toBeTruthy();
  });

  it("surfaces the overflow marker's dropped count", () => {
    render(
      <RequestTrace attempts={[{ stage: "attempts_truncated", dropped: 7 }]} requestMs={10} />,
    );
    expect(screen.getByText("另有 7 段未记录（后端只保留最近 32 段）")).toBeTruthy();
  });

  it("keeps an unknown stage visible under its raw name", () => {
    render(<RequestTrace attempts={[{ stage: "brand_new_stage" }]} />);
    expect(screen.getByText("brand_new_stage")).toBeTruthy();
  });

  it("says so when there is nothing recorded", () => {
    render(<RequestTrace attempts={[]} />);
    expect(screen.getByText("暂无尝试记录。")).toBeTruthy();
  });
});
