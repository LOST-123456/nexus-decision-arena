import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

const rationale = "已对照系统内登记的原始材料逐条核对，认可当前推导结论。";

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

type SeededSession = { sessionId: string; claimId: string; claimStatement: string };

/**
 * Creates a session, starts the real orchestration and waits until the run has
 * produced claims. Everything the browser then does goes through the same
 * persisted records — nothing is stubbed on the client.
 */
async function seedSessionWithClaims(
  page: Page,
  researchQuestion: string
): Promise<SeededSession> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-review-create-${randomUUID()}` },
    data: {
      project: {
        name: "Research review e2e",
        summary: "Cross-examination, human review and the fact-check report",
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
      headers: { "idempotency-key": `e2e-review-start-${randomUUID()}` },
      data: {}
    }
  );
  expect(started.status()).toBe(202);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const view = await page.context().request.get(
      `/api/sessions/${sessionId}/research`
    );
    if (view.ok()) {
      const body = (await view.json()) as {
        claims: Array<{ id: string; statement: string; roleId: string | null }>;
      };
      if (body.claims.length > 0) {
        const claim = body.claims[0]!;
        return { sessionId, claimId: claim.id, claimStatement: claim.statement };
      }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error("the orchestration run produced no claims in time");
}

/**
 * Selects the claim by its persisted id. The mock orchestration can emit
 * several claims with an identical statement, so matching on text alone would
 * be ambiguous and could review a different claim than the one asserted later.
 */
async function selectClaim(page: Page, claimId: string): Promise<void> {
  await page
    .getByTestId("claim-list")
    .locator(`[data-claim-id="${claimId}"]`)
    .click();
}

/** The report renders one finding per claim; scope by id for the same reason. */
function reportFinding(page: Page, claimId: string) {
  return page.locator(`[data-testid="report-finding"][data-claim-id="${claimId}"]`);
}

test("cross-examination, human review and the fact-check report share one persisted chain", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const { sessionId, claimId, claimStatement } = await seedSessionWithClaims(
    page,
    "该方案在 24 个月内覆盖 200 间实验室是否可行？"
  );

  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-body")).toBeVisible();
  await selectClaim(page, claimId);

  // --- cross-examination runs real agent work and records it ---------------
  await page.getByRole("tab", { name: "交叉审查" }).click();
  await expect(page.getByTestId("cross-review-panel")).toBeVisible();
  await page.getByRole("button", { name: "发起交叉审查" }).click();

  const result = page.getByTestId("cross-review-result");
  await expect(result).toBeVisible();
  await expect(result).toContainText("运行");
  // A run either completes or reports a reason; it never pretends to succeed.
  await expect(page.getByTestId("cross-review-runs")).toBeVisible();
  await expect(page.getByTestId("cross-review-runs")).toContainText("交叉审查");
  await expect(page.getByTestId("challenge-list").locator("li").first()).toBeVisible();
  await expect(page.getByTestId("cross-review-panel")).toContainText(
    "未登记为证据"
  );

  // --- the review center shows the same persisted material -----------------
  await page.getByRole("tab", { name: "审核中心" }).click();
  const center = page.getByTestId("review-center");
  await expect(center).toBeVisible();
  await expect(center).toContainText(claimStatement);
  await expect(center).toContainText("当前核查结论");
  // Evidence is split by direction, and an empty side says so instead of
  // disappearing — a missing list must never read as "there was no evidence".
  await expect(center).toContainText("证据（支持");
  await expect(center).toContainText("支持该主张");
  await expect(center).toContainText("反对该主张");
  await expect(center).toContainText("背景与旁证");
  // Cross-examination recorded above must be visible here too.
  await expect(center).toContainText("交叉审查（");
  await expect(center).toContainText("项质询");
  // Gaps are diagnosed from persisted state and offer real next steps.
  await expect(center).toContainText("证据缺口与建议补充材料");
  await expect(page.getByTestId("review-gap-list")).toBeVisible();
  await expect(page.getByTestId("review-gap-list")).toContainText("待验证");
  // The derived conclusion is explainable, not just asserted.
  await expect(center).toContainText("结论依据（可核对）");

  // --- a human ruling is written to the backend and stays visible ----------
  await page.getByLabel("裁定理由（必填，至少 10 字，写入审计记录）").fill(rationale);
  await page.getByRole("button", { name: "提交裁定" }).click();
  const history = page.getByTestId("review-history");
  await expect(history).toContainText(rationale);
  await expect(history).toContainText("确认结论");

  // --- the report is generated from persisted material, not from the DOM ---
  await page.getByTestId("fact-check-report-link").click();
  await expect(page.getByTestId("fact-check-report")).toBeVisible();
  const finding = reportFinding(page, claimId);
  await expect(finding).toBeVisible();
  await expect(finding).toContainText(rationale);
  const fingerprint = await page.getByTestId("report-meta").locator("code").innerText();
  expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
  await expect(page.getByTestId("report-provenance")).toContainText("最后事件序号");
  // The report states the window its material covers, so a stale conclusion is
  // never read as a current one.
  await expect(page.getByTestId("report-time-range")).toContainText(
    "所用资料时间范围"
  );
  // Each finding explains itself and lists its own gaps.
  await finding.getByText("结论依据（可核对）").click();
  await expect(finding).toContainText("命中规则");
  await expect(finding).toContainText("参与判断的证据");
  await expect(finding.getByTestId("report-finding-gaps")).toBeVisible();
  await expect(finding).toContainText("建议（待验证，未执行检索）");
  // A gap action is a real navigation carrying the action it wants, and it is
  // scoped to this claim rather than whichever gap the report happens to list first.
  const gapHref = await finding
    .getByTestId("report-gap")
    .first()
    .getByRole("link")
    .first()
    .getAttribute("href");
  expect(gapHref).toContain(`/research/${sessionId}?`);
  expect(gapHref).toContain("intent=");
  expect(gapHref).toContain(`claimId=${claimId}`);

  const downloadHref = await page
    .getByTestId("report-markdown-download")
    .getAttribute("href");
  expect(downloadHref).toContain("format=markdown");
  expect(downloadHref).toContain("download=1");

  const markdown = await page
    .context()
    .request.get(
      `/api/sessions/${sessionId}/fact-check-report?format=markdown&download=1`
    );
  expect(markdown.status()).toBe(200);
  const markdownBody = await markdown.text();
  expect(markdownBody).toContain(claimStatement);
  // The same material must produce the same report: the fingerprint is stable.
  expect(markdownBody).toContain(fingerprint);

  // --- a reload re-reads the same persisted report -------------------------
  await page.reload();
  await expect(page.getByTestId("report-meta").locator("code")).toHaveText(
    fingerprint
  );
  await expect(reportFinding(page, claimId)).toContainText(rationale);

  // --- a gap action from outside really opens the surface that closes it ---
  await page.goto(
    `/research/${sessionId}?intent=record_source&claimId=${claimId}`
  );
  await expect(page.getByTestId("research-body")).toBeVisible();
  await expect(page.getByLabel("来源标题")).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

test("narrow viewport keeps the review workflow reachable without overflow", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsOwner(page);
  const { sessionId, claimId } = await seedSessionWithClaims(
    page,
    "该方案在 24 个月内覆盖 200 间实验室是否可行？"
  );

  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-tabs")).toBeVisible();
  await page.getByRole("tab", { name: "主张" }).click();
  await selectClaim(page, claimId);

  await page.getByRole("tab", { name: "交叉审查" }).click();
  await expect(page.getByTestId("cross-review-panel")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole("tab", { name: "审核中心" }).click();
  await expect(page.getByTestId("review-center")).toBeVisible();
  await expect(page.getByTestId("review-center")).toContainText(
    "证据缺口与建议补充材料"
  );
  await expectNoHorizontalOverflow(page);

  await page.goto(`/research/${sessionId}/report`);
  await expect(page.getByTestId("fact-check-report")).toBeVisible();
  await expect(page.getByTestId("report-finding").first()).toBeVisible();
  await expect(page.getByTestId("report-time-range")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
