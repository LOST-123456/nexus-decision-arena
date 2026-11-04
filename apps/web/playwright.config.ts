import { defineConfig } from "@playwright/test";

process.env.LLM_MODE ??= "mock";
/*
 * E2E runs without a provider key, so it exercises the fixture path on purpose.
 * The product itself refuses to analyse until a model is configured — that
 * refusal is the default — so the permission has to be granted explicitly here
 * rather than baked into the default. Without this flag every spec that creates
 * a review would hit the "先配置模型" gate, which is the correct behaviour for a
 * real deployment and the wrong one for this suite.
 */
process.env.NEXUS_ALLOW_FIXTURE_RUNS ??= "1";
/*
 * The suite and the server it drives must be looking at the same database.
 *
 * Some specs assert on rows the pipeline wrote — "the database is the authority,
 * not the button". When the two processes disagree about which database that is
 * (core defaults to `nexus`, a spec defaults to `nexus_test_e2e`), those
 * assertions read an empty table and the failure looks like a broken feature.
 * Pinning one value here makes the webServer inherit it.
 *
 * Caveat that no config can remove: with `reuseExistingServer` the suite may
 * attach to a server someone else started with a different DATABASE_URL. The
 * spec that reads rows directly says so explicitly when that happens.
 */
process.env.DATABASE_URL ??=
  "postgres://nexus:nexus@127.0.0.1:5433/nexus_test_e2e";

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
      command: "corepack pnpm --filter @nexus/core exec tsx src/server.ts",
      url: "http://127.0.0.1:4100/health",
      /*
       * Not `true`. Reusing whatever core happens to be running meant the suite
       * could attach to a server pointed at `nexus_demo` while asserting on
       * rows in `nexus_test_e2e` — the table reads empty and a working feature
       * looks broken. Owning the process is the only way to know both sides
       * read the same database.
       *
       * Consequence: stop the dev site (or the tray launcher) before running
       * E2E, or the port is taken. Playwright says so in one line.
       *
       * `E2E_REUSE_EXISTING=1` opts back in, for debugging one spec against a
       * site that is already up — set DATABASE_URL to that site's database at
       * the same time, or the row-level assertions will read the wrong tables.
       */
      reuseExistingServer: process.env.E2E_REUSE_EXISTING === "1",
      timeout: 60_000
    },
    {
      command: "corepack pnpm --filter @nexus/web dev",
      /*
       * `port`, not `url`. The HTTP probe was unreliable here in a way that had
       * nothing to do with the app: while Playwright reported "Timed out
       * waiting", an external `curl` of the same URL answered 200 from the same
       * server. A dev server is up when its socket accepts connections; asking
       * it to also answer a specific path turns "compiling" into "not started".
       */
      port: 3000,
      reuseExistingServer: process.env.E2E_REUSE_EXISTING === "1",
      /*
       * 180s, not 60s. With no warm `.next` (a clean clone, or after the
       * directory was moved aside because the sandbox blocks the bulk delete
       * `next dev` does on start-up), the first compile of every route on this
       * machine takes well over a minute. The old 60s limit turned "cold cache"
       * into "the suite cannot start".
       */
      timeout: 180_000
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
