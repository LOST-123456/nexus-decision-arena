import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The cross-research library, checked in a real browser against a real
 * backend, with two real signed-in accounts.
 *
 * The promises under test, one per acceptance item that needs a browser:
 *  - an owner may copy a source between two of their own researches, and the
 *    copy lands with its own capture, its lineage and its origin recorded;
 *  - copying carries no judgment: a citation that exists in the origin does
 *    not appear in the target, and a citation made in the target starts
 *    unverified;
 *  - a research the account may not see stays out of the library, and its
 *    source id answers exactly what an id that does not exist answers;
 *  - a grant really reaches the account it names, and revoking it takes the
 *    visibility back while leaving the copy and the audit alone;
 *  - a viewer reads and copies nothing, and is told so instead of being
 *    offered controls that would fail.
 *
 * Everything is seeded through the real HTTP API and driven through the real
 * UI controls, with two independent browser contexts so the two accounts
 * really are two accounts. The one shortcut is the one that keeps the suite
 * offline: captured text arrives as an imported local file, never fetched
 * from the internet.
 */

const OWNER = { username: "owner", password: "nexus-owner" };
const VIEWER = { username: "viewer", password: "nexus-viewer" };

/** Unique per run, so the desktop and mobile projects never collide. */
function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function loginAs(
  page: Page,
  account: { username: string; password: string }
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(account.username);
  await page.getByLabel("密码").fill(account.password);
  await page.getByRole("button", { name: /^登录/ }).click();
  // Generous on purpose: on a cold dev server the landing page is compiled on
  // first request, which is slower than the sign-in itself.
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
}

async function createResearch(page: Page, question: string): Promise<string> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-lib-session-${randomUUID()}` },
    data: {
      project: {
        name: question,
        summary: "Cross-research library e2e",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: question
    }
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return id;
}

/**
 * Imports a local text file through the real file route.
 *
 * Returns the source as recorded — including the title the server derived from
 * the file name, which is what every later lookup has to match on. Guessing the
 * title would assert against a shape the product does not produce.
 */
async function importFile(
  page: Page,
  sessionId: string,
  fileName: string,
  text: string
): Promise<{ id: string; title: string }> {
  const uploaded = await page.context().request.post(
    `/api/sessions/${sessionId}/files`,
    {
      headers: {
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(fileName),
        "idempotency-key": `e2e-lib-file-${randomUUID()}`
      },
      data: Buffer.from(text, "utf8")
    }
  );
  expect(uploaded.status()).toBe(201);
  const body = (await uploaded.json()) as {
    source: { id: string; title: string } | null;
    duplicated: boolean;
  };
  expect(body.duplicated).toBe(false);
  expect(body.source).not.toBeNull();
  return { id: body.source!.id, title: body.source!.title };
}

async function seedClaim(page: Page, sessionId: string, statement: string): Promise<string> {
  const claim = await page.context().request.post(
    `/api/sessions/${sessionId}/claims`,
    {
      headers: { "idempotency-key": `e2e-lib-claim-${randomUUID()}` },
      data: { statement, type: "fact", stance: "support", importance: 4 }
    }
  );
  expect(claim.status()).toBe(201);
  const { claim: created } = (await claim.json()) as { claim: { id: string } };
  return created.id;
}

/** Registers a citation and returns its verification state, as recorded. */
async function seedEvidence(
  page: Page,
  sessionId: string,
  sourceId: string,
  claimId: string,
  title: string
): Promise<string> {
  const evidence = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence`,
    {
      headers: { "idempotency-key": `e2e-lib-evidence-${randomUUID()}` },
      data: {
        kind: "external_reference",
        title,
        content: "季度成本较上年同期上升 12%。",
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

async function sourceIdByTitle(page: Page, sessionId: string, title: string): Promise<string> {
  const response = await page.context().request.get(`/api/sessions/${sessionId}/sources`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { sources: Array<{ id: string; title: string }> };
  const match = body.sources.find((row) => row.title === title);
  expect(match).toBeDefined();
  return match!.id;
}

/** Picks the `option` whose text contains `needle`, however it is worded. */
async function selectContaining(
  control: Locator,
  needle: string
): Promise<string> {
  const value = await control.evaluate((element, text) => {
    const options = Array.from((element as HTMLSelectElement).options);
    const match = options.find((option) =>
      (option.textContent ?? "").includes(text as string)
    );
    return match ? match.value : null;
  }, needle);
  expect(value, `no option containing ${needle}`).not.toBeNull();
  await control.selectOption(value!);
  return value!;
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
  const directory = resolve(process.cwd(), "../../artifacts/playwright-p13");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${projectName}-${name}.png`),
    fullPage: false
  });
}

test("copies a source into another of my researches, and carries no judgment with it", async ({
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, OWNER);

  const originQuestion = unique("资料库来源研究");
  const targetQuestion = unique("资料库目标研究");
  const origin = await createResearch(page, originQuestion);
  const target = await createResearch(page, targetQuestion);

  const sourceTitle = unique("季度成本报告");
  const imported = await importFile(
    page,
    origin,
    `${sourceTitle}.txt`,
    "季度成本较上年同期上升 12%。\n"
  );
  const originSourceId = imported.id;
  const recordedTitle = imported.title;
  const originClaimId = await seedClaim(page, origin, `${originQuestion}：成本是否上升？`);
  await seedEvidence(page, origin, originSourceId, originClaimId, unique("来源研究的引用"));

  // --- the library is scoped to what this account may use -------------------
  await page.goto(`/research/library?sessionId=${target}`);
  const results = page.getByTestId("library-results");
  await expect(results).toBeVisible();
  await expect(results).toContainText(recordedTitle);
  // It also says out loud that the copy drops the other side's conclusions.
  await expect(page.getByTestId("source-library")).toContainText(
    "复制会带走原文快照，但不会带走对方的核实结论"
  );

  // --- copying into a chosen research of my own -----------------------------
  await selectContaining(page.getByTestId("library-target"), targetQuestion);
  const row = page.getByTestId("library-row").filter({ hasText: recordedTitle });
  await expect(row).toHaveCount(1);
  await row.getByTestId("library-copy").click();

  await expect(page.getByTestId("library-message")).toContainText("已复制到本研究");
  // The message names the consequence rather than implying the work is done.
  await expect(page.getByTestId("library-message")).toContainText("未核实");

  // --- the copy is the target's own material --------------------------------
  const copiedSourceId = await sourceIdByTitle(page, target, recordedTitle);
  expect(copiedSourceId).not.toBe(originSourceId);

  // The lineage records where it came from, who copied it and which snapshot.
  const lineageResponse = await page.context().request.get(
    `/api/sessions/${target}/library/lineage`
  );
  expect(lineageResponse.status()).toBe(200);
  const lineage = (
    (await lineageResponse.json()) as {
      lineage: Record<string, { originSessionId: string; copiedBy: string; originStatus: string }>;
    }
  ).lineage[copiedSourceId];
  expect(lineage).toBeDefined();
  expect(lineage!.originSessionId).toBe(origin);
  expect(lineage!.copiedBy).toContain("owner");
  expect(lineage!.originStatus).toBe("current");

  // Nothing else travelled: the origin's citation is not the target's.
  const targetEvidence = await page.context().request.get(
    `/api/sessions/${target}/evidence`
  );
  expect((await targetEvidence.json()) as { evidence: unknown[] }).toEqual({
    evidence: []
  });

  // --- a citation made here starts unverified -------------------------------
  const targetClaimId = await seedClaim(page, target, `${targetQuestion}：成本是否上升？`);
  const targetEvidenceTitle = unique("目标研究的引用");
  await seedEvidence(page, target, copiedSourceId, targetClaimId, targetEvidenceTitle);

  const ownEvidence = await page.context().request.get(
    `/api/sessions/${target}/evidence`
  );
  const registered = (
    (await ownEvidence.json()) as {
      evidence: Array<{ title: string; verificationStatus: string }>;
    }
  ).evidence.find((item) => item.title === targetEvidenceTitle);
  expect(registered).toBeDefined();
  // A copy brings material, never an endorsement: this citation has to be
  // verified on its own merits.
  expect(registered!.verificationStatus).toBe("unverified");

  // --- the origin is visible on the source itself ---------------------------
  await page.goto(`/research/${target}`);
  await expect(page.getByTestId("evidence-table")).toBeVisible();
  await page.getByRole("button", { name: targetEvidenceTitle }).click();
  const detail = page.getByTestId("source-detail");
  await expect(detail).toBeVisible();
  const copyLineage = detail.getByTestId("source-copy-lineage");
  await expect(copyLineage).toBeVisible();
  await expect(copyLineage).toContainText("副本来源");
  await expect(copyLineage).toContainText(origin);
  await expect(copyLineage).toContainText("副本是本研究自己的材料");

  await capture(page, testInfo.project.name, "library-copy");
  await expectNoHorizontalOverflow(page);
});

test("keeps an unauthorized research out of the library, and answers a guessed id as unknown", async ({
  browser,
  page
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAs(page, OWNER);

  // Two of the owner's researches: one to share, one to keep private.
  const sharedQuestion = unique("对外共享的研究");
  const privateQuestion = unique("未共享的研究");
  const shared = await createResearch(page, sharedQuestion);
  const privateResearch = await createResearch(page, privateQuestion);

  const sharedImport = await importFile(
    page,
    shared,
    `${unique("共享来源")}.txt`,
    "共享研究的正文。\n"
  );
  const sharedTitle = sharedImport.title;
  const privateImport = await importFile(
    page,
    privateResearch,
    `${unique("私密来源")}.txt`,
    "未共享研究的正文。\n"
  );
  const privateSourceId = privateImport.id;

  // --- before sharing, another account sees none of it ----------------------
  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  try {
    await loginAs(viewerPage, VIEWER);
    await viewerPage.goto("/research/library");
    await expect(viewerPage.getByTestId("source-library")).toBeVisible();
    // A positive signal that the load finished, so the absence checks below
    // cannot pass just because nothing has arrived yet.
    await expect(viewerPage.getByTestId("library-sessions")).toContainText(
      "暂无可见研究"
    );
    await expect(viewerPage.getByTestId("library-sessions")).not.toContainText(
      sharedQuestion
    );
    await expect(viewerPage.getByTestId("library-results")).not.toContainText(
      sharedTitle
    );

    // A guessed source id answers exactly what an id that does not exist
    // answers, so the route cannot be used to learn which ids are real.
    const guessed = await viewerContext.request.get(
      `/api/library/sources/${privateSourceId}`
    );
    const unknown = await viewerContext.request.get(
      `/api/library/sources/${randomUUID()}`
    );
    expect(guessed.status()).toBe(404);
    expect(unknown.status()).toBe(404);
    expect(await guessed.json()).toEqual(await unknown.json());

    // ...and neither can its lineage.
    const guessedLineage = await viewerContext.request.get(
      `/api/sessions/${privateResearch}/library/lineage`
    );
    expect(guessedLineage.status()).toBe(404);

    // --- the owner shares, by username, from the library page ---------------
    await page.goto("/research/library");
    await selectContaining(page.locator("#library-managed"), sharedQuestion);
    await page.getByLabel("账号用户名或 ID").fill(VIEWER.username);
    await page.getByLabel("授权范围").selectOption("read");
    await page.getByTestId("library-grant-form")
      .getByRole("button", { name: "授权" })
      .click();
    await expect(page.getByTestId("library-message")).toContainText("已授权");
    // The grant table names the account it actually landed on.
    const grantRow = page.getByTestId("library-grant-row").filter({
      hasText: "账号"
    });
    await expect(grantRow).toHaveCount(1);
    await expect(grantRow).toContainText("可浏览");

    // --- now the viewer can read it, and only read it ------------------------
    await viewerPage.reload();
    await expect(viewerPage.getByTestId("library-sessions")).toContainText(
      sharedQuestion
    );
    await expect(viewerPage.getByTestId("library-sessions")).toContainText("被授权");
    await expect(viewerPage.getByTestId("library-results")).toContainText(sharedTitle);

    // A viewer is told it is read-only rather than offered controls that fail.
    await expect(viewerPage.getByTestId("library-readonly")).toBeVisible();
    await expect(viewerPage.getByTestId("library-copy")).toBeDisabled();
    await expect(viewerPage.getByTestId("library-grants")).toHaveCount(0);

    // --- revoking takes the visibility back, and nothing else ----------------
    await page.getByTestId("library-grant-revoke").click();
    await expect(page.getByTestId("library-message")).toContainText(
      "副本与审计记录保留"
    );
    await expect(page.getByTestId("library-grant-row")).toContainText("已撤销");

    await viewerPage.reload();
    // The viewer is left with nothing visible at all, which is the positive
    // form of "the revoke took the access back".
    await expect(viewerPage.getByTestId("library-sessions")).toContainText(
      "暂无可见研究"
    );
    await expect(viewerPage.getByTestId("library-results")).not.toContainText(
      sharedTitle
    );

    // The audit keeps both decisions, attributed to the account that made them.
    const audit = await page.context().request.get(
      `/api/sessions/${shared}/events`
    );
    expect(audit.status()).toBe(200);
    const events = (await audit.json()) as Array<{ type: string }>;
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["SOURCE_LIBRARY_GRANTED", "SOURCE_LIBRARY_REVOKED"])
    );

    await capture(page, testInfo.project.name, "library-sharing");
    await expectNoHorizontalOverflow(page);
  } finally {
    await viewerContext.close();
  }
});

test("stays usable on a phone-sized screen", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, OWNER);

  const originQuestion = unique("移动端来源研究");
  const targetQuestion = unique("移动端目标研究");
  const origin = await createResearch(page, originQuestion);
  const target = await createResearch(page, targetQuestion);
  const sourceTitle = (
    await importFile(
      page,
      origin,
      `${unique("移动端来源")}.txt`,
      "移动端视口下的正文。\n"
    )
  ).title;

  await page.goto(`/research/library?sessionId=${target}`);
  await expect(page.getByTestId("library-results")).toContainText(sourceTitle);
  // The language filter states its own limit on the narrow layout too.
  await expect(page.getByTestId("library-language-hint")).toContainText(
    "不做语言猜测"
  );

  const row = page.getByTestId("library-row").filter({ hasText: sourceTitle });
  await row.getByTestId("library-copy").click();
  await expect(page.getByTestId("library-message")).toContainText("已复制到本研究");

  await capture(page, testInfo.project.name, "library-mobile");
  await expectNoHorizontalOverflow(page);
});
