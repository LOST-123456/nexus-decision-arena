import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const conflictSummary = "建议立项与暂缓规模化扩张存在冲突";
const decisionExplanation =
  "先在 3 间实验室验证 12 个月，设置阶段验收门槛，验证通过后再讨论扩张。";

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));

  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);
}

async function expectNoRegionOverlap(page: Page): Promise<void> {
  const selectors = [
    '[data-testid="workspace-header"]',
    '[data-testid="agent-panel"]',
    '[data-testid="decision-region"]',
    '[data-testid="inspector-column"]',
    '[data-testid="timeline"]'
  ];
  const boxes = [];

  for (const selector of selectors) {
    const box = await page.locator(selector).boundingBox();
    expect(box, `${selector} must be visible`).not.toBeNull();
    if (box) {
      boxes.push({ selector, ...box });
    }
  }

  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < boxes.length;
      rightIndex += 1
    ) {
      const left = boxes[leftIndex]!;
      const right = boxes[rightIndex]!;
      const overlapWidth = Math.max(
        0,
        Math.min(left.x + left.width, right.x + right.width) -
          Math.max(left.x, right.x)
      );
      const overlapHeight = Math.max(
        0,
        Math.min(left.y + left.height, right.y + right.height) -
          Math.max(left.y, right.y)
      );

      expect(
        overlapWidth * overlapHeight,
        `${left.selector} overlaps ${right.selector}`
      ).toBeLessThanOrEqual(1);
    }
  }
}

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill("nexus-owner");
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function captureViewport(
  page: Page,
  projectName: string,
  name: string,
  repeatIndex: number
): Promise<void> {
  const outputDirectory = resolve(
    process.cwd(),
    "../../artifacts/playwright"
  );
  await mkdir(outputDirectory, { recursive: true });
  const repeatSuffix =
    repeatIndex > 0 ? `-repeat-${String(repeatIndex + 1).padStart(2, "0")}` : "";
  await page.screenshot({
    path: resolve(outputDirectory, `${projectName}-${name}${repeatSuffix}.png`),
    fullPage: false
  });
}

test("fixed demo reaches a limited-pilot decision", async ({
  page
}, testInfo) => {
  await page.goto("/sessions/demo");

  await expect(page.getByTestId("demo-fixture")).toHaveAttribute(
    "data-demo-fixture",
    "true"
  );
  await expect(page.getByTestId("initial-conclusion")).toHaveText(
    "建议立项"
  );
  await expect(page.getByTestId("challenge-status")).toHaveText(
    "待人工裁决"
  );
  await expect(page.getByTestId("demo-fixture")).toHaveAttribute(
    "data-opposing-claim-count",
    "3"
  );
  await expect(page.getByTestId("demo-fixture")).toHaveAttribute(
    "data-challenge-count",
    "5"
  );
  await expect(page.getByTestId("demo-fixture")).toHaveAttribute(
    "data-conflict-count",
    "3"
  );
  await expect(page.getByTestId("opposing-claim-count")).toHaveText("3");
  await expect(page.getByTestId("challenge-count")).toHaveText("5");
  await expect(page.getByTestId("conflict-count")).toHaveText("3");
  const visibleConflict = page.locator("h3:visible", { hasText: conflictSummary }).first();
  await expect(visibleConflict).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoRegionOverlap(page);
  await captureViewport(page, testInfo.project.name, "initial", testInfo.repeatEachIndex);

  await visibleConflict.scrollIntoViewIfNeeded();
  await captureViewport(page, testInfo.project.name, "conflict", testInfo.repeatEachIndex);

  await page.getByRole("button", { name: "采纳质询" }).click();

  await expect(page.getByTestId("final-conclusion")).toHaveText("有限立项");
  await expect(page.getByTestId("challenge-status")).toHaveText("已采纳");
  await expect(
    page.getByRole("heading", { name: "决策解释" })
  ).toBeVisible();
  await expect(page.getByTestId("decision-explanation")).toContainText(
    decisionExplanation
  );

  await page
    .getByRole("button", { name: /Sequence 20 HUMAN_REVIEW_REQUIRED/ })
    .click();
  await expect(page.getByTestId("initial-conclusion")).toHaveText("建议立项");
  await page
    .getByRole("button", { name: /Sequence 21 SESSION_STATE_CHANGED/ })
    .click();
  await expect(page.getByTestId("final-conclusion")).toHaveText("有限立项");
  await expect(page.getByTestId("challenge-status")).toHaveText("已采纳");
  await expectNoHorizontalOverflow(page);
  await expectNoRegionOverlap(page);

  await page
    .getByTestId("decision-explanation")
    .scrollIntoViewIfNeeded();
  await captureViewport(page, testInfo.project.name, "final", testInfo.repeatEachIndex);

  await page.getByRole("link", { name: /查看决策报告/ }).click();
  await expect(page).toHaveURL(/\/sessions\/demo\/report$/);
  await expect(page.locator("main[data-demo-fixture=\"true\"]")).toBeVisible();
  await expect(page.getByText("DEMO FIXTURE").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "有限立项" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "决策解释" })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureViewport(page, testInfo.project.name, "report", testInfo.repeatEachIndex);
});

test("live session streams into the workspace and produces a persisted report", async ({
  page
}, testInfo) => {
  await loginAsOwner(page);
  const createKey = `e2e-live-create-${randomUUID()}`;
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": createKey },
    data: {
      project: {
        name: "Live browser fixture",
        summary: "Browser orchestration verification",
        targetUsers: "Decision operators",
        businessModel: "Annual subscription",
        expectedData: "24 months"
      },
      locale: "zh-CN"
    }
  });
  expect(created.status()).toBe(201);
  const { id: sessionId } = (await created.json()) as { id: string };
  const started = await page.context().request.post(
    `/api/sessions/${sessionId}/start`,
    {
      headers: { "idempotency-key": `e2e-live-start-${randomUUID()}` },
      data: {}
    }
  );
  expect(started.status()).toBe(202);

  await page.goto(`/sessions/${sessionId}`);
  await expect(
    page.locator('main[data-session-source="live"]')
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "采纳质询" })).toBeVisible();
  await expect(page.getByTestId("timeline")).toContainText(
    "CHALLENGE_CREATED"
  );

  await page.getByRole("button", { name: "采纳质询" }).click();
  await expect(page.getByText("DECISION COMPLETE")).toBeVisible();
  await expect(page.getByText("有限立项").first()).toBeVisible();
  await page.getByRole("link", { name: /查看决策报告/ }).click();
  await expect(page.locator('main[data-report-source="live"]')).toBeVisible();
  await expect(page.getByRole("heading", { name: "有限立项" })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureViewport(page, testInfo.project.name, "live-report", testInfo.repeatEachIndex);

  const deleted = await page.context().request.delete(`/api/sessions/${sessionId}`);
  expect(deleted.status()).toBe(204);
});
