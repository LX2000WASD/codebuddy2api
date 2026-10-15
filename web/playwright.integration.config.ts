import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "backend.integration.ts",
  timeout: 30000,
  globalTimeout: 90000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5175",
    locale: "zh-CN",
    viewport: { width: 1440, height: 1050 },
    launchOptions: {
      executablePath: process.env.WEBUI_CHROMIUM,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
    trace: "retain-on-failure",
  },
  webServer: {
    // e2e/fusion-live-server.py reuses tests/webui_fixture.py and adds the three
    // fusion installs converter.py performs at :4946-4954 (see that file's header).
    command: `${process.env.WEBUI_PYTHON ?? "../.venv/bin/python"} -B e2e/fusion-live-server.py`,
    stdout: "pipe",
    stderr: "pipe",
    wait: { stderr: /Uvicorn running on http:\/\/127\.0\.0\.1:5175/ },
    reuseExistingServer: false,
    timeout: 20000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10000 },
  },
});
