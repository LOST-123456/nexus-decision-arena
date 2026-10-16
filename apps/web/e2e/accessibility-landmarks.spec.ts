import { expect, test } from "@playwright/test";

/**
 * Landmark and skip-link regressions.
 *
 * Two things are asserted here that nothing else can see:
 *  1. Every route ends in a single `main` landmark that carries `id="main"`.
 *     The skip link is worthless if its target is missing or duplicated, and a
 *     missing landmark is invisible to a unit test (each page builds its own).
 *  2. The skip link is the *first* thing a keyboard reaches, it is off-canvas
 *     until focused, and activating it lands focus on the landmark. "The link
 *     exists in the DOM" is not the same claim as "the link works".
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

test("every route exposes exactly one main landmark with id=main", async ({
  page
}) => {
  for (const route of PUBLIC_ROUTES) {
    await page.goto(route, { waitUntil: "domcontentloaded" });

    await expect(page.locator("main#main"), `${route}: main landmark`).toHaveCount(
      1
    );

    // A duplicate id would make the skip link land on whichever copy the
    // browser picks first, which is not something the author chose.
    const mains = await page.locator("main").count();
    expect(mains, `${route}: only one main element`).toBe(1);
  }
});

test("the skip link is first in tab order, hidden until focused, and lands focus on the landmark", async ({
  page
}) => {
  await page.goto("/research", { waitUntil: "domcontentloaded" });

  const skip = page.locator("a.skip-link");
  await expect(skip).toHaveCount(1);
  await expect(skip).toHaveAttribute("href", "#main");

  // Before any focus it must sit outside the viewport: a permanent chip under
  // the app bar would be a visual change nobody asked for.
  const offscreen = await skip.evaluate(
    (el) => el.getBoundingClientRect().bottom <= 0
  );
  expect(offscreen, "skip link must be off-canvas until focused").toBe(true);

  // From a freshly loaded page, one Tab must reach it before any nav link.
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();

  // Revealing it is a transition, so wait for it to settle instead of reading
  // the rect mid-animation — a single immediate measurement is a race and was
  // observed failing on the 390px viewport for exactly that reason.
  await expect
    .poll(
      () =>
        skip.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= window.innerHeight;
        }),
      { timeout: 3_000 }
    )
    .toBe(true);

  await page.keyboard.press("Enter");

  expect(new URL(page.url()).hash).toBe("#main");
  await expect(page.locator("main#main")).toBeFocused();
});
