import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * P29 的视觉回归证据。
 *
 * 截图落在 `artifacts/playwright-p29`，与 `artifacts/playwright`（arena spec
 * 的受保护产物）、`playwright-p7/p12/p13/p14/p24`（各自专项）分开，互不覆盖。
 *
 * 这个 spec 只做两件事：把本轮改动的界面在两种视口下真正画出来，并断言支撑
 * 这些界面的结构性事实（面包屑带着真实标题、手机抽屉是被 Escape 关掉的模态、
 * 删除前有明确的确认文案）——截图若与断言不一致，看到的就是假图。
 */

const PROJECT_NAME = "P29 visual";

async function capture(
  page: Page,
  projectName: string,
  name: string
): Promise<void> {
  // Entrance animations run for up to `--duration-slow` (320ms). A screenshot
  // taken on the first frame after `toBeVisible()` catches a dialog at partial
  // opacity and would report a perfectly readable panel as a washed-out one,
  // with the page showing through it.
  await page.waitForTimeout(360);
  const directory = resolve(process.cwd(), "../../artifacts/playwright-p29");
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, `${projectName}-${name}.png`),
    fullPage: false
  });
}

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function createResearch(page: Page): Promise<string> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `p29-visual-${randomUUID()}` },
    data: {
      project: {
        name: PROJECT_NAME,
        summary: "Visual regression fixture for P29",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: "这一轮的界面是否经得起两种视口的审视？"
    }
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  return id;
}

test("p29 visual: shell, workspace, evidence, library and the delete confirmation", async ({
  page
}, testInfo) => {
  const project = testInfo.project.name;
  await loginAsOwner(page);

  // --- the shell: breadcrumb-free home, then two route families ---
  await capture(page, project, "home");

  await page.goto("/research");
  await expect(page.getByTestId("app-nav")).toBeVisible();
  await capture(page, project, "research-home");

  // --- the research workspace: title, phase, vitals, actions, trail ---
  const sessionId = await createResearch(page);
  await page.goto(`/research/${sessionId}`);
  await expect(page.getByTestId("research-body")).toBeVisible();

  // The trail must carry the session's real name, not the raw id.
  const trail = page.getByTestId("app-breadcrumbs");
  await expect(trail).toContainText("研究与事实核查");
  await expect(trail).not.toContainText(sessionId);
  await capture(page, project, "workspace");

  // --- the evidence surface ---
  await page.goto(`/research/${sessionId}/evidence`);
  await expect(page.getByTestId("app-breadcrumbs")).toBeVisible();
  await capture(page, project, "evidence");

  // --- the library ---
  await page.goto("/research/library");
  await expect(page.getByTestId("app-breadcrumbs")).toBeVisible();
  await capture(page, project, "library");

  // --- the confirmation this round introduced, on the one page that deletes ---
  await page.goto("/history");
  const card = page
    .locator("article.review-card")
    .filter({ hasText: PROJECT_NAME })
    .first();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "删除" }).click();

  const dialog = page.getByTestId("session-delete-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("永久删除");
  await expect(dialog).toContainText("无法恢复");
  await capture(page, project, "delete-dialog");

  // Confirming is also the cleanup: the fixture session does not survive the run.
  await dialog.getByRole("button", { name: "删除" }).click();
  await expect(page.getByTestId("session-delete-dialog")).toBeHidden();
  await expect(card).toHaveCount(0);
});

test("p29 visual: the phone drawer is a modal that Escape closes", async ({
  page
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "mobile-390x844",
    "the drawer only exists below 768px"
  );
  await loginAsOwner(page);

  await page.getByTestId("app-nav-menu-button").click();
  const drawer = page.getByRole("dialog", { name: "导航" });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("研究与事实核查");
  await capture(page, testInfo.project.name, "drawer");

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});
