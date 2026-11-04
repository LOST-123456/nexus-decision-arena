import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { OWNER_PASSWORD } from "./support/credentials";

/**
 * 跳到会话 (⌘K / Ctrl+K) in a real browser.
 *
 * The unit tests already cover the keyboard map against a fake router. What
 * only a browser can answer is whether the whole gesture actually lands: the
 * key reaches the handler with real focus, the panel lists sessions the server
 * says this account may read, and Enter performs a real client-side navigation
 * to the surface the user was already standing in.
 *
 * The panel is deliberately not called "search". It reads titles and ids out of
 * the session list and says so on screen; that sentence is asserted here too,
 * because the honesty is part of the feature rather than a comment.
 */

async function loginAsOwner(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill("owner");
  await page.getByLabel("密码").fill(OWNER_PASSWORD);
  await page.getByRole("button", { name: /^登录/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

/** Creates a research session whose question contains a unique token. */
async function createResearch(page: Page, token: string): Promise<string> {
  const created = await page.context().request.post("/api/sessions", {
    headers: { "idempotency-key": `e2e-switcher-${randomUUID()}` },
    data: {
      project: {
        name: `跳到会话 ${token}`,
        summary: "Quick switcher fixture",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "none"
      },
      locale: "zh-CN",
      researchQuestion: `这份材料是否真的提到了 ${token}？`
    }
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

test("Ctrl+K narrows to one session and Enter opens it where you stand", async ({
  page
}) => {
  await loginAsOwner(page);
  const token = `代号${randomUUID().slice(0, 8)}`;
  const sessionId = await createResearch(page, token);

  // Standing inside the research area, so the destination must be the research
  // workspace — the same record rendered by the surface the user is already in.
  await page.goto("/research");

  await page.keyboard.press("Control+k");
  const panel = page.getByTestId("quick-switcher");
  await expect(panel).toBeVisible();

  const input = page.getByTestId("quick-switcher-input");
  // The caret is in the combobox the moment the panel opens: no click needed.
  await expect(input).toBeFocused();
  await expect(panel).toContainText("不检索会话内容");

  await input.fill(token);
  const options = page.getByRole("option");
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText(token);

  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(new RegExp(`/research/${sessionId}$`));
  await expect(panel).toHaveCount(0);
});

test("Escape closes the panel and gives focus back to the button that opened it", async ({
  page
}) => {
  await loginAsOwner(page);
  await createResearch(page, "焦点回归");

  await page.goto("/history");
  const trigger = page.getByTestId("quick-switcher-trigger");
  await expect(trigger).toBeVisible();

  await trigger.click();
  const panel = page.getByTestId("quick-switcher");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("quick-switcher-input")).toBeFocused();

  await page.keyboard.press("Escape");

  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("the arrow keys walk the list and the selection is announced", async ({ page }) => {
  await loginAsOwner(page);
  await createResearch(page, "方向键");
  await createResearch(page, "方向键二");

  await page.goto("/");
  await page.getByTestId("quick-switcher-trigger").click();
  const input = page.getByTestId("quick-switcher-input");
  await expect(page.getByRole("option").first()).toBeVisible();

  const before = await input.getAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowDown");
  const after = await input.getAttribute("aria-activedescendant");

  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after).not.toBe(before);
  // The id the input points at is the row assistive tech would read out.
  const selected = page.locator(`[id="${after}"]`);
  await expect(selected).toHaveAttribute("aria-selected", "true");
});
