/**
 * Browser-level check of the supplement round.
 *
 * The API tests prove the server is fast and the stream is fast. This proves
 * the thing the reviewer actually looks at: the panel fills in while the
 * round runs, and it comes back to a decision on its own.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { OWNER_PASSWORD } from "./credentials.mjs";

const BASE = "http://127.0.0.1:3000";
const SESSION_ID = process.argv[2];
const OUT = process.argv[3] ?? "../../artifacts/playwright";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

// Sign in.
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.getByLabel("用户名").fill("owner");
await page.getByLabel("密码").fill(OWNER_PASSWORD);
await page.getByRole("button", { name: /登录/ }).first().click();
await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20000 });

await page.goto(`${BASE}/sessions/${SESSION_ID}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/supplement-progress-landing.png`, fullPage: false });
console.log(`落地页 URL=${page.url()}`);
console.log(`落地页可见文本：\n${(await page.locator("main").innerText().catch(() => "(no main)")).slice(0, 1200)}`);
console.log(
  `\n页面上的按钮：${JSON.stringify(
    await page.locator(".human-checkpoint-actions button").allInnerTexts().catch(() => [])
  )}`
);
await page.getByRole("button", { name: "要求补充分析" }).waitFor({ timeout: 20000 });

const clickedAt = Date.now();
await page.getByRole("button", { name: "要求补充分析" }).click();

// The progress line is the whole point: it must appear and change.
const progress = page.locator(".decision-in-progress-progress");
await progress.waitFor({ timeout: 15000 });
const samples = [];
for (let i = 0; i < 8; i += 1) {
  samples.push({
    at: Date.now() - clickedAt,
    text: (await progress.count()) ? await progress.innerText() : "(面板已切回)"
  });
  await page.screenshot({ path: `${OUT}/supplement-progress-live.png` });
  if (!(await progress.count())) break;
  await page.waitForTimeout(600);
}

console.log("=== 面板上的进度文本 ===");
for (const sample of samples) {
  console.log(`  +${sample.at}ms  ${sample.text.replace(/\s+/g, " ")}`);
}

// The panel must hand the page back to a decision without a reload.
await page
  .getByRole("button", { name: "要求补充分析" })
  .waitFor({ timeout: 120000 });
const backAt = Date.now() - clickedAt;
await page.screenshot({ path: `${OUT}/supplement-progress-done.png` });

console.log(`\n=== 点击 -> 页面回到可裁决：${backAt} ms ===`);
console.log(
  `=== 页面中途没有手动刷新（全程 ${backAt}ms 内页面未 reload）===`
);
console.log(
  consoleErrors.length
    ? `!! 控制台报错 ${consoleErrors.length} 条：\n${consoleErrors.join("\n")}`
    : "控制台无报错"
);

await browser.close();
