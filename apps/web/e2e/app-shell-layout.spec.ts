import { expect, test, type Page } from "@playwright/test";

/**
 * Shell-level layout regressions that used to be caught by throwaway probes.
 *
 * Two invariants matter:
 *  1. `--app-nav-h` is a *measured* number. The bar is one row on a desktop and
 *     three on a 390px phone, so a hardcoded token makes every
 *     `calc(100dvh - var(--app-nav-h))` shell wrong by exactly the difference.
 *  2. No route scrolls sideways, and a viewport-locked shell ends exactly at the
 *     bottom of the viewport instead of leaking a scrollbar one bar-height long.
 */

const PUBLIC_ROUTES = [
  "/",
  "/sessions/demo",
  "/history",
  "/sessions/new",
  "/research",
  "/research/library",
  "/security",
  "/login"
];

/** Waits until the client has replaced the stylesheet fallback with a real px value. */
async function waitForMeasuredBar(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const bar = document.querySelector('[data-testid="app-nav"]');
    if (!bar) return false;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--app-nav-h")
      .trim();
    return token.endsWith("px");
  });
}

test("the bar publishes its measured height as --app-nav-h", async ({ page }) => {
  for (const route of PUBLIC_ROUTES) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await waitForMeasuredBar(page);

    const measured = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="app-nav"]');
      const token = getComputedStyle(document.documentElement)
        .getPropertyValue("--app-nav-h")
        .trim();
      return {
        barHeight: bar ? bar.getBoundingClientRect().height : -1,
        tokenPx: Number.parseFloat(token)
      };
    });

    expect(measured.barHeight, `${route} must render the app bar`).toBeGreaterThan(0);
    expect(
      Math.abs(measured.tokenPx - measured.barHeight),
      `${route}: --app-nav-h (${measured.tokenPx}) must equal the measured bar (${measured.barHeight})`
    ).toBeLessThanOrEqual(0.5);
  }
});

test("no route scrolls sideways", async ({ page }) => {
  for (const route of PUBLIC_ROUTES) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await waitForMeasuredBar(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow, `${route} must not overflow horizontally`).toBeLessThanOrEqual(0);
  }
});

test("a viewport-locked shell ends at the bottom of the viewport", async ({ page }) => {
  const viewport = page.viewportSize();
  test.skip(
    !viewport || viewport.width < 1000,
    "below 1000px the demo shell is content-driven by design"
  );

  await page.goto("/sessions/demo", { waitUntil: "domcontentloaded" });
  await waitForMeasuredBar(page);

  const box = await page.evaluate(() => {
    const shell = document.querySelector(".demo-shell");
    const bar = document.querySelector('[data-testid="app-nav"]');
    const root = document.documentElement;
    return {
      shellBottom: (shell ? shell.getBoundingClientRect().height : 0) +
        (bar ? bar.getBoundingClientRect().height : 0),
      viewportHeight: window.innerHeight,
      pageOverflow: root.scrollHeight - root.clientHeight
    };
  });

  // bar + shell must add up to the viewport, so nothing is cut off and nothing
  // is left over. The old constant token left a 5.8px gap here.
  expect(Math.abs(box.shellBottom - box.viewportHeight)).toBeLessThanOrEqual(1);
  expect(box.pageOverflow).toBeLessThanOrEqual(1);
});
