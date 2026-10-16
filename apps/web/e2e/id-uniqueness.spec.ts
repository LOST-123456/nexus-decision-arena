import { expect, test } from "@playwright/test";

/**
 * Duplicate-id regressions, and the landmark invariant on the routes the
 * landmark sweep does not reach.
 *
 * `accessibility-landmarks.spec.ts` counts `main` elements on the eight public
 * routes. That leaves two gaps this file closes:
 *
 *  1. It only counts `main`. An id that appears twice anywhere else in the
 *     document is the same class of bug: `htmlFor` resolves, `aria-labelledby`
 *     resolves, and `document.getElementById` silently picks the first match.
 *     The realistic way that happens here is a hard-coded `id` inside a list
 *     render, which no unit test can see because each page is rendered once.
 *  2. It does not visit the detail routes (`/sessions/:id`, `/research/:id`…)
 *     or a not-found path — exactly the pages that wrap themselves in a
 *     landmark *and* can swap in a full-page notice when the core API is
 *     unreachable. Those two behaviours were merged into one component in the
 *     UI primitive layer, so they are worth asserting together.
 *
 * The detail-route assertion is deliberately limited to "exactly one landmark":
 * whether core answers, times out or is down, the page must still be a single
 * landmark. That keeps the check independent of the database being up.
 */

const CONTENT_ROUTES = [
  "/",
  "/sessions/demo",
  "/sessions/new",
  "/history",
  "/research",
  "/research/library",
  "/security",
  "/login"
];

const DETAIL_ROUTES = [
  "/sessions/p21-probe-session",
  "/sessions/p21-probe-session/report",
  "/research/p21-probe-session",
  "/research/p21-probe-session/evidence",
  "/research/p21-probe-session/report",
  "/p21-probe-no-such-route"
];

/** Every id that appears more than once, with its count. */
function duplicateIds(): { id: string; count: number }[] {
  const counts = new Map<string, number>();
  document.querySelectorAll<HTMLElement>("[id]").forEach((element) => {
    counts.set(element.id, (counts.get(element.id) ?? 0) + 1);
  });
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }));
}

test("no public route renders the same id twice", async ({ page }) => {
  for (const route of CONTENT_ROUTES) {
    await page.goto(route, { waitUntil: "domcontentloaded" });

    // Wait for the page to be interactive, otherwise a list that fills in after
    // hydration is scanned before it exists and the check passes vacuously.
    await page.waitForLoadState("load");

    const duplicates = await page.evaluate(duplicateIds);
    expect(
      duplicates,
      `${route}: duplicate ids ${JSON.stringify(duplicates)}`
    ).toEqual([]);

    await expect(page.locator("main#main"), `${route}: main landmark`).toHaveCount(
      1
    );
  }
});

test("detail routes stay a single landmark whatever the core API answers", async ({
  page
}) => {
  for (const route of DETAIL_ROUTES) {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load");

    await expect(page.locator("main"), `${route}: one main element`).toHaveCount(
      1
    );
    await expect(page.locator("main#main"), `${route}: main landmark`).toHaveCount(
      1
    );

    const duplicates = await page.evaluate(duplicateIds);
    expect(
      duplicates,
      `${route}: duplicate ids ${JSON.stringify(duplicates)}`
    ).toEqual([]);
  }
});
