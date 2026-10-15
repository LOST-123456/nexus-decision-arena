import { expect, test } from "@playwright/test";

/**
 * The theme switch is a shell-level feature: every route must honour the
 * stored preference on first paint, and the switch must be a real control.
 * Both are checked against the running app in both viewport projects.
 */

async function appliedTheme(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => document.documentElement.dataset.theme ?? "(none)");
}

test("stored theme is applied before paint on the first route", async ({ page }) => {
  await page.goto("/");

  // Playwright's default emulation reports prefers-color-scheme: light, so an
  // empty storage must resolve to light — the value comes from the media query,
  // not from a hardcoded default.
  await page.evaluate(() => {
    window.localStorage.removeItem("nexus-theme");
  });
  await page.reload();
  expect(await appliedTheme(page)).toBe("light");

  await page.evaluate(() => {
    window.localStorage.setItem("nexus-theme", "dark");
  });
  await page.reload();
  expect(await appliedTheme(page)).toBe("dark");
});

test("the switch flips the theme and persists it", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.setItem("nexus-theme", "dark");
  });
  await page.reload();
  expect(await appliedTheme(page)).toBe("dark");

  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toBeVisible();

  await toggle.click();
  expect(await appliedTheme(page)).toBe("light");
  expect(
    await page.evaluate(() => window.localStorage.getItem("nexus-theme"))
  ).toBe("light");

  // The choice survives a navigation because it is read before first paint.
  await page.goto("/security");
  expect(await appliedTheme(page)).toBe("light");

  await toggle.click();
  expect(await appliedTheme(page)).toBe("dark");
});
