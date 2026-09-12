import { mkdir } from "node:fs/promises";
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

async function captureViewport(
  page: Page,
  projectName: string,
  name: string
): Promise<void> {
  const outputDirectory = resolve(
    process.cwd(),
    "../../artifacts/playwright"
  );
  await mkdir(outputDirectory, { recursive: true });
  await page.screenshot({
    path: resolve(outputDirectory, `${projectName}-${name}.png`),
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
  await expect(page.getByText(conflictSummary).first()).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await expectNoRegionOverlap(page);
  await captureViewport(page, testInfo.project.name, "initial");

  await page.getByText(conflictSummary).first().scrollIntoViewIfNeeded();
  await captureViewport(page, testInfo.project.name, "conflict");

  await page.getByRole("button", { name: "采纳质询" }).click();

  await expect(page.getByTestId("final-conclusion")).toHaveText("有限立项");
  await expect(page.getByTestId("challenge-status")).toHaveText("已采纳");
  await expect(
    page.getByRole("heading", { name: "决策解释" })
  ).toBeVisible();
  await expect(page.getByTestId("decision-explanation")).toContainText(
    decisionExplanation
  );
  await expectNoHorizontalOverflow(page);
  await expectNoRegionOverlap(page);

  await page
    .getByTestId("decision-explanation")
    .scrollIntoViewIfNeeded();
  await captureViewport(page, testInfo.project.name, "final");

  await page.getByRole("link", { name: /查看决策报告/ }).click();
  await expect(page).toHaveURL(/\/sessions\/demo\/report$/);
  await expect(page.getByRole("heading", { name: "有限立项" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "决策解释" })
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await captureViewport(page, testInfo.project.name, "report");
});