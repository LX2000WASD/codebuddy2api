import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import axios from "axios";
import type { AxiosRequestConfig } from "axios";

// Live-mode request seam: with VITE_FUSION_LIVE=true the fusion client talks to
// axios instead of the local fixture, so the abort path differs from the mock one.
// These tests pin the contract that a superseded request is an abort (silent) while
// a real failure still reaches the user.
const cancelOf = () => new axios.CanceledError("canceled");

/** Hangs until the caller's signal aborts, then rejects the way axios does. */
function hangUntilAbort(config: AxiosRequestConfig) {
  const signal = config.signal as AbortSignal | undefined;
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(cancelOf()));
  }) as Promise<unknown>;
}

/**
 * Re-imports the client with the live endpoints enabled and spies on the axios
 * instance that the fresh module graph actually uses.
 */
async function liveClient() {
  vi.resetModules();
  vi.stubEnv("VITE_FUSION_LIVE", "true");
  const [apiModule, client] = await Promise.all([import("./api"), import("./fusion/client")]);
  expect(client.FUSION_DEVELOPMENT).toBe(false);
  return { client, request: vi.spyOn(apiModule.api, "request") };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("live mode cancellation (P1-3)", () => {
  it("rejects an aborted live request with FusionAbortError, not an axios cancel", async () => {
    const { client, request } = await liveClient();
    request.mockImplementation(hangUntilAbort);
    const controller = new AbortController();
    const pending = client.fusionGet("/admin/status", new URLSearchParams(), {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(client.FusionAbortError);
  });

  it("keeps real failures as failures instead of folding them into the abort path", async () => {
    const { client, request } = await liveClient();
    const failure = new axios.AxiosError(
      "Request failed with status code 500",
      "ERR_BAD_RESPONSE",
      undefined,
      undefined,
      {
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
        config: { headers: new axios.AxiosHeaders() },
        data: {},
      },
    );
    request.mockImplementation(() => Promise.reject(failure));
    const error = await client.fusionGet("/admin/status").catch((reason: unknown) => reason);
    expect(error).toBe(failure);
    expect(error).not.toBeInstanceOf(client.FusionAbortError);
  });

  it("does not raise an error banner when a filter change supersedes the fetch", async () => {
    const { request } = await liveClient();
    request.mockImplementation((config) => {
      // The channel overview resolves so the page is otherwise settled; the event
      // stream hangs until the next filter change aborts it.
      if (config.url?.includes("/admin/alerts/channels"))
        return Promise.resolve({
          data: {
            alert_enabled: true,
            channels: {
              webhook: { enabled: true },
              bark: { enabled: false },
              email: { enabled: false },
            },
          },
        }) as never;
      return hangUntilAbort(config);
    });
    const { Alerts } = await import("./pages/Alerts");
    render(<Alerts />);
    await waitFor(() => expect(screen.getByLabelText("事件级别")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("事件级别"), { target: { value: "critical" } });
    // Give the aborted request every chance to write its (wrong) error state.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
