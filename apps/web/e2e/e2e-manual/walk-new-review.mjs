/**
 * 新建评审：把整条路真走一遍。
 *
 * 不是接口测试，是"人坐在浏览器前会怎么用"的测试。每一步截图，并把
 * 控制台错误、失败请求、耗时一起记下来——这些才是用户真正会遇到的。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { OWNER_PASSWORD, VIEWER_PASSWORD } from "./credentials.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const OUT = "C:/Users/Lenovo/WorkBuddy/2026-10-08-17-58-34/_tmp/new-review-shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  locale: "zh-CN"
});
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") {
    consoleErrors.push(message.text().slice(0, 400));
  }
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message.slice(0, 400)}`));
const badRequests = [];
page.on("requestfailed", (request) => {
  badRequests.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText}`);
});
page.on("response", (response) => {
  if (response.status() >= 500) badRequests.push(`${response.status()} ${response.url()}`);
});

const steps = [];
function record(name, detail) {
  steps.push({ name, detail });
  console.log(`\n### ${name}\n${detail}`);
}
async function shot(name, fullPage = true) {
  // 截图只是旁证：写不进去不该让它把整条走查带停。
  try {
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  } catch (error) {
    console.log(`(截图 ${name} 写入失败: ${error.message.slice(0, 120)})`);
  }
}

const FILL = {
  name: "校园 AI 实验室危化品安全管理平台（走查用）",
  summary:
    "面向高校实验室的危化品全生命周期管理平台，覆盖采购、入库、领用、废弃四个环节，用视觉识别自动登记用量并预警超期库存。",
  targetUsers: "高校实验室安全员、院系设备管理员、学校资产与采购部门",
  businessModel: "按实验室数量年费订阅，首年含硬件适配与培训",
  expectedData: "两年覆盖 200 家实验室，ARR 1600 万元"
};

async function fillForm() {
  await page.getByRole("textbox", { name: "项目名称" }).fill(FILL.name);
  await page.getByRole("textbox", { name: "项目简介" }).fill(FILL.summary);
  await page.getByRole("textbox", { name: "目标用户" }).fill(FILL.targetUsers);
  await page.getByRole("textbox", { name: "商业模式" }).fill(FILL.businessModel);
  await page.getByRole("textbox", { name: "预期数据与目标" }).fill(FILL.expectedData);
}

try {
  // ---------------------------------------------------------------- A
  await page.goto(`${BASE}/sessions/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const button = page.getByTestId("start-review");
  record("A1 未登录 · 页面", `URL=${page.url()}\n按钮文案="${await button.innerText()}"`);
  record(
    "A2 未登录 · 运行条件提示",
    (await page.locator("#new-session-runtime-note").innerText()).slice(0, 500)
  );

  // 未登录时空提交：先看浏览器原生校验是否抢在业务提示之前。
  await button.click();
  await page.waitForTimeout(800);
  const invalidCount = await page.locator("form.new-session-form :invalid").count();
  const firstInvalidMessage = await page
    .locator("form.new-session-form :invalid")
    .first()
    .evaluate((element) => element.validationMessage)
    .catch(() => "(无可校验元素)");
  const noticeVisible = await page.getByTestId("new-session-notice").count();
  record(
    "A3 未登录 · 空表单点提交",
    `原生 :invalid 元素=${invalidCount} 个；首个提示="${firstInvalidMessage}"；业务提示框=${noticeVisible} 个\n` +
      `→ 也就是说，点下去用户先看到的是浏览器自己的气泡，不是"请先登录"`
  );
  await shot("A3-empty-submit");

  // 未登录但填满表单再点：这时应该听到"还没登录"。
  await fillForm();
  await button.click();
  await page.waitForTimeout(800);
  const noticeText =
    (await page.getByTestId("new-session-notice").count()) > 0
      ? await page.getByTestId("new-session-notice").innerText()
      : "(没有出现提示框)";
  record("A4 未登录 · 填满后提交", noticeText.replace(/\n/g, " | "));
  await shot("A4-not-logged-in-notice");

  // ---------------------------------------------------------------- B
  const loginStart = Date.now();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /登录/ }).first().click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20000 });
  record("B 登录", `耗时 ${Date.now() - loginStart}ms，落地 ${page.url()}`);

  // ---------------------------------------------------------------- C
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await shot("C-home");
  const entryCount = await page.getByRole("link", { name: "新建评审" }).count();
  record("C1 首页入口", `页面上“新建评审”链接 ${entryCount} 个`);

  const entryStart = Date.now();
  await page.getByRole("link", { name: "新建评审" }).first().click();
  await page.waitForURL((url) => url.pathname.includes("/sessions/new"), { timeout: 15000 });
  await page.waitForTimeout(1200);
  record("C2 首页→新建页", `跳转耗时 ${Date.now() - entryStart}ms，URL=${page.url()}`);
  record(
    "C3 新建页 · 按钮文案",
    `"${await page.getByTestId("start-review").innerText()}"  状态标记="${await page.locator(".form-status").innerText()}"`
  );
  await shot("C3-new-form");

  // ---------------------------------------------------------------- D
  const longName = "超长名称".repeat(40);
  await page.getByRole("textbox", { name: "项目名称" }).fill(longName);
  const stored = await page.getByRole("textbox", { name: "项目名称" }).inputValue();
  record(
    "D 超长输入",
    `输入 ${longName.length} 字，输入框实际保留 ${stored.length} 字（maxLength=120）——` +
      (stored.length < longName.length ? "被静默截断，界面没有任何提示" : "未被截断")
  );

  // ---------------------------------------------------------------- E
  await page.goto(`${BASE}/sessions/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await fillForm();
  await shot("E1-filled");

  const submitStart = Date.now();
  await page.getByTestId("start-review").click();
  // 立刻再点一次：看有没有幂等/防重复保护
  await page.getByTestId("start-review").click({ force: true, timeout: 2000 }).catch(() => {});
  await page.waitForURL((url) => url.pathname.startsWith("/sessions/") && url.pathname !== "/sessions/new", {
    timeout: 60000
  });
  const redirectMs = Date.now() - submitStart;
  record("E2 提交→跳转", `${redirectMs}ms 后进入 ${page.url()}`);
  await page.waitForTimeout(2500);
  await shot("E3-workspace-landing");

  const sessionUrl = page.url();
  const sessionId = sessionUrl.split("/").pop();

  // ---------------------------------------------------------------- F
  const mainText = await page.locator("main").innerText().catch(() => "(无 main)");
  record("F1 会话页首屏", mainText.slice(0, 900));
  const workspaceButtons = await page.locator("main button").allInnerTexts().catch(() => []);
  record("F2 会话页可用按钮", JSON.stringify(workspaceButtons));

  // ---------------------------------------------------------------- G
  const phaseSamples = [];
  for (let i = 0; i < 6; i += 1) {
    phaseSamples.push(
      `${Math.round((Date.now() - submitStart) / 1000)}s: ${(await page.locator("main").innerText())
        .replace(/\s+/g, " ")
        .slice(0, 160)}`
    );
    await page.waitForTimeout(2000);
  }
  record("G 进度是否在动（每 2 秒采样）", phaseSamples.join("\n"));
  await shot("G-running");

  // ---------------------------------------------------------------- H
  const refreshStart = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const afterReload = await page.locator("main").innerText();
  record(
    "H 刷新会话页",
    `耗时 ${Date.now() - refreshStart}ms；文本长度 ${afterReload.length}\n${afterReload.replace(/\s+/g, " ").slice(0, 400)}`
  );
  await shot("H-after-reload");

  // ---------------------------------------------------------------- I
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);
  record("I1 浏览器后退", `落地 ${page.url()}`);
  const backName = await page.getByRole("textbox", { name: "项目名称" }).inputValue().catch(() => "(不在新建页)");
  record("I2 后退后的表单", `项目名称输入框内容="${backName.slice(0, 40)}"`);
  await shot("I2-after-back");

  // 直接再点一次提交，看会不会又建一个会话
  if (page.url().includes("/sessions/new")) {
    const before = Date.now();
    await page.getByTestId("start-review").click().catch(() => {});
    await page.waitForURL((url) => url.pathname.startsWith("/sessions/") && url.pathname !== "/sessions/new", {
      timeout: 30000
    }).catch(() => {});
    record(
      "I3 后退后再提交",
      `${Date.now() - before}ms 后 ${page.url()}  ${page.url().includes(sessionId ?? "____") ? "（同一个会话）" : "（**又创建了一个新会话**）"}`
    );
  }

  // ---------------------------------------------------------------- J
  const viewerContext = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: "zh-CN" });
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await viewerPage.getByLabel("用户名").fill("viewer");
  await viewerPage.getByLabel("密码").fill(VIEWER_PASSWORD);
  await viewerPage.getByRole("button", { name: /登录/ }).first().click();
  await viewerPage
    .waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20000 })
    .catch(() => {});
  await viewerPage.goto(`${BASE}/sessions/new`, { waitUntil: "domcontentloaded" });
  await viewerPage.waitForTimeout(2000);
  const viewerButton = await viewerPage.getByTestId("start-review").innerText().catch(() => "(无按钮)");
  const viewerNote = await viewerPage.locator("#new-session-runtime-note").innerText().catch(() => "");
  record("J viewer 角色", `按钮="${viewerButton}"\n提示：${viewerNote.replace(/\s+/g, " ").slice(0, 300)}`);
  await viewerPage.screenshot({ path: `${OUT}/J-viewer.png`, fullPage: true });
  await viewerContext.close();
} catch (error) {
  record("异常中断", `${error.message}`);
  await shot("Z-failure");
} finally {
  record(
    "\n== 控制台错误 ==",
    consoleErrors.length === 0 ? "(无)" : consoleErrors.slice(0, 12).join("\n")
  );
  record(
    "== 失败请求 / 5xx ==",
    badRequests.length === 0 ? "(无)" : badRequests.slice(0, 12).join("\n")
  );
  await browser.close();
}
