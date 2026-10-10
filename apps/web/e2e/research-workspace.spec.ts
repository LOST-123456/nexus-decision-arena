import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

const claimStatement = "该公司上一季度出货量同比增长 12%。";
const sourceTitle = "2025 年第四季度出货统计";
const excerpt = "第四季度出货量同比增长 12%。";
const verificationNote = "与 PDF 第 14 页表格逐字核对一致。";

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
    headers: { "idempotency-key": `e2e-research-${randomUUID()}` },
    data: {
      project: {
        name: "Research e2e",
        summary: "Browser verification of the evidence loop",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: "该公司上一季度出货量是否同比增长？"
    }
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return id;
}

// The three-column flow is exercised at desktop width; the narrow layout has
// its own test below, so both projects run the full suite deterministically.
test("research workspace records a claim, a source and a verified excerpt", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const sessionId = await createResearch(page);

  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-body")).toBeVisible();
  await expect(
    page.getByText("该公司上一季度出货量是否同比增长？")
  ).toBeVisible();

  // --- claim ---
  await page.getByRole("button", { name: "添加主张" }).click();
  await page.getByLabel("待核查主张（写成一句话，可验证）").fill(claimStatement);
  await page.getByRole("button", { name: "添加主张" }).last().click();
  await expect(page.getByTestId("claim-list")).toContainText(claimStatement);

  // --- source ---
  await page.getByRole("button", { name: "添加来源" }).click();
  await page.getByLabel("来源标题").fill(sourceTitle);
  await page.getByLabel("类型").selectOption("document");
  await page.getByLabel(/^链接/).fill("https://example.org/shipments-q4.pdf");
  await page.getByLabel("发布机构").fill("示例统计局");
  await page.getByRole("button", { name: "保存来源" }).click();
  await expect(page.getByRole("button", { name: "录入证据" })).toBeVisible();

  // --- evidence ---
  await page.getByRole("button", { name: "录入证据" }).click();
  await page.getByLabel("材料标题").fill("Q4 出货量原文");
  await page.getByLabel("原文摘录").fill(excerpt);
  await page.getByLabel("这条材料说明了什么").fill("统计年报中的原句。");
  await page.getByLabel("来源记录").selectOption({ label: sourceTitle });
  await page.getByLabel("摘录定位（页码 / 段落 / 行号）").fill("p.14, table 3");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "保存为待核实材料" }).click();

  await expect(page.getByTestId("evidence-table")).toContainText(excerpt);
  await expect(page.getByTestId("evidence-table")).toContainText("待核实");

  // --- verdict must stay unresolved while nothing is verified ---
  await page.getByTestId("claim-list").getByText(claimStatement).click();
  await expect(page.getByText("事实核查结论：证据不足，未下结论")).toBeVisible();

  // --- select the excerpt and verify it ---
  await page.getByRole("button", { name: "Q4 出货量原文" }).click();
  await expect(page.getByTestId("source-detail")).toBeVisible();
  await expect(page.getByTestId("source-detail")).toContainText(sourceTitle);
  await expect(page.getByTestId("source-detail")).toContainText("示例统计局");

  await page.getByLabel(/核实理由/).fill(verificationNote);
  await page.getByRole("button", { name: "标记为已核实" }).click();

  await expect(page.getByTestId("source-detail")).toContainText("已核实");
  await expect(page.getByTestId("source-detail")).toContainText(verificationNote);

  // --- verdict updates ---
  await expect(page.getByText("事实核查结论：有已核实支持证据")).toBeVisible();

  // --- persistence across a full reload ---
  await page.reload();
  await expect(page.getByTestId("evidence-table")).toContainText(excerpt);
  await expect(page.getByTestId("evidence-table")).toContainText("已核实");
  await expect(page.getByTestId("claim-list")).toContainText(claimStatement);

  await page.getByRole("button", { name: "Q4 出货量原文" }).click();
  await expect(page.getByTestId("source-detail")).toContainText(verificationNote);
  await expect(page.getByTestId("source-detail")).toContainText("Owner");

  await expectNoHorizontalOverflow(page);
});

test("evidence explorer filters evidence and shows the verdict per claim", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const sessionId = await createResearch(page);

  // Seed one claim + one unverified excerpt through the API.
  const claim = await page.context().request.post(
    `/api/sessions/${sessionId}/claims`,
    {
      headers: { "idempotency-key": `e2e-claim-${randomUUID()}` },
      data: {
        statement: "渠道库存保持稳定。",
        type: "assumption",
        stance: "neutral",
        importance: 2
      }
    }
  );
  expect(claim.status()).toBe(201);
  const { claim: claimBody } = (await claim.json()) as {
    claim: { id: string };
  };

  const evidence = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence`,
    {
      headers: { "idempotency-key": `e2e-evidence-${randomUUID()}` },
      data: {
        kind: "external_reference",
        title: "库存说明",
        content: "渠道库存环比持平。",
        description: "内部周报。",
        sourceRef: "https://example.org/weekly",
        direction: "context",
        reliability: 0.4,
        claimIds: [claimBody.id]
      }
    }
  );
  expect(evidence.status()).toBe(201);

  await page.goto(`/research/${sessionId}/evidence`);
  await expect(page.getByText("筛选", { exact: true })).toBeVisible();
  await expect(page.getByText("库存说明")).toBeVisible();

  await page.getByLabel("方向").selectOption("supports");
  await expect(page.getByText("没有符合筛选条件的证据。")).toBeVisible();

  await page.getByLabel("方向").selectOption("context");
  await expect(page.getByText("库存说明")).toBeVisible();

  // Unverified background material must not turn into a conclusion: the verdict
  // stays "insufficient evidence" until someone actually checks the excerpt.
  await expect(page.getByText("证据不足，未下结论")).toBeVisible();
  await expect(page.getByText("仅有背景材料")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("narrow viewport degrades to tabs instead of squeezed columns", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAsOwner(page);
  const sessionId = await createResearch(page);

  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-tabs")).toBeVisible();
  await expect(page.getByRole("tab", { name: "主张" })).toBeVisible();

  await page.getByRole("tab", { name: "来源详情" }).click();
  await expect(
    page.getByText("选择一条证据材料即可查看原文、来源元数据与核实记录。")
  ).toBeVisible();

  // The reader is a full-width surface on every viewport; with nothing chosen
  // yet it must say so rather than render an empty box.
  await page.getByRole("tab", { name: "原文阅读" }).click();
  await expect(page.getByText(/还没有选择要阅读的来源/)).toBeVisible();

  await expectNoHorizontalOverflow(page);
});

/**
 * The url-import path cannot be exercised against the real network here: the
 * server's own guard would (correctly) refuse anything a test could reach, and
 * a public page would make the suite depend on the internet. So this test
 * covers what is verifiable offline — that the entry point exists, that it
 * states the refusal policy, and that a source with no stored text says so
 * instead of pretending to have one.
 */
test("import entry states its policy and the reader reports missing page text", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await loginAsOwner(page);
  const sessionId = await createResearch(page);

  const claim = await page.context().request.post(
    `/api/sessions/${sessionId}/claims`,
    {
      headers: { "idempotency-key": `e2e-claim-${randomUUID()}` },
      data: {
        statement: "该公司上一季度出货量同比增长 12%。",
        type: "fact",
        stance: "neutral",
        importance: 3
      }
    }
  );
  expect(claim.status()).toBe(201);
  const { claim: claimBody } = (await claim.json()) as {
    claim: { id: string };
  };

  const source = await page.context().request.post(
    `/api/sessions/${sessionId}/sources`,
    {
      headers: { "idempotency-key": `e2e-source-${randomUUID()}` },
      data: {
        title: "手工登记的年报",
        kind: "document",
        url: "https://example.org/annual-report.pdf",
        publisher: "示例统计局"
      }
    }
  );
  expect(source.status()).toBe(201);
  const { source: sourceBody } = (await source.json()) as {
    source: { id: string };
  };

  const evidence = await page.context().request.post(
    `/api/sessions/${sessionId}/evidence`,
    {
      headers: { "idempotency-key": `e2e-evidence-${randomUUID()}` },
      data: {
        kind: "external_reference",
        title: "年报出货量原句",
        content: "第四季度出货量同比增长 12%。",
        description: "年报正文原句。",
        sourceId: sourceBody.id,
        direction: "supports",
        reliability: 0.7,
        claimIds: [claimBody.id]
      }
    }
  );
  expect(evidence.status()).toBe(201);

  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-body")).toBeVisible();

  await page.getByRole("button", { name: "导入网页" }).click();
  await expect(page.getByTestId("import-source-form")).toBeVisible();
  await expect(
    page.getByText(/内网、本机与云元数据地址一律拒绝/)
  ).toBeVisible();
  await page.getByRole("button", { name: "收起导入" }).click();
  await expect(page.getByTestId("import-source-form")).toHaveCount(0);

  // A manually registered source has no stored page text, and the reader has to
  // say that plainly rather than showing an empty document.
  await page.getByRole("button", { name: "年报出货量原句" }).click();
  await expect(page.getByTestId("source-detail")).toBeVisible();
  await expect(page.getByTestId("source-detail")).toContainText("未抓取原文");

  await page.getByRole("button", { name: "阅读保存的原文" }).click();
  await expect(page.getByTestId("source-reader")).toBeVisible();
  await expect(page.getByTestId("source-reader")).toContainText(
    "这个来源还没有抓到原文"
  );

  await expectNoHorizontalOverflow(page);

  await page.getByRole("button", { name: "关闭" }).click();
  await expect(page.getByTestId("source-detail")).toBeVisible();
});
