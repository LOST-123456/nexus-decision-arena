/**
 * 只为「研究与事实核查、资料库怎么跑」这一问取证。
 *
 * 打开一条真实研究（含 1 个已抓取来源），把工作台、引用核查、证据清单、
 * 资料库的实际界面抓下来——讲解要基于屏幕上真实存在的东西，不是想象。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { OWNER_PASSWORD } from "./credentials.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const SID = process.env.SID;
const OUT = "C:/Users/Lenovo/WorkBuddy/2026-10-08-17-58-34/_tmp/research-shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 950 }, locale: "zh-CN" });
const page = await context.newPage();
const out = [];

await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.getByLabel("用户名").fill("owner");
await page.getByLabel("密码").fill(OWNER_PASSWORD);
await page.getByRole("button", { name: /登录/ }).first().click();
await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20000 });

const shot = async (name) => {
  try {
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  } catch (error) {
    console.log(`(截图失败 ${name}: ${error.message.slice(0, 80)})`);
  }
};

// 1) 研究首页
await page.goto(`${BASE}/research`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
out.push({
  step: "研究首页",
  panels: await page.evaluate(() =>
    [...document.querySelectorAll(".research-panel-title, h2, h3")]
      .map((n) => n.textContent?.trim())
      .filter((t) => t && t.length < 40)
      .slice(0, 18)
  ),
  buttons: await page.evaluate(() =>
    [...document.querySelectorAll("button, a")].map((n) => n.textContent?.trim()).filter((t) => t && t.length < 20).slice(0, 25)
  )
});
await shot("01-research-home");

// 2) 研究工作台
await page.goto(`${BASE}/research/${SID}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
out.push({
  step: "研究工作台",
  tabs: await page.evaluate(() =>
    [...document.querySelectorAll(".workspace-tab-bar button, .tab-group button, nav button")]
      .map((n) => n.textContent?.trim())
      .filter(Boolean)
      .slice(0, 30)
  ),
  headings: await page.evaluate(() =>
    [...document.querySelectorAll("h1, h2, h3")].map((n) => n.textContent?.trim()).filter(Boolean).slice(0, 12)
  )
});
await shot("02-workspace");

// 3) 引用核查面板
const citationTab = page.getByRole("button", { name: "引用核查" });
if (await citationTab.count()) {
  await citationTab.first().click();
  await page.waitForTimeout(2000);
  out.push({
    step: "引用核查",
    text: (await page.locator("section").filter({ hasText: "引用" }).first().innerText().catch(() => "")).slice(0, 700)
  });
  await shot("03-citations");
}

// 4) 原文阅读（看快照正文与摘录）
const readerTab = page.getByRole("button", { name: "原文阅读" });
if (await readerTab.count()) {
  await readerTab.first().click();
  await page.waitForTimeout(2000);
  out.push({
    step: "原文阅读",
    text: (await page.locator("main").innerText().catch(() => "")).slice(0, 800)
  });
  await shot("04-reader");
}

// 5) 资料库
await page.goto(`${BASE}/research/library`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
out.push({
  step: "资料库",
  text: (await page.locator("main").innerText().catch(() => "")).slice(0, 900)
});
await shot("05-library");

// 6) 事实核查报告
await page.goto(`${BASE}/research/${SID}/report`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
out.push({
  step: "事实核查报告",
  text: (await page.locator("main").innerText().catch(() => "")).slice(0, 900)
});
await shot("06-factcheck-report");

await browser.close();
console.log(JSON.stringify(out, null, 2));
