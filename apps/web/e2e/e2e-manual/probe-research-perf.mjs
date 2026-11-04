/**
 * 研究工作台的可用性与卡顿探针。
 *
 * 只回答三个问题，全部基于浏览器里真实发生的事：
 *  1. 页面打开会不会报错（console error / pageerror）
 *  2. 每个页签点开后要多久才有内容（等到网络空闲）
 *  3. 各接口在这一页实际传了多少字节、花了多少毫秒
 *
 * 不做任何写操作：只登录、只读页签。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { OWNER } from "./credentials.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const SID = process.env.SID;
const OUT = "C:/Users/Lenovo/WorkBuddy/2026-10-08-17-58-34/_tmp/research-perf";
mkdirSync(OUT, { recursive: true });

if (!SID) {
  console.log("需要 SID 环境变量");
  process.exit(1);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 950 },
  locale: "zh-CN"
});
const page = await context.newPage();

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 200)}`);
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));

// 用接口登录：脚本关心的是工作台，不是登录页的表单标签。
// 非浏览器请求不带 Origin，服务端按「非浏览器免来源校验、但仍鉴权」处理。
const logged = await context.request.post(`${BASE}/api/auth/login`, {
  data: OWNER
});
if (!logged.ok()) {
  console.log(`登录失败 ${logged.status()}`);
  process.exit(1);
}

const t0 = Date.now();
await page.goto(`${BASE}/research/${SID}`, { waitUntil: "domcontentloaded" });
const domReady = Date.now() - t0;
await page.waitForSelector("text=主张目录", { timeout: 30000 });
const firstPaint = Date.now() - t0;

const counts = await page.evaluate(() => ({
  claimRows: document.querySelectorAll('[data-testid="evidence-table"] tbody tr').length,
  tabs: Array.from(document.querySelectorAll('[role="tab"]')).map((el) => el.textContent?.trim()),
  docHeight: document.documentElement.scrollHeight
}));

const tabNames = counts.tabs.filter(Boolean);
const tabResults = [];
for (const name of tabNames) {
  const before = errors.length;
  const start = Date.now();
  let ok = true;
  try {
    await page.getByRole("tab", { name, exact: true }).click();
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    ok = false;
  }
  const took = Date.now() - start;
  await page.waitForTimeout(120);
  const panelText = await page.evaluate(() => {
    const el = document.querySelector("#research-workspace-panel") ?? document.body;
    return (el.textContent ?? "").length;
  });
  tabResults.push({ name, ms: took, ok, textLength: panelText, newErrors: errors.length - before });
}

const resources = await page.evaluate(() => {
  return performance
    .getEntriesByType("resource")
    .filter((e) => String(e.name).includes("/api/"))
    .map((e) => ({
      path: String(e.name).replace(location.origin, "").split("?")[0],
      ms: Math.round(e.duration),
      bytes: e.transferSize || 0
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 12);
});

await page.screenshot({
  path: `${OUT}/workspace.png`,
  fullPage: true
});

console.log(JSON.stringify({
  domReady,
  firstPaint,
  claimRowsInEvidenceTable: counts.claimRows,
  tabCount: tabResults.length,
  tabResults,
  heaviestApis: resources,
  errors: errors.slice(0, 8)
}, null, 2));

await browser.close();
