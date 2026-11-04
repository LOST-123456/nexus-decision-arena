import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * The Agent Operations Center surface, checked in a real browser against the
 * real API.
 *
 * What is proved here:
 *  1. the "运行中心" tab opens the panel and the panel reads its list from the
 *     server (the count in the header is the server's, not a hard-coded number);
 *  2. with nothing run yet it says so plainly instead of rendering an empty
 *     table or a fabricated progress bar;
 *  3. after a real cross-examination, the run the engine recorded is shown as
 *     finished, and the cancel control is *off* with the real reason — the
 *     panel never offers a stop it cannot deliver, and never claims one;
 *  4. at 390px the same surface stays readable without horizontal overflow, and
 *     the reason a control is unavailable is visible text rather than a hover
 *     tooltip.
 *
 * What is deliberately not done here: cancelling a *live* run from the browser.
 * A cross-review run is created and settled inside one request, so by the time
 * any browser can click, the row is already terminal — a "running" row could
 * only be produced by fabricating one, and this suite refuses to fake state.
 * The cancel request itself (200 / 409 / 403 / 401 / 404, the single-row
 * transition, and the fact that a cancelled run can no longer be completed) is
 * proven against the real app and database in
 * `services/core/src/api/routes/agent-runs.integration.test.ts`, and the three
 * UI states (requesting / executed-not-confirmed / stopped) in
 * `apps/web/features/research/agent-ops.test.tsx`.
 */

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
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

type SeededSession = { sessionId: string; claimId: string };

/**
 * Creates a session, starts the real orchestration, waits for a claim, then
 * runs a real cross-review so `agent_runs` holds a genuine record. Nothing is
 * stubbed on the client; every number the panel shows comes from the server.
 */
async function seedSessionWithCrossReview(
  page: Page,
  researchQuestion: string
): Promise<SeededSession> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-agent-ops-create-${randomUUID()}` },
    data: {
      project: {
        name: "Agent ops cancellation e2e",
        summary: "Cancellation surface of the agent operations center",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion
    }
  });
  expect(created.status()).toBe(201);
  const { id: sessionId } = (await created.json()) as { id: string };

  const started = await page.context().request.post(
    `/api/sessions/${sessionId}/start`,
    {
      headers: { "idempotency-key": `e2e-agent-ops-start-${randomUUID()}` },
      data: {}
    }
  );
  expect(started.status()).toBe(202);

  let claimId: string | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const view = await page.context().request.get(
      `/api/sessions/${sessionId}/research`
    );
    if (view.ok()) {
      const body = (await view.json()) as { claims: Array<{ id: string }> };
      if (body.claims.length > 0) {
        claimId = body.claims[0]!.id;
        break;
      }
    }
    await page.waitForTimeout(1000);
  }
  if (!claimId) throw new Error("the orchestration run produced no claims in time");

  const review = await page.context().request.post(
    `/api/sessions/${sessionId}/claims/${claimId}/cross-review`,
    {
      headers: { "idempotency-key": `e2e-agent-ops-review-${randomUUID()}` },
      data: {}
    }
  );
  expect(review.status()).toBe(201);

  return { sessionId, claimId };
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

test("a finished run cannot be cancelled, and the panel says why instead of pretending", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const { sessionId } = await seedSessionWithCrossReview(
    page,
    "该方案在 12 个月内覆盖 80 间实验室是否可行？"
  );

  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-body")).toBeVisible();
  await page.getByRole("tab", { name: "运行中心" }).click();

  const panel = page.getByTestId("agent-ops-panel");
  await expect(panel).toBeVisible();
  const row = page.getByTestId("agent-run-row").first();
  await expect(row).toBeVisible();
  // The engine really recorded this run; the panel is not inventing one.
  await expect(row).toContainText("交叉审查");

  await row.getByRole("button", { name: "详情" }).click();
  const cancel = page.getByTestId("agent-run-cancel");
  await expect(cancel).toBeVisible();
  await expect(cancel).toBeDisabled();
  // The reason is real content, not a `title` tooltip.
  const reason = page.getByTestId("agent-run-cancel-reason");
  await expect(reason).toBeVisible();
  await expect(reason).toContainText("该运行已结束，无法取消");

  // No cancellation state is claimed for a run that was never cancelled.
  await expect(page.getByTestId("agent-run-cancel-state")).toHaveCount(0);
  // And the timeline is the one the executor wrote.
  await expect(page.getByTestId("agent-run-events")).toContainText(
    "AGENT_RUN_STARTED"
  );

  await expectNoHorizontalOverflow(page);
});

test("narrow viewport keeps the agent operations center readable and honest", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsOwner(page);
  const { sessionId } = await seedSessionWithCrossReview(
    page,
    "该方案在 12 个月内覆盖 80 间实验室是否可行？"
  );

  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-body")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("tab", { name: "运行中心" }).click();
  const panel = page.getByTestId("agent-ops-panel");
  await expect(panel).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const row = page.getByTestId("agent-run-row").first();
  await row.getByRole("button", { name: "详情" }).click();

  const cancel = page.getByTestId("agent-run-cancel");
  await expect(cancel).toBeVisible();
  await expect(cancel).toBeDisabled();
  // A 24px minimum target, per the platform's touch rule.
  const box = await cancel.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);

  // On a phone the disabled reason cannot live in a tooltip, so it is text.
  await expect(page.getByTestId("agent-run-cancel-reason")).toContainText(
    "无法取消"
  );
  await expect(page.getByTestId("agent-run-cancel-state")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});
