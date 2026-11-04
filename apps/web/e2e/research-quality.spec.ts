import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * Research quality, checked in a real browser against a real backend.
 *
 * The promise under test: the assessment is a read-only diagnostic over the
 * session's own material — it shows what the rules could and could not
 * compute, it never invents a number, and every button it offers leads to a
 * surface that already exists. Nothing on this page writes: the claims, the
 * excerpt and the verification below are seeded through the real API, and the
 * panel only reads them back.
 *
 * Everything is seeded through the real HTTP API and driven through the real
 * UI controls. No fixture stubs the assessment, and the only shortcut taken is
 * the one that keeps the suite offline: the excerpt is typed in rather than
 * fetched from the internet.
 */

const claimStatement = "该公司上一季度出货量同比增长 12%。";
const uncoveredStatement = "单一采购记录即可证明全部增长。";
const excerpt = "第四季度出货量同比增长 12%。";

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

type Seeded = { sessionId: string; claimId: string; evidenceId: string };

/** A session with one covered claim and one important uncovered claim. */
async function seedMaterial(page: Page): Promise<Seeded> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-quality-session-${randomUUID()}` },
    data: {
      project: {
        name: "Research quality e2e",
        summary: "Explainable quality assessment",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: "该公司上一季度出货量是否同比增长？"
    }
  });
  expect(created.status()).toBe(201);
  const { id: sessionId } = (await created.json()) as { id: string };

  const claim = await page.context().request.post(
    `/api/sessions/${sessionId}/claims`,
    {
      headers: { "idempotency-key": `e2e-quality-claim-${randomUUID()}` },
      data: {
        statement: claimStatement,
        type: "fact",
        stance: "support",
        importance: 4
      }
    }
  );
  expect(claim.status()).toBe(201);
  const { claim: claimBody } = (await claim.json()) as { claim: { id: string } };

  // A second, important claim with nothing behind it: the kind of finding the
  // assessment exists to surface.
  const uncovered = await page.context().request.post(
    `/api/sessions/${sessionId}/claims`,
    {
      headers: { "idempotency-key": `e2e-quality-claim-2-${randomUUID()}` },
      data: {
        statement: uncoveredStatement,
        type: "fact",
        stance: "support",
        importance: 5
      }
    }
  );
  expect(uncovered.status()).toBe(201);

  const evidence = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence`,
    {
      headers: { "idempotency-key": `e2e-quality-evidence-${randomUUID()}` },
      data: {
        kind: "external_reference",
        title: "Q4 出货量原文",
        content: excerpt,
        description: "统计年报中的原句。",
        sourceRef: "https://example.org/shipments-q4.pdf",
        direction: "supports",
        reliability: 0.8,
        claimIds: [claimBody.id]
      }
    }
  );
  expect(evidence.status()).toBe(201);
  const { evidence: evidenceBody } = (await evidence.json()) as {
    evidence: { id: string };
  };

  return {
    sessionId,
    claimId: claimBody.id,
    evidenceId: evidenceBody.id
  };
}

/** Verifies the excerpt the way a reviewer would: a real, attributed write. */
async function verifyEvidence(
  page: Page,
  sessionId: string,
  evidenceId: string
): Promise<void> {
  const response = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence/${evidenceId}/verification`,
    {
      headers: { "idempotency-key": `e2e-quality-verify-${randomUUID()}` },
      data: { status: "verified", verificationNote: "与年报第 14 页逐字核对一致。" }
    }
  );
  expect(response.status()).toBe(200);
}

/** Registers another source under the same publisher, for the concentration signal. */
async function addSource(
  page: Page,
  sessionId: string,
  title: string
): Promise<void> {
  const response = await page.context().request.post(
    `/api/sessions/${sessionId}/sources`,
    {
      headers: { "idempotency-key": `e2e-quality-source-${randomUUID()}` },
      data: { title, kind: "document", publisher: "示例统计局" }
    }
  );
  expect(response.status()).toBe(201);
}

async function openQualityPanel(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-tabs")).toBeVisible();
  await page.getByRole("tab", { name: "研究质量" }).click();
  await expect(page.getByTestId("research-quality")).toBeVisible();
}

test("assesses the session read-only, and every button leads somewhere real", async ({
  page
}) => {
  await loginAsOwner(page);
  const { sessionId, evidenceId } = await seedMaterial(page);
  await verifyEvidence(page, sessionId, evidenceId);
  // Two further sources from the same publisher: the concentration signal
  // the panel is meant to surface, and a navigation target that must exist.
  await addSource(page, sessionId, "2025 年年度出货汇总");
  await addSource(page, sessionId, "2025 年季度出货分表");
  await openQualityPanel(page, sessionId);

  // --- the overview says what it could and could not compute ----------------
  const overview = page.getByTestId("quality-overview");
  await expect(overview).toBeVisible();
  await expect(overview).toContainText("研究质量-v1");
  await expect(overview).toContainText("评估时间");
  // A 16-hex fingerprint of the material range, never a score invented from it.
  await expect(overview).toContainText(/[0-9a-f]{16}/);
  await expect(page.getByTestId("research-quality")).toContainText(
    "不是结论正确的概率"
  );

  // --- the six dimensions, each with its basis -------------------------------
  const dimensions = page.getByTestId("quality-dimensions").locator("li");
  await expect(dimensions).toHaveCount(6);
  // The excerpt is verified by a person, so this dimension has a number.
  const verification = page.getByTestId(
    "quality-dimension-verification_quality"
  );
  await expect(verification).not.toContainText("无法计算");
  // Three sources are registered and none is confirmed to share an origin, so
  // the independence dimension is computed from them rather than refused: it
  // shows how many registered pages counted as independent corroboration. A
  // same-publisher hint is surfaced separately (see below) and never lowers a
  // confirmed-independence score, because same publisher is not same origin.
  await expect(
    page.getByTestId("quality-dimension-score-source_independence")
  ).toHaveText("100 / 100");

  // --- the claim diagnostics -------------------------------------------------
  const claims = page.getByTestId("quality-claims").locator("li");
  await expect(claims).toHaveCount(2);
  await expect(claims.filter({ hasText: uncoveredStatement })).toContainText(
    "无法判断"
  );

  // --- the findings, narrowed by severity ------------------------------------
  await expect(page.getByTestId("quality-findings")).toContainText(
    "没有任何关联材料"
  );
  await page.getByTestId("quality-filter-critical").click();
  // The seeded material yields exactly two critical findings: the uncovered
  // claim's "no evidence at all" finding and the blocking gap behind it. The
  // filter narrows the eight unfiltered findings down to these two, and the
  // total shown stays the unfiltered one.
  await expect(
    page.getByTestId("quality-findings").locator("li")
  ).toHaveCount(2);
  // The total is still the unfiltered one.
  await expect(page.getByTestId("research-quality")).toContainText(/共 \d+ 条/);
  await page.getByTestId("quality-filter-all").click();
  await expect(
    page.getByTestId("quality-findings").locator("li").first()
  ).toBeVisible();

  // --- every action button opens a surface that exists ----------------------
  // The uncovered claim's finding goes to the review centre with that claim.
  await page
    .locator('[data-testid^="quality-action-missing_evidence:"]')
    .first()
    .click();
  await expect(page.getByRole("tab", { name: "审核中心" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  // The gap finding goes to the research plan.
  await page.getByRole("tab", { name: "研究质量" }).click();
  await page
    .locator('[data-testid^="quality-action-open_research_gap:"]')
    .first()
    .click();
  await expect(page.getByTestId("research-plan")).toBeVisible();

  // The publisher-concentration finding goes to the source-relations panel.
  await page.getByRole("tab", { name: "研究质量" }).click();
  await page
    .locator('[data-testid^="quality-action-publisher_concentration:"]')
    .first()
    .click();
  await expect(page.getByTestId("source-independence")).toBeVisible();

  // --- a refresh re-reads, and nothing was written ---------------------------
  await page.reload();
  await page.getByRole("tab", { name: "研究质量" }).click();
  await expect(page.getByTestId("research-quality")).toBeVisible();
  await expect(page.getByTestId("quality-overview")).toContainText(
    "研究质量-v1"
  );
  await expect(
    page.getByTestId("quality-dimensions").locator("li")
  ).toHaveCount(6);

  // The reads above cannot have changed the material: the excerpt is still
  // verified exactly once, by the person who verified it.
  const evidence = await page.context().request.get(
    `/api/sessions/${sessionId}/evidence`
  );
  expect(evidence.status()).toBe(200);
  const body = (await evidence.json()) as {
    evidence: Array<{ verificationStatus: string; verifiedBy: string | null }>;
  };
  const verified = body.evidence.filter(
    (item) => item.verificationStatus === "verified"
  );
  expect(verified).toHaveLength(1);
  expect(verified[0]!.verifiedBy).toBeTruthy();

  await expectNoHorizontalOverflow(page);
});

test("stays readable and honest on a phone-sized screen", async ({ page }) => {
  await loginAsOwner(page);
  const { sessionId } = await seedMaterial(page);
  await openQualityPanel(page, sessionId);

  // The same panel, the same contract, on a narrow viewport.
  await expect(page.getByTestId("quality-overview")).toBeVisible();
  await expect(page.getByTestId("quality-dimensions").locator("li")).toHaveCount(
    6
  );
  // The uncovered claim is diagnosed here too, with its severity spelled out
  // — 严重 is the shared taxonomy's word for critical, the same one the
  // report body uses, never a colour alone.
  await expect(page.getByTestId("quality-findings")).toContainText("严重");
  await expect(page.getByTestId("research-quality")).toContainText(
    "不是结论正确的概率"
  );

  // A finding's action still leads somewhere real on mobile.
  await page
    .locator('[data-testid^="quality-action-missing_evidence:"]')
    .first()
    .click();
  await expect(page.getByRole("tab", { name: "审核中心" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  await expectNoHorizontalOverflow(page);
});
