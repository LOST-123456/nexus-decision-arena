import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

/**
 * The multilingual reading surface, checked in a real browser against a real
 * backend.
 *
 * The promise under test: a stored English page is read next to an auxiliary
 * translation, the original always stays the anchor, and when no translation
 * provider is configured the panel says so instead of inventing a translation.
 * The citation registered along the way stays unverified — a reading aid never
 * turns into a verdict, and the excerpt is what a citation points at.
 *
 * Everything is seeded through the real HTTP API and driven through the real
 * UI controls. The one shortcut is the one that keeps the suite offline: the
 * page text arrives as an imported local file, never fetched from the
 * internet.
 */

// Enough English signal for the conservative heuristic detector to commit
// (it needs hint words like "the" / "and" / "that"; without them the honest
// answer is 无法确定, which is exactly what the unit tests pin down).
const fileText =
  "Costs rose by 12% in the third quarter, and the company said that it was the result of higher input costs.\n\nHeadcount stayed flat.\n";
const excerpt = "Costs rose by 12%";
const evidenceTitle = "成本变动记录";
const claimStatement = "该公司成本较上年同期上升。";

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill("nexus-owner");
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function createResearch(page: Page): Promise<string> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-ml-session-${randomUUID()}` },
    data: {
      project: {
        name: "Multilingual reading e2e",
        summary: "Original plus auxiliary translation, honestly labelled",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: "该公司成本是否较上年同期上升？"
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
      headers: { "idempotency-key": `e2e-ml-claim-${randomUUID()}` },
      data: {
        statement: claimStatement,
        type: "fact",
        stance: "support",
        importance: 4
      }
    }
  );
  expect(claim.status()).toBe(201);
  const { claim: body } = (await claim.json()) as { claim: { id: string } };
  return body.id;
}

/**
 * Imports a local text file through the real file route. The response is the
 * recorded row: the source the capture belongs to, never a guess about it.
 */
async function importFile(page: Page, sessionId: string): Promise<string> {
  const uploaded = await page.context().request.post(
    `/api/sessions/${sessionId}/files`,
    {
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("costs-2026.txt"),
        "idempotency-key": `e2e-ml-file-${randomUUID()}`
      },
      data: Buffer.from(fileText, "utf8")
    }
  );
  expect(uploaded.status()).toBe(201);
  const body = (await uploaded.json()) as {
    source: { id: string } | null;
    duplicated: boolean;
  };
  expect(body.duplicated).toBe(false);
  expect(body.source).not.toBeNull();
  return body.source!.id;
}

/** Registers a citation against the imported source so the reader can open. */
async function seedEvidence(
  page: Page,
  sessionId: string,
  sourceId: string,
  claimId: string
): Promise<string> {
  const evidence = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence`,
    {
      headers: { "idempotency-key": `e2e-ml-evidence-${randomUUID()}` },
      data: {
        kind: "external_reference",
        title: evidenceTitle,
        content: excerpt,
        description: "导入文件中的原句。",
        sourceId,
        direction: "supports",
        reliability: 0.6,
        claimIds: [claimId]
      }
    }
  );
  expect(evidence.status()).toBe(201);
  const body = (await evidence.json()) as { evidence: { id: string } };
  return body.evidence.id;
}

/** Opens the stored page the way a reviewer does: select, then read. */
async function openReader(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("evidence-table")).toBeVisible();
  await page.getByRole("button", { name: evidenceTitle }).click();
  await expect(page.getByTestId("source-detail")).toBeVisible();
  await page.getByRole("button", { name: "阅读保存的原文" }).click();
  await expect(page.getByTestId("source-reader")).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(metrics.document).toBeLessThanOrEqual(metrics.viewport + 1);
}

/** Writes a viewport screenshot next to the run, never over arena artifacts. */
async function capture(
  page: Page,
  projectName: string,
  name: string
): Promise<void> {
  const directory = resolve(process.cwd(), "../../artifacts/playwright-p12");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${projectName}-${name}.png`),
    fullPage: false
  });
}

test("reads the original next to an auxiliary translation, and never invents one", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const sessionId = await createResearch(page);
  const claimId = await seedClaim(page, sessionId);
  const sourceId = await importFile(page, sessionId);
  await seedEvidence(page, sessionId, sourceId, claimId);

  await openReader(page, sessionId);

  // --- the original is shown, and stays the anchor --------------------------
  await expect(page.getByTestId("snapshot-content")).toContainText(
    "Costs rose by 12%"
  );

  // --- the reading aid is mounted, and labelled as an aid -------------------
  const panel = page.getByTestId("multilingual-panel");
  await expect(panel).toBeVisible();
  // The reader says out loud that a translation is an aid, never a substitute.
  await expect(page.getByTestId("source-reader")).toContainText(
    "译文仅供辅助理解"
  );
  // The stored capture is English, and the detection says so — a heuristic
  // result, never a claim about the page's trustworthiness.
  await expect(page.getByTestId("ml-detection")).toContainText("英语");
  await expect(page.getByTestId("ml-original")).toContainText(
    "Costs rose by 12%"
  );
  // Nothing has been translated yet, and nothing is fabricated to fill the gap.
  await expect(page.getByTestId("ml-translation")).toContainText("尚未翻译");

  // --- no provider is configured: the panel says so -------------------------
  // This build has no translation credentials, so the honest outcome is the
  // controlled "unavailable" state — not a machine translation dressed up as
  // one, and not a crash.
  await page.getByTestId("ml-translate").click();
  await expect(page.getByTestId("ml-unavailable")).toBeVisible();
  await expect(page.getByTestId("ml-unavailable")).toContainText(
    "翻译服务暂不可用"
  );
  await expect(page.getByTestId("ml-unavailable")).toContainText(
    "原文阅读不受影响"
  );
  await expect(page.getByTestId("ml-translation")).toContainText("尚未翻译");
  await expect(page.getByTestId("ml-original")).toContainText(
    "Costs rose by 12%"
  );

  // --- a glossary entry is a human declaration, stored per session ----------
  await page.getByLabel("原文术语").fill("Headcount");
  await page.getByLabel("确认译法").fill("员工人数");
  await page.getByRole("button", { name: "添加术语" }).click();
  await expect(page.getByTestId("ml-terminology")).toContainText("Headcount");
  await expect(page.getByTestId("ml-terminology")).toContainText("员工人数");
  const glossary = await page.context().request.get(
    `/api/sessions/${sessionId}/terminology`
  );
  expect(glossary.status()).toBe(200);
  const glossaryBody = (await glossary.json()) as {
    entries: Array<{ sourceTerm: string; confirmedTranslation: string | null }>;
  };
  expect(
    glossaryBody.entries.some(
      (entry) =>
        entry.sourceTerm === "Headcount" &&
        entry.confirmedTranslation === "员工人数"
    )
  ).toBe(true);

  // --- the citation is still unverified: reading never verifies -------------
  const evidence = await page.context().request.get(
    `/api/sessions/${sessionId}/evidence`
  );
  expect(evidence.status()).toBe(200);
  const evidenceBody = (await evidence.json()) as {
    evidence: Array<{ title: string; verificationStatus: string }>;
  };
  const registered = evidenceBody.evidence.find(
    (item) => item.title === evidenceTitle
  );
  expect(registered).toBeDefined();
  expect(registered!.verificationStatus).toBe("unverified");

  await capture(page, testInfo.project.name, "multilingual-reader");
  await expectNoHorizontalOverflow(page);
});

test("stays readable on a phone-sized screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsOwner(page);
  const sessionId = await createResearch(page);
  const claimId = await seedClaim(page, sessionId);
  const sourceId = await importFile(page, sessionId);
  await seedEvidence(page, sessionId, sourceId, claimId);

  await openReader(page, sessionId);

  // The same panel, the same contract, on a narrow viewport: the original
  // first, the aid labelled, and no fabricated translation.
  await expect(page.getByTestId("multilingual-panel")).toBeVisible();
  await expect(page.getByTestId("ml-original")).toContainText(
    "Costs rose by 12%"
  );
  await expect(page.getByTestId("ml-translation")).toContainText("尚未翻译");
  await expect(page.getByTestId("ml-detection")).toContainText("英语");
  await expect(page.getByTestId("source-reader")).toContainText(
    "译文仅供辅助理解"
  );

  await capture(page, testInfo.project.name, "multilingual-reader-mobile");
  await expectNoHorizontalOverflow(page);
});
