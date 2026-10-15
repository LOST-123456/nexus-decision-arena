import { expect, test } from "@playwright/test";

/**
 * The two things the browser asks for before it renders anything: the tab icon
 * and whether the deployment may be indexed.
 *
 * Both are easy to break silently — a missing icon shows up as a blank page
 * glyph and a missing robots file as a search result nobody looked at — so they
 * get asserted rather than eyeballed.
 */

test("the tab icon is served as an SVG", async ({ request }) => {
  const icon = await request.get("/icon.svg");

  expect(icon.ok()).toBeTruthy();
  expect(icon.headers()["content-type"]).toContain("image/svg+xml");
  expect(await icon.text()).toContain("<svg");
});

test("the demo deployment asks not to be indexed", async ({ request }) => {
  const robots = await request.get("/robots.txt");

  expect(robots.ok()).toBeTruthy();
  const body = await robots.text();
  expect(body).toContain("Disallow: /");
});
