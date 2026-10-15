"use client";

import { useEffect } from "react";

/**
 * The global bar is a wrapping flex row: one line on a wide screen, up to three
 * on a 390px phone. So `--app-nav-h` cannot be a constant — a hardcoded number
 * is wrong the moment the bar wraps, and every full-height shell that subtracts
 * it either leaves a gap or, worse, leaks a scrollbar exactly one bar-height
 * long.
 *
 * This component publishes the *measured* height back onto `<html>` as the
 * token. The stylesheet keeps its own values as the pre-hydration / no-JS
 * fallback, and the CSS itself is unchanged: the inline property simply wins
 * once the real number is known.
 */
export const NAV_SELECTOR = '[data-testid="app-nav"]';

export const NAV_HEIGHT_TOKEN = "--app-nav-h";

/**
 * Writes `height` of `element` into the token on `root`. Exported so it can be
 * exercised without a live ResizeObserver.
 */
export function publishNavHeight(element: Element, root: HTMLElement): number {
  const height = element.getBoundingClientRect().height;
  root.style.setProperty(NAV_HEIGHT_TOKEN, `${height}px`);
  return height;
}

export function AppNavHeightObserver() {
  useEffect(() => {
    const root = document.documentElement;
    const nav = document.querySelector<HTMLElement>(NAV_SELECTOR);
    if (!nav) {
      return;
    }

    // Measure once immediately, then keep up with wrapping / font loading /
    // zoom changes. Setting the token can itself change the bar's `min-height`,
    // but it converges on the first frame, so the observer settles.
    publishNavHeight(nav, root);

    const observer = new ResizeObserver(() => {
      publishNavHeight(nav, root);
    });
    observer.observe(nav);

    return () => {
      observer.disconnect();
    };
  }, []);

  return null;
}
