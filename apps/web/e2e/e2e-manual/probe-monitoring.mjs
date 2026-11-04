/**
 * 新页签「来源监控」的现场验收。
 *
 * 只做一件真实的事：在浏览器里点开这个页签，对一条真来源发起一次检查，
 * 把屏幕上出现的结果带回来。检查失败也算结论——但必须如实写出来。
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { OWNER } from "./credentials.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const SID = process.env.SID;
const OUT = "C:/Users/Lenovo/WorkBuddy/2026-10-08-17-58-34/_tmp/monitoring-verify";
mkdirSync(OUT, { recursive: true });

if (!SID) {
  console.log("需要 SID 环境变量");
  process.exit(1);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: "zh-CN"
});
const page = await context.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));

const login = await context.request.post(`${BASE}/api/auth/login`, {
  data: OWNER
});
if (!login.ok()) {
  console.log(`登录失败 ${login.status()}`);
  process.exit(1);
}

await page.goto(`${BASE}/research/${SID}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=主张目录", { timeout: 30000 });

const t0 = Date.now();
await page.getByRole("tab", { name: "来源监控", exact: true }).click();
await page.waitForSelector('[data-testid="source-monitoring"]', { timeout: 20000 });
const openMs = Date.now() - t0;

const before = await page.evaluate(() => {
  const panel = document.querySelector('[data-testid="source-monitoring"]');
  const rows = Array.from(
    document.querySelectorAll('[data-testid="monitor-sources"] tbody tr')
  );
  return {
    title: panel?.querySelector("h2")?.textContent?.trim() ?? null,
    emptyTasks:
      document
        .querySelector('[data-testid="monitoring-no-open-tasks"]')
        ?.textContent?.trim()
        ?.slice(0, 60) ?? null,
    sourceRows: rows.length,
    firstRow: rows[0]?.textContent?.replace(/\s+/g, " ").slice(0, 80) ?? null
  };
});

await page.screenshot({ path: `${OUT}/tab-open.png`, fullPage: true });

// 对第一条来源发起一次真实检查
const firstCheck = page.locator('[data-testid^="check-"]').first();
const checkStarted = Date.now();
await firstCheck.click();
await page.waitForFunction(
  () => {
    const row = document.querySelector('[data-testid="monitor-sources"] tbody tr');
    return !!row && !row.textContent?.includes("检查中");
  },
  { timeout: 60000 }
);
const checkMs = Date.now() - checkStarted;

const after = await page.evaluate(() => {
  const row = document.querySelector('[data-testid="monitor-sources"] tbody tr');
  const tasks = document.querySelector('[data-testid="revalidation-tasks"]');
  return {
    rowText: row?.textContent?.replace(/\s+/g, " ").slice(0, 260) ?? null,
    taskRows: tasks
      ? tasks.querySelectorAll("tbody tr").length
      : 0,
    noTasks:
      document
        .querySelector('[data-testid="monitoring-no-open-tasks"]')
        ?.textContent?.trim()
        ?.slice(0, 40) ?? null
  };
});

await page.screenshot({ path: `${OUT}/after-check.png`, fullPage: true });

console.log(
  JSON.stringify({ openMs, checkMs, before, after, errors: errors.slice(0, 5) }, null, 2)
);

await browser.close();
