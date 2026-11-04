import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * Report versions, checked in a real browser against a real backend.
 *
 * The thing under test is the promise the feature makes: a saved version is a
 * document that was frozen once, and everything after it — reading it back,
 * comparing it, exporting it — uses that frozen copy and never the rows as
 * they look now.
 *
 * Everything is seeded through the real HTTP API and the real UI controls.
 * No fixture stubs the report, no page is preloaded with fake data, and the
 * only shortcuts taken are the ones that keep the suite offline: the excerpt
 * is typed in rather than fetched from the internet.
 */

const claimStatement = "该公司上一季度出货量同比增长 12%。";
const excerpt = "第四季度出货量同比增长 12%。<script>alert('xss')</script>";
const verificationNote = "与 PDF 第 14 页表格逐字核对一致。";

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

type Session = { sessionId: string; claimId: string; evidenceId: string };

/** A session with one claim and one unverified excerpt, made through the API. */
async function seedMaterial(page: Page): Promise<Session> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-snapshot-session-${randomUUID()}` },
    data: {
      project: {
        name: "Report snapshot e2e",
        summary: "Versioned fact-check reports",
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
      headers: { "idempotency-key": `e2e-snapshot-claim-${randomUUID()}` },
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

  const evidence = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence`,
    {
      headers: { "idempotency-key": `e2e-snapshot-evidence-${randomUUID()}` },
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

/** Verifies one excerpt the way a reviewer would: a real, attributed write. */
async function verifyEvidence(
  page: Page,
  sessionId: string,
  evidenceId: string
): Promise<void> {
  const response = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence/${evidenceId}/verification`,
    {
      headers: { "idempotency-key": `e2e-verify-${randomUUID()}` },
      data: { status: "verified", verificationNote }
    }
  );
  expect(response.status()).toBe(200);
}

/** Registers another source, so the next version cites something extra. */
async function addSource(page: Page, sessionId: string, title: string) {
  const response = await page.context().request.post(
    `/api/sessions/${sessionId}/sources`,
    {
      headers: { "idempotency-key": `e2e-source-${randomUUID()}` },
      data: { title, kind: "document", publisher: "示例统计局" }
    }
  );
  expect(response.status()).toBe(201);
}

/** Adds a second claim carrying the very same wording as the first one. */
async function addTwinClaim(page: Page, sessionId: string): Promise<string> {
  const response = await page.context().request.post(
    `/api/sessions/${sessionId}/claims`,
    {
      headers: { "idempotency-key": `e2e-twin-${randomUUID()}` },
      data: {
        statement: claimStatement,
        type: "fact",
        stance: "support",
        importance: 4
      }
    }
  );
  expect(response.status()).toBe(201);
  const { claim } = (await response.json()) as { claim: { id: string } };
  return claim.id;
}

type Snapshot = {
  snapshotId: string;
  version: number;
  createdBy: string;
  materialsFingerprint: string;
  snapshotHash: string;
};

async function saveSnapshot(
  page: Page,
  sessionId: string,
  options: { key?: string; changeReason?: string } = {}
): Promise<{ status: number; body: Snapshot | { error?: string } }> {
  const response = await page.context().request.post(
    `/api/sessions/${sessionId}/report-snapshots`,
    {
      headers: {
        "idempotency-key": options.key ?? `e2e-snapshot-${randomUUID()}`
      },
      data: options.changeReason ? { changeReason: options.changeReason } : {}
    }
  );
  return {
    status: response.status(),
    body: (await response.json()) as Snapshot
  };
}

async function openHistory(page: Page, sessionId: string): Promise<void> {
  await page.goto(`/research/${sessionId}/report`);
  await expect(page.getByTestId("fact-check-report")).toBeVisible();
  await page.getByRole("tab", { name: "历史版本" }).click();
  await expect(page.getByTestId("report-versions")).toBeVisible();
}

function versionItem(page: Page, version: number) {
  return page.locator(
    `[data-testid="report-snapshot-item"][data-version="${version}"]`
  );
}

test("saves versions, keeps the first one frozen, and exports it unchanged", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const { sessionId, evidenceId } = await seedMaterial(page);
  await openHistory(page, sessionId);

  // --- v1: nothing has been verified yet ----------------------------------
  await page.getByTestId("save-report-snapshot").click();
  await expect(versionItem(page, 1)).toBeVisible();
  await expect(page.getByTestId("report-snapshot-saved")).toContainText("第 1 版");

  const firstFingerprint = await page
    .locator(`[data-testid="report-snapshot-item"][data-version="1"]`)
    .innerText();
  expect(firstFingerprint).toContain("与当前资料一致");

  // --- the material moves on ----------------------------------------------
  await verifyEvidence(page, sessionId, evidenceId);
  await addSource(page, sessionId, "2025 年年度出货汇总");
  const twinClaimId = await addTwinClaim(page, sessionId);

  await page.getByRole("tab", { name: "历史版本" }).click();
  await page.getByRole("button", { name: "刷新列表" }).click();
  await expect(versionItem(page, 1)).toContainText("与当前资料已不同");

  // --- v2 ------------------------------------------------------------------
  await page.getByTestId("save-report-snapshot").click();
  await expect(versionItem(page, 2)).toBeVisible();
  await expect(versionItem(page, 2)).toContainText("第 2 版");
  await expect(versionItem(page, 1)).toBeVisible();

  // --- comparison is by id, not by resemblance -----------------------------
  await page.getByRole("tab", { name: "版本比较" }).click();
  await expect(page.getByTestId("report-compare-run")).toBeVisible();
  await page.getByTestId("report-compare-run").click();
  const diff = page.getByTestId("report-diff");
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("第 1 版 → 第 2 版");

  // The verified excerpt is a conclusion change; the new source is a currency
  // one. They are listed apart and the second says it is not the first.
  const verdictEntries = page.locator(
    '[data-testid="report-diff-entry"][data-category="verdict"]'
  );
  const riskEntries = page.locator(
    '[data-testid="report-diff-entry"][data-category="risk"]'
  );
  expect(await verdictEntries.count()).toBeGreaterThan(0);
  expect(await riskEntries.count()).toBeGreaterThan(0);
  await expect(diff).toContainText("不代表结论被推翻");

  const evidenceChange = page.locator(
    '[data-testid="report-diff-entry"][data-entity-type="evidence"][data-kind="changed"]'
  );
  await expect(evidenceChange.first()).toContainText("unverified");
  await expect(evidenceChange.first()).toContainText("verified");

  // An identically worded claim is a new row, not a revision of the old one.
  const addedClaims = page.locator(
    '[data-testid="report-diff-entry"][data-entity-type="claim"][data-kind="added"]'
  );
  expect(await addedClaims.count()).toBeGreaterThan(0);
  await expect(addedClaims.first()).toContainText(twinClaimId.slice(0, 8));

  // --- a repeated request is the same request ------------------------------
  const replayKey = `e2e-idempotent-${randomUUID()}`;
  const firstAttempt = await saveSnapshot(page, sessionId, { key: replayKey });
  const secondAttempt = await saveSnapshot(page, sessionId, { key: replayKey });
  expect(firstAttempt.status).toBe(201);
  expect(secondAttempt.status).toBe(201);
  expect((firstAttempt.body as Snapshot).snapshotId).toBe(
    (secondAttempt.body as Snapshot).snapshotId
  );
  // Three saves so far: v1, v2 and the replayed one. A fourth would mean the
  // idempotency key was ignored.
  await page.getByRole("tab", { name: "历史版本" }).click();
  await page.getByRole("button", { name: "刷新列表" }).click();
  await expect(page.getByTestId("report-snapshot-item")).toHaveCount(3);
  await expect(
    page.locator('[data-testid="report-snapshot-item"][data-version="4"]')
  ).toHaveCount(0);

  // --- reading v1 back shows v1, not today ---------------------------------
  await page.getByRole("tab", { name: "历史版本" }).click();
  await versionItem(page, 1)
    .getByTestId("report-snapshot-open")
    .click();
  const detail = page.getByTestId("report-snapshot-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("这是保存时的快照");
  // v1 was frozen before the excerpt was verified.
  await expect(detail).toContainText("已核实 0");
  await expect(detail).toContainText("待核实 1");
  await expect(detail).not.toContainText(verificationNote);

  // The live report, by contrast, does show the verification.
  await page.getByRole("tab", { name: "当前报告" }).click();
  await expect(page.getByTestId("fact-check-report")).toContainText("已核实 1");

  // --- a reload re-reads stored versions -----------------------------------
  await page.reload();
  await page.getByRole("tab", { name: "历史版本" }).click();
  await expect(page.getByTestId("report-snapshot-item")).toHaveCount(3);
  await expect(versionItem(page, 1)).toBeVisible();
  await expect(versionItem(page, 2)).toBeVisible();

  // --- exports are of the version, not of the session ----------------------
  const markdownHref = await versionItem(page, 1)
    .getByTestId("report-snapshot-export-markdown")
    .getAttribute("href");
  expect(markdownHref).toContain("format=markdown");
  const markdown = await page.context().request.get(markdownHref!);
  expect(markdown.status()).toBe(200);
  const markdownBody = await markdown.text();
  expect(markdownBody).toContain("历史版本导出");
  expect(markdownBody).toContain("版本：v1");
  expect(markdownBody).toContain(claimStatement);
  expect(markdownBody).toContain("本导出内容来自该版本的不可变快照");
  // The frozen copy still says the excerpt was unverified.
  expect(markdownBody).toContain("待核实材料：1 条；已核实：0 条");
  expect(markdownBody).not.toContain(verificationNote);

  const htmlHref = await versionItem(page, 1)
    .getByTestId("report-snapshot-export-html")
    .getAttribute("href");
  expect(htmlHref).toContain("format=html");
  const html = await page.context().request.get(htmlHref!);
  expect(html.status()).toBe(200);
  const htmlBody = await html.text();
  expect(htmlBody).toContain("版本 v1");
  expect(htmlBody).toContain("本导出内容来自该版本的不可变快照");
  // The excerpt carries a script tag: the document must quote it, never run it.
  expect(htmlBody).toContain("&lt;script&gt;");
  expect(htmlBody).not.toContain("<script");

  await expectNoHorizontalOverflow(page);
});

test("a viewer can read saved versions but cannot create one", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const { sessionId } = await seedMaterial(page);

  const first = await saveSnapshot(page, sessionId);
  expect(first.status).toBe(201);

  // A viewer account, created through the real user API rather than assumed.
  const viewerName = `viewer-${randomUUID().slice(0, 8)}`;
  const viewerPassword = "viewer-only-1";
  const created = await page.context().request.post("/api/auth/users", {
    data: {
      username: viewerName,
      displayName: "E2E Viewer",
      role: "viewer",
      password: viewerPassword
    }
  });
  expect(created.status()).toBe(201);
  const viewerId = ((await created.json()) as { id: string }).id;

  // Reading someone else's research needs an explicit grant now. The global
  // `viewer` role narrows what an account may *write*; it does not widen what
  // it may *read*. Without this the account is answered 404 for every id, and
  // "read saved versions" would be asserting a permission nobody granted.
  const granted = await page.context().request.post("/api/library/grants", {
    headers: { "idempotency-key": `grant-${randomUUID()}` },
    data: { sessionId, subjectType: "user", subjectId: viewerId, scope: "read" }
  });
  expect(granted.status()).toBe(201);

  const login = await page.context().request.post("/api/auth/login", {
    data: { username: viewerName, password: viewerPassword }
  });
  expect(login.status()).toBe(200);

  await openHistory(page, sessionId);
  // Reading stays available; saving is not offered at all.
  await expect(page.getByTestId("report-snapshot-item")).toHaveCount(1);
  await expect(page.getByTestId("report-snapshot-viewer-note")).toContainText(
    "保存新版本需要 Reviewer 或 Owner 账户"
  );
  await expect(page.getByTestId("save-report-snapshot")).toHaveCount(0);
  await expect(page.getByTestId("report-snapshot-export-markdown")).toHaveCount(1);
  await expect(page.getByTestId("report-snapshot-export-html")).toHaveCount(1);

  // The server refuses the write regardless of what the UI offers.
  const refused = await saveSnapshot(page, sessionId);
  expect(refused.status).toBe(403);

  await expectNoHorizontalOverflow(page);
});

test("narrow viewport reaches history and comparison without overflow", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsOwner(page);
  const { sessionId, evidenceId } = await seedMaterial(page);

  const first = await saveSnapshot(page, sessionId);
  expect(first.status).toBe(201);
  await verifyEvidence(page, sessionId, evidenceId);
  const second = await saveSnapshot(page, sessionId);
  expect(second.status).toBe(201);

  await page.goto(`/research/${sessionId}/report`);
  await expect(page.getByTestId("report-view-tabs")).toBeVisible();

  await page.getByRole("tab", { name: "历史版本" }).click();
  await expect(page.getByTestId("report-snapshot-item")).toHaveCount(2);
  await expectNoHorizontalOverflow(page);

  await page.getByRole("tab", { name: "版本比较" }).click();
  await expect(page.getByTestId("report-compare-run")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByTestId("report-compare-run").click();
  await expect(page.getByTestId("report-diff")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
