import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  outputDir: "../../test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "../../playwright-report", open: "never" }]
  ],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: "corepack pnpm --filter @nexus/core dev",
      url: "http://127.0.0.1:4100/health",
      reuseExistingServer: true,
      timeout: 60_000
    },
    {
      command: "corepack pnpm --filter @nexus/web dev",
      url: "http://127.0.0.1:3000/sessions/demo",
      reuseExistingServer: true,
      timeout: 60_000
    }
  ],
  projects: [
    {
      name: "desktop-1440x900",
      use: {
        viewport: { width: 1440, height: 900 }
      }
    },
    {
      name: "mobile-390x844",
      use: {
        viewport: { width: 390, height: 844 }
      }
    }
  ]
});