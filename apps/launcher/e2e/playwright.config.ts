import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcherDir = path.resolve(here, "..");
const PORT = 13049;

export default defineConfig({
  testDir: ".",
  outputDir: "test-results",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--no-sandbox"] } },
    },
  ],
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    cwd: launcherDir,
    url: `http://localhost:${PORT}`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
