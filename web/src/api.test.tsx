import { StrictMode } from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import {
  AxiosError,
  AxiosHeaders,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from "axios";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  api,
  credentialResponse,
  establishSession,
  errorMessage,
  metric,
  modelResponse,
  object,
  useResource,
  useSession,
} from "./api";
const adapter = api.defaults.adapter;
afterEach(() => {
  api.defaults.adapter = adapter;
  useSession.setState({ status: "checking", csrf: null, error: null });
});
/**
 * Registers an abort listener on a request config signal.
 *
 * axios types `signal` as `AbortSignal | GenericAbortSignal`, where the generic
 * variant only guarantees `aborted` — so `addEventListener` is "possibly undefined"
 * and the optional-call form trips the type checker. Real adapters always pass an
 * AbortSignal; the guard keeps the tests honest without a cast at each call site.
 */
function onAbort(config: InternalAxiosRequestConfig, listener: () => void) {
  const signal = config.signal;
  if (signal && typeof signal.addEventListener === "function")
    signal.addEventListener("abort", listener);
}

function response(data: unknown, config: InternalAxiosRequestConfig) {
  return { data, status: 200, statusText: "OK", headers: new AxiosHeaders(), config };
}
/**
 * An adapter that behaves like the real one where it matters: it honours the abort
 * signal. `mockResolvedValue` does not, which is exactly why the StrictMode
 * double-fetch bug shipped green unit tests and a red e2e run.
 */
function abortableAdapter(reply: (config: InternalAxiosRequestConfig) => unknown, delayMs = 20) {
  const seen: string[] = [];
  const adapter = ((config) => {
    seen.push(String(config.url));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response(reply(config), config)), delayMs);
      onAbort(config, () => {
        clearTimeout(timer);
        reject(new AxiosError("canceled", "ERR_CANCELED", config));
      });
    });
  }) satisfies AxiosAdapter;
  return { adapter, seen };
}

/**
 * Module-level on purpose: useResource depends on `normalize`, so an inline parser
 * would restart the effect on every render (and, with a real request, spin).
 */
const asOk = (value: unknown) => value as { ok: boolean };

describe("shared snapshot requests", () => {
  function Probe({ path }: { path: string }) {
    const resource = useResource(path, asOk, { cache: true });
    return <span>{resource.error ?? String(resource.data?.ok ?? "none")}</span>;
  }

  it("survives the StrictMode mount/cleanup/mount pass with one request", async () => {
    // StrictMode mounts the effect, immediately cleans it up, then mounts it again.
    // The cleanup used to abort the request the second pass had just joined, so the
    // page rendered "cannot reach the admin API" even though the data was in flight.
    const { adapter: mock, seen } = abortableAdapter(() => ({ ok: true }), 25);
    api.defaults.adapter = mock;
    render(
      <StrictMode>
        <Probe path="/strict-probe" />
      </StrictMode>,
    );
    expect(await screen.findByText("true")).toBeTruthy();
    // De-duplication: the second pass re-joined the first request instead of firing
    // its own, and nothing was left in an error state.
    expect(seen).toEqual(["/strict-probe"]);
  });

  it("does not merge requests that differ only in params", async () => {
    const { adapter: mock, seen } = abortableAdapter((config) => ({ ok: config.url === "/p?a=1" }));
    api.defaults.adapter = mock;
    render(
      <>
        <Probe path="/p?a=1" />
        <Probe path="/p?a=2" />
      </>,
    );
    await waitFor(() => expect(seen.length).toBe(2));
    expect(seen.sort()).toEqual(["/p?a=1", "/p?a=2"]);
  });

  it("aborts an abandoned request once its last caller unmounts", async () => {
    // The other half of the contract: "not cancelled by one caller" must not become
    // "never cancelled". The last release aborts, so a page the user navigated away
    // from does not hold a connection open.
    let aborted = false;
    const seen: string[] = [];
    api.defaults.adapter = ((config) => {
      seen.push(String(config.url));
      return new Promise((_resolve, reject) => {
        onAbort(config, () => {
          aborted = true;
          reject(new AxiosError("canceled", "ERR_CANCELED", config));
        });
      });
    }) satisfies AxiosAdapter;
    const view = render(<Probe path="/abandoned" />);
    await waitFor(() => expect(seen).toEqual(["/abandoned"]));
    expect(aborted).toBe(false);
    view.unmount();
    // The grace period is a macrotask, so the abort lands on the next tick.
    await waitFor(() => expect(aborted).toBe(true));
  });

  it("keeps the request alive across a StrictMode remount instead of aborting it", async () => {
    // Regression guard for the bug this layer shipped with: the cleanup of the first
    // StrictMode pass aborted the request the second pass had just joined.
    let aborted = false;
    const { adapter: mock, seen } = abortableAdapter(() => ({ ok: true }), 30);
    api.defaults.adapter = ((config) => {
      onAbort(config, () => {
        aborted = true;
      });
      return mock(config);
    }) satisfies AxiosAdapter;
    render(
      <StrictMode>
        <Probe path="/strict-alive" />
      </StrictMode>,
    );
    expect(await screen.findByText("true")).toBeTruthy();
    expect(seen).toEqual(["/strict-alive"]);
    expect(aborted).toBe(false);
  });
});

describe("API and session state", () => {
  it("keeps unknown distinct from explicit zero", () => {
    expect(metric(undefined)).toBe("—");
    expect(metric(null)).toBe("—");
    expect(metric(0)).toBe("0");
  });
  it("rejects malformed DTO instead of fabricating empty success", () => {
    expect(() => modelResponse({ models: [] })).toThrow("revision");
    expect(() => credentialResponse({})).toThrow();
    expect(() => credentialResponse({ credentials: [{ name: "x.info" }] })).toThrow("account_key");
  });
  it("uses account_key and never uses an absolute filename for deletion", () => {
    const rows = credentialResponse({
      credentials: [{ account_key: "account-1", name: "/private/x.info" }],
    });
    expect(rows[0]).toMatchObject({ id: "account-1", name: null });
  });
  it("reads CSRF from session and includes credentials / CSRF in OAuth poll", async () => {
    const seen: InternalAxiosRequestConfig[] = [];
    api.defaults.adapter = ((config) => {
      seen.push(config);
      return Promise.resolve(
        response(
          config.url === "/session"
            ? { authenticated: true, csrf_token: "mock-csrf" }
            : { done: false },
          config,
        ),
      );
    }) satisfies AxiosAdapter;
    await establishSession("isolated-test-key");
    await api.get("/oauth/poll", { params: { login_id: "mock-login" } });
    expect(seen[0].withCredentials).toBe(true);
    expect(seen[1].headers.get("X-CSRF-Token")).toBe("mock-csrf");
    expect(useSession.getState().csrf).toBe("mock-csrf");
    expect(JSON.stringify(useSession.getState())).not.toContain("isolated-test-key");
    expect(localStorage.length).toBe(0);
  });
  it("reports session schema errors without authenticating", async () => {
    api.defaults.adapter = (config) => Promise.resolve(response({ authenticated: true }, config));
    await establishSession();
    expect(useSession.getState().status).toBe("error");
    expect(useSession.getState().csrf).toBeNull();
  });
  it("turns a 401 into anonymous and drops csrf", async () => {
    useSession.setState({ status: "authenticated", csrf: "old" });
    api.defaults.adapter = (config) =>
      Promise.reject(
        new AxiosError("unauthorized", "ERR_BAD_REQUEST", config, undefined, {
          ...response({}, config),
          status: 401,
        }),
      );
    await establishSession();
    expect(useSession.getState().status).toBe("anonymous");
    expect(useSession.getState().csrf).toBeNull();
  });
  it("exposes failed resource requests and allows retry", async () => {
    let failure = true;
    api.defaults.adapter = (config) =>
      failure
        ? Promise.reject(new Error("mock unavailable"))
        : Promise.resolve(response({ count: 0 }, config));
    const { result } = renderHook(() => useResource("/dashboard", object));
    await waitFor(() => expect(result.current.error).toBe("mock unavailable"));
    expect(result.current.data).toBeNull();
    failure = false;
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toEqual({ count: 0 }));
    expect(result.current.error).toBeNull();
  });
  it("identifies revision conflicts", () => {
    const config = { headers: new AxiosHeaders() } as InternalAxiosRequestConfig;
    expect(
      errorMessage(
        new AxiosError("conflict", "ERR_BAD_REQUEST", config, undefined, {
          ...response({}, config),
          status: 409,
        }),
      ),
    ).toContain("保存冲突");
  });
});
