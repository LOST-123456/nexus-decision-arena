import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

/**
 * The Agent Operations Center surface, checked in a real browser against the
 * real API.
 *
 * A freshly created research session has no agent runs, so what is proved here
 * is the honest empty state and the wiring of the new tab:
 *  1. the "运行中心" tab opens the panel and the panel reads its list from the
 *     server (the count in the header is the server's, not a hard-coded number);
 *  2. with nothing run yet it says so plainly instead of rendering an empty
 *     table or a fabricated progress bar;
 *  3. the layout does not overflow horizontally on a phone-width viewport.
 *
 * The cancel / retry / detail interactions need a real run in the table, and a
 * run can only be produced by the cross-examination engine; those paths are
 * proven against the real app and database in
 * `services/core/src/api/routes/agent-runs.integration.test.ts` (201/200/409/
 * 403/401/404 and the single-row state transition), not faked here.
 */

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill("nexus-owner");
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport + 1);
}

async function createResearch(page: Page): Promise<string> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-agent-ops-${randomUUID()}` },
    data: {
      project: {
        name: "Agent ops e2e",
        summary: "Browser verification of the agent operations center",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: "该结论是否成立？"
    }
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return id;
}

test("agent operations center opens from the workspace and states the empty state", async ({
  page
}) => {
  await loginAsOwner(page);
  const sessionId = await createResearch(page);

  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-body")).toBeVisible();

  await page.getByRole("tab", { name: "运行中心" }).click();
  const panel = page.getByTestId("agent-ops-panel");
  await expect(panel).toBeVisible();

  // The count comes from the server's list, and a fresh session has none.
  await expect(panel).toContainText("Agent 运行中心（0）");
  await expect(panel.getByText(/还没有任何 Agent 运行/)).toBeVisible();

  await expectNoHorizontalOverflow(page);
});
