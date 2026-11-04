/**
 * 本轮修复的现场复核。
 *
 * 只回答一件事：改完之后，用户打开会话页会看到什么。所以每一步都记录
 * 页面上真实存在的文字和数据，并截图留证——不靠"我读过代码"。
 *
 * 复核项：
 *  1. 页头结论叫什么（定稿 vs 初步倾向）
 *  2. 决策地图是否还会被图例压住、还会不会静默裁切
 *  3. 时间线是否说出"还有内容"
 *  4. 新建评审的字数计数与草稿
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { OWNER_PASSWORD } from "./credentials.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const OUT = "C:/Users/Lenovo/WorkBuddy/2026-10-08-17-58-34/_tmp/verify-shots";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];

async function run(width, height, tag) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: "zh-CN"
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text().slice(0, 300));
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message.slice(0, 200)}`));

  const shot = async (name, fullPage = false) => {
    try {
      await page.screenshot({ path: `${OUT}/${tag}-${name}.png`, fullPage });
    } catch (error) {
      console.log(`(截图失败 ${name}: ${error.message.slice(0, 100)})`);
    }
  };

  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /登录/ }).first().click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 20000 });

  // 找一个"还没出结论"的会话：那边才有初步倾向与阶段步号。
  const sessions = await page.evaluate(async () => {
    const response = await fetch("/api/sessions", { cache: "no-store" });
    if (!response.ok) return { status: response.status, items: [] };
    const payload = await response.json();
    return { status: response.status, items: payload };
  });
  const payload = sessions.items;
  const list = Array.isArray(payload)
    ? payload
    : payload?.sessions ?? payload?.items ?? [];
  const running = list.find((item) => !["DECIDED", "REPORT_READY"].includes(item.phase));
  const decided = list.find((item) => ["DECIDED", "REPORT_READY"].includes(item.phase));
  results.push({
    tag,
    sessions: list.length,
    running: running ? `${running.id} (${running.phase})` : "(无)",
    decided: decided ? `${decided.id} (${decided.phase})` : "(无)"
  });

  const inspect = async (sessionId, label) => {
    await page.goto(`${BASE}/sessions/${sessionId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const snap = await page.evaluate(() => {
      const headerLabel = document
        .querySelector(".workspace-vitals > span:first-child small")
        ?.textContent?.trim();
      const headerValue = document
        .querySelector(".workspace-vitals > span:first-child strong")
        ?.textContent?.trim();
      const phaseValue = document
        .querySelector(".workspace-vitals > span:nth-child(2) strong")
        ?.textContent?.trim();
      const legendSummary = document.querySelector(".edge-legend-shell > summary");
      const legendOpen = document
        .querySelector(".edge-legend-shell")
        ?.hasAttribute("open");
      const zoomHint = document.querySelector('[data-testid="map-zoom-hint"]')
        ?.textContent?.trim();
      const timelineOverflow = document
        .querySelector('[data-testid="timeline-overflow"]')
        ?.textContent?.trim();
      const timelineData = document
        .querySelector('[data-testid="timeline"]')
        ?.getAttribute("data-overflow");
      const timelineCards = document.querySelectorAll('[data-testid="timeline"] li').length;
      const timelineList = document.querySelector(".timeline-list");
      // 决策地图里有没有节点被画布右边界切掉（节点右边缘 > 画布右边缘）。
      const canvas = document.querySelector(".map-canvas")?.getBoundingClientRect();
      const nodes = [...document.querySelectorAll(".decision-node")].map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          right: Math.round(rect.right),
          clipped: canvas ? rect.right > canvas.right + 1 : null
        };
      });
      return {
        headerLabel,
        headerValue,
        phaseValue,
        legendSummary: legendSummary?.textContent?.trim(),
        legendOpen,
        zoomHint: zoomHint ?? null,
        timelineOverflow: timelineOverflow ?? null,
        timelineData,
        timelineCards,
        timelineScroll: timelineList
          ? `${timelineList.scrollWidth}/${timelineList.clientWidth}`
          : null,
        canvasWidth: canvas ? Math.round(canvas.width) : null,
        nodeCount: nodes.length,
        clippedNodes: nodes.filter((node) => node.clipped).length
      };
    });
    results.push({ tag, label, sessionId, ...snap });
    await shot(`${label}`);

    // 点「全览」之后：节点应该全都进到视野里，而且页面明说现在是缩小状态。
    const fitButton = page.locator(".map-fit-button");
    if ((await fitButton.count()) > 0) {
      await fitButton.first().click();
      await page.waitForTimeout(1500);
      const after = await page.evaluate(() => {
        const canvas = document.querySelector(".map-canvas")?.getBoundingClientRect();
        const nodes = [...document.querySelectorAll(".decision-node")];
        const outside = nodes.filter((node) => {
          const rect = node.getBoundingClientRect();
          return (
            !canvas ||
            rect.right > canvas.right + 2 ||
            rect.bottom > canvas.bottom + 2 ||
            rect.left < canvas.left - 2 ||
            rect.top < canvas.top - 2
          );
        }).length;
        return {
          hint: document.querySelector('[data-testid="map-zoom-hint"]')?.textContent?.trim(),
          nodes: nodes.length,
          outside
        };
      });
      results.push({ tag, label: `${label}-fit`, ...after });
      await shot(`${label}-fit`);
    }
  };

  if (running) await inspect(running.id, "running");
  if (decided) await inspect(decided.id, "decided");

  // 新建评审：字数计数 + 草稿
  await page.goto(`${BASE}/sessions/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  const form = await page.evaluate(() => ({
    counter: document.querySelector(".field-counter")?.textContent?.trim(),
    required: document.querySelectorAll(".field-required").length,
    submitStyle: (() => {
      const button = document.querySelector(".new-session-submit");
      if (!button) return null;
      const style = getComputedStyle(button);
      return { background: style.backgroundColor, color: style.color };
    })()
  }));
  results.push({ tag, label: "new-form", ...form });
  await shot("new-form", true);

  await page.getByRole("textbox", { name: "项目名称" }).fill("草稿复核用标题");
  await page.waitForTimeout(300);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const draftKept = await page
    .getByRole("textbox", { name: "项目名称" })
    .inputValue()
    .catch(() => "(读不到)");
  results.push({ tag, label: "draft", draftKept });

  results.push({ tag, consoleErrors: errors.length, errors: errors.slice(0, 5) });
  await context.close();
}

await run(1080, 820, "narrow");
await run(1440, 950, "wide");
await browser.close();

console.log(JSON.stringify(results, null, 2));
