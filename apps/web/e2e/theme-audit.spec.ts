import { expect, test, type Page } from "@playwright/test";
import { auditPixels, contrastRatio, decodePng, type Rgb } from "../lib/png-luminance";

/**
 * Pixel-level theme audit.
 *
 * `theme-switching.spec.ts` proves the switch *works* (the attribute flips, the
 * choice persists). This spec proves the result is *usable*: it screenshots the
 * real pages in both themes, decodes the PNGs and measures what the eye sees.
 *
 * Both halves matter because the light theme was once shipped with a white
 * label on a white button — the attribute flipped perfectly, and the control
 * was invisible. Only pixels can catch that.
 *
 * Thresholds are deliberately loose: this guards the light/dark distinction,
 * not the exact palette, so a tasteful re-tint does not turn the suite red.
 */

const AUDITED_ROUTES = ["/", "/sessions/demo", "/research", "/research/library", "/security"];

/*
 * Measured when this spec landed (dark ratio / mean luminance):
 *   light  0.070–0.109 desktop, 0.213–0.255 mobile (smaller viewport = more ink)
 *   dark   0.941–0.981
 * The bounds below sit well clear of those numbers, so a palette tweak has
 * room while a broken theme does not.
 */

/** A page in the light theme is mostly bright, so dark pixels are the ink. */
const LIGHT_MAX_DARK_RATIO = 0.35;
const LIGHT_MIN_MEAN_LUMINANCE = 0.55;

/** A page in the dark theme is mostly dark, so dark pixels are the paper. */
const DARK_MIN_DARK_RATIO = 0.7;
const DARK_MAX_MEAN_LUMINANCE = 0.3;

/** The two themes must be visibly far apart, whatever the palette becomes. */
const MIN_DARK_RATIO_GAP = 0.4;

/** WCAG AA for text; measured 14.2:1 (light) and 16.7:1 (dark), was 1.06:1. */
const MIN_CONTROL_CONTRAST = 4.5;

type Theme = "dark" | "light";

interface PageAudit {
  meanLuminance: number;
  darkRatio: number;
}

/** Pins the theme for every navigation, before the first paint reads storage. */
async function pinTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value) => {
    try {
      window.localStorage.setItem("nexus-theme", value);
    } catch {
      // about:blank has no storage; the first real navigation retries.
    }
  }, theme);
}

/** Waits until the client has hydrated and published a measured app bar. */
async function waitForShell(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--app-nav-h")
      .trim();
    return token.endsWith("px") && document.fonts.status === "loaded";
  });
}

async function auditRoute(page: Page, route: string, theme: Theme): Promise<PageAudit> {
  await page.goto(route, { waitUntil: "domcontentloaded" });

  // The bootstrap script runs before paint, so by the time the page is
  // interactive the attribute must already be ours.
  expect(
    await page.evaluate(() => document.documentElement.dataset.theme),
    `${route} (${theme}) must apply the pinned theme before paint`
  ).toBe(theme);

  await waitForShell(page);

  const shot = await page.screenshot();
  return auditPixels(decodePng(shot));
}

interface ControlColors {
  color: string;
  background: string;
}

async function readControlColors(page: Page): Promise<ControlColors | null> {
  return page.evaluate(() => {
    const alphaOf = (value: string): number => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return 0;
      const parts = (match[1] ?? "").split(",").map((part) => Number.parseFloat(part));
      return parts.length > 3 ? parts[3] ?? 1 : 1;
    };

    const control = document.querySelector('[data-testid="theme-toggle"]');
    if (!control) return null;

    // The button paints on whatever surface sits behind it, so walk up until
    // an opaque background is found instead of assuming its own is set.
    let node: Element | null = control;
    let background = "rgb(0, 0, 0)";
    while (node) {
      const candidate = getComputedStyle(node).backgroundColor;
      if (alphaOf(candidate) > 0.5) {
        background = candidate;
        break;
      }
      node = node.parentElement;
    }

    return { color: getComputedStyle(control).color, background };
  });
}

function parseRgb(value: string): Rgb {
  const match = value.match(/rgba?\(([^)]+)\)/);
  const parts = (match?.[1] ?? "0,0,0").split(",").map((part) => Number.parseFloat(part));
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0 };
}

test("the light theme renders bright pages and the dark theme dark ones", async ({ page }) => {
  await pinTheme(page, "light");
  const light = new Map<string, PageAudit>();
  for (const route of AUDITED_ROUTES) {
    light.set(route, await auditRoute(page, route, "light"));
  }

  const darkPage = await page.context().newPage();
  await pinTheme(darkPage, "dark");
  const dark = new Map<string, PageAudit>();
  for (const route of AUDITED_ROUTES) {
    dark.set(route, await auditRoute(darkPage, route, "dark"));
  }
  await darkPage.close();

  for (const route of AUDITED_ROUTES) {
    const lightAudit = light.get(route)!;
    const darkAudit = dark.get(route)!;

    expect(
      lightAudit.darkRatio,
      `${route}: light theme must read as a light page (dark ratio ${lightAudit.darkRatio})`
    ).toBeLessThanOrEqual(LIGHT_MAX_DARK_RATIO);
    expect(
      lightAudit.meanLuminance,
      `${route}: light theme mean luminance ${lightAudit.meanLuminance}`
    ).toBeGreaterThanOrEqual(LIGHT_MIN_MEAN_LUMINANCE);

    expect(
      darkAudit.darkRatio,
      `${route}: dark theme must read as a dark page (dark ratio ${darkAudit.darkRatio})`
    ).toBeGreaterThanOrEqual(DARK_MIN_DARK_RATIO);
    expect(
      darkAudit.meanLuminance,
      `${route}: dark theme mean luminance ${darkAudit.meanLuminance}`
    ).toBeLessThanOrEqual(DARK_MAX_MEAN_LUMINANCE);

    expect(
      darkAudit.darkRatio - lightAudit.darkRatio,
      `${route}: the two themes must be visibly apart ` +
        `(light ${lightAudit.darkRatio} vs dark ${darkAudit.darkRatio})`
    ).toBeGreaterThanOrEqual(MIN_DARK_RATIO_GAP);
  }
});

test("the theme switch stays legible in both themes", async ({ page }) => {
  for (const theme of ["light", "dark"] as const) {
    await pinTheme(page, theme);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await waitForShell(page);

    const control = page.getByTestId("theme-toggle");
    await expect(control, `${theme}: the switch must be visible`).toBeVisible();

    const colors = await readControlColors(page);
    expect(colors, `${theme}: the switch must be styleable`).not.toBeNull();

    const ratio = contrastRatio(parseRgb(colors!.color), parseRgb(colors!.background));
    expect(
      ratio,
      `${theme}: the switch label must contrast with its own surface ` +
        `(${colors!.color} on ${colors!.background} = ${ratio.toFixed(2)}:1)`
    ).toBeGreaterThanOrEqual(MIN_CONTROL_CONTRAST);
  }
});
