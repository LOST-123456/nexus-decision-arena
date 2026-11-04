/**
 * 只读健康探针：验证真实浏览器里页面能不能打开、有没有 console 报错、关键接口是否成功。
 * 不做任何写操作，不截图，只输出指标。
 *
 * 用法：SID=<sessionId> node e2e-manual/probe-readonly-health.mjs
 */
import { chromium } from "@playwright/test";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const SID = process.env.SID;
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

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
page.on("response", (r) => {
  const u = r.url();
  if (u.includes("/api/") && r.status() >= 400) {
    failedRequests.push(`${r.status()} ${u.replace(BASE, "")}`);
  }
});

// 走接口登录，避开登录页表单
const res = await context.request.post(`${BASE}/api/auth/login`, {
  data: { username: "owner", password: process.env.OWNER_PASSWORD }
});
console.log("登录:", res.status());

const pages = [
  ["研究首页", "/research"],
  ["资料库", "/research/library"],
  ["研究工作台", `/research/${SID}`],
  ["报告页", `/research/${SID}/report`],
  ["历史", "/history"],
  ["通知", "/notifications"],
  ["新建研究", "/research/new"]
];

for (const [name, path] of pages) {
  const before = failedRequests.length;
  const t0 = Date.now();
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 45_000 });
  const ms = Date.now() - t0;
  const bodyText = (await page.locator("body").innerText()).slice(0, 120).replace(/\s+/g, " ");
  const bad = failedRequests.length - before;
  console.log(`${String(ms + "ms").padEnd(8)} 失败接口 ${String(bad).padEnd(3)} ${name.padEnd(6)} ${bodyText}`);
}

console.log("\nconsole error:", consoleErrors.length);
consoleErrors.slice(0, 6).forEach((e) => console.log("  -", e));
console.log("pageerror:", pageErrors.length);
pageErrors.slice(0, 6).forEach((e) => console.log("  -", e));
console.log("失败接口明细:", failedRequests.length);
[...new Set(failedRequests)].slice(0, 12).forEach((e) => console.log("  -", e));

await browser.close();
