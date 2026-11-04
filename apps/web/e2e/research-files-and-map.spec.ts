import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * The two browser verifications that were still outstanding:
 *
 *  - the evidence map (Prompt 6) had never been exercised end to end, so this
 *    checks it renders the *recorded* relations, filters them, and keeps saying
 *    on screen that a line is not a proof;
 *  - the local file import (Prompt 7) had never been driven through a real
 *    browser, so this uploads a text file, reads it back, and confirms an
 *    excerpt only becomes **unverified** evidence.
 *
 * Screenshots go to `artifacts/playwright-p7`, deliberately separate from the
 * `artifacts/playwright` directory the arena spec writes to.
 */
const claimStatement = "该产品在华南区的复购率高于华北区。";
const excerpt = "华南区复购率为 31%。";

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function createResearch(page: Page): Promise<string> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-map-${randomUUID()}` },
    data: {
      project: {
        name: "Map and files e2e",
        summary: "Browser verification of the map and file import",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: "华南区复购率是否高于华北区？"
    }
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return id;
}

async function seedClaim(page: Page, sessionId: string): Promise<string> {
  const claim = await page.context().request.post(
    `/api/sessions/${sessionId}/claims`,
    {
      headers: { "idempotency-key": `e2e-map-claim-${randomUUID()}` },
      data: {
        statement: claimStatement,
        type: "fact",
        stance: "support",
        importance: 3
      }
    }
  );
  expect(claim.status()).toBe(201);
  const { claim: body } = (await claim.json()) as { claim: { id: string } };
  return body.id;
}

async function seedClaimAndEvidence(
  page: Page,
  sessionId: string
): Promise<void> {
  const claimId = await seedClaim(page, sessionId);

  const evidence = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence`,
    {
      headers: { "idempotency-key": `e2e-map-evidence-${randomUUID()}` },
      data: {
        kind: "external_reference",
        title: "区域复购年报",
        content: excerpt,
        description: "年报中的原句。",
        sourceRef: "https://example.org/repurchase-2025",
        direction: "supports",
        reliability: 0.5,
        claimIds: [claimId]
      }
    }
  );
  expect(evidence.status()).toBe(201);
}

/** Writes a viewport screenshot next to the run, never over arena artifacts. */
async function capture(
  page: Page,
  projectName: string,
  name: string
): Promise<void> {
  const directory = resolve(process.cwd(), "../../artifacts/playwright-p7");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${projectName}-${name}.png`),
    fullPage: false
  });
}

test("evidence map shows the recorded relations and keeps them distinct from proof", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const sessionId = await createResearch(page);
  await seedClaimAndEvidence(page, sessionId);

  await page.goto(`/research/${sessionId}`);
  await page.getByRole("tab", { name: "证据地图" }).click();

  const canvas = page.getByTestId("evidence-map-canvas");
  await expect(canvas).toBeVisible();
  /*
   * React Flow keeps a node `visibility: hidden` until its ResizeObserver has
   * measured it, and reports nothing at all when the observer never fires — so
   * a node can stay hidden indefinitely rather than briefly. Waiting for "some
   * node has a box" is not the same condition: an unmeasured node is still laid
   * out, so its box exists from the first paint and that wait returns while the
   * node we care about is still hidden.
   *
   * The panel publishes the library's own readiness signal instead, so this
   * waits for "every node has been measured" — the condition the test is
   * actually about — rather than betting a timeout against a race.
   */
  await expect(canvas).toHaveAttribute("data-nodes-ready", "true", {
    timeout: 20_000
  });
  await expect(page.getByText(claimStatement)).toBeVisible();
  await expect(page.getByText("区域复购年报")).toBeVisible();

  // The map must not present itself as a verdict.
  await expect(
    page.getByText(/不代表已证实；结论以\s*Verdict 与人工审核为准/)
  ).toBeVisible();

  await page.getByTestId("evidence-map-filters").getByText("只看未核实证据").click();
  await expect(canvas).toBeVisible();

  await page.getByText("区域复购年报").first().click();
  const detail = page.getByTestId("evidence-map-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("待核实");

  await capture(page, testInfo.project.name, "evidence-map");
});

test("an imported file is read back and its excerpt becomes unverified evidence", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const sessionId = await createResearch(page);
  // A citation has to point at a claim, so the reader can only be exercised
  // with one in the session.
  await seedClaim(page, sessionId);

  await page.goto(`/research/${sessionId}`);
  await page.getByRole("tab", { name: "文件导入" }).click();
  await expect(page.getByTestId("file-import-panel")).toBeVisible();

  const body = "华南区复购率为 31%。\n\n华北区复购率为 24%。\n";
  await page.getByTestId("file-input").setInputFiles({
    name: "repurchase.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(body, "utf8")
  });

  const list = page.getByTestId("file-list");
  await expect(list).toContainText("repurchase.txt");
  await expect(list).toContainText("已读取原文");
  await capture(page, testInfo.project.name, "file-import");

  // --- reader ---
  await list.getByRole("button", { name: "打开阅读" }).click();
  const reader = page.getByTestId("file-reader");
  await expect(reader).toBeVisible();
  await expect(page.getByTestId("file-content")).toContainText(
    "华南区复购率为 31%。"
  );

  // --- excerpt -> evidence ---
  await page.getByLabel("原文摘录（必须是原文中的连续文字）").fill(excerpt);
  await page.getByLabel("引用标题（可选）").fill("区域复购年报摘录");
  await page.getByLabel("关联主张").selectOption({ label: claimStatement });
  await page.getByLabel("可靠度 0–1").fill("0.5");
  await page.getByRole("button", { name: "定位并确认引用" }).click();

  const result = page.getByTestId("file-excerpt-result");
  await expect(result).toBeVisible();
  // A reader can register a citation; it can never declare it checked.
  await expect(result).toContainText("待核实");
  await capture(page, testInfo.project.name, "file-reader");
});
