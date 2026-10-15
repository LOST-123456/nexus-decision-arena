"use client";

import { useEffect, useState } from "react";

/**
 * Dark/light switch for the whole product.
 *
 * The authoritative value lives on `<html data-theme>`: it is applied by an
 * inline script before hydration (see app/layout.tsx) so the first paint is
 * already correct, and persisted in localStorage so the choice survives
 * reloads. React only mirrors that state here for the button's own label.
 */
export type ThemeName = "dark" | "light";

export const THEME_STORAGE_KEY = "nexus-theme";

/**
 * The applied theme, kept in sync with the attribute on `<html>`.
 *
 * Styling is expressed entirely in CSS through semantic tokens, so nothing has
 * to know the theme to look right — the React Flow canvases included. This hook
 * exists for the few places that must *render* from the value (the toggle's own
 * label and `aria-pressed`) and reads the single source of truth rather than
 * inventing a second one. The very first client render matches the server
 * render (`dark`), then the effect reconciles with what the bootstrap script
 * actually applied — which keeps hydration quiet.
 */
export function useThemeName(): ThemeName {
  const [theme, setTheme] = useState<ThemeName>("dark");

  useEffect(() => {
    const root = document.documentElement;
    const sync = (): void => {
      setTheme(root.dataset.theme === "light" ? "light" : "dark");
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      observer.disconnect();
    };
  }, []);

  return theme;
}

export function ThemeToggle() {
  const observed = useThemeName();
  /*
   * The click handler knows the value it just wrote, so it echoes that value
   * into `theme` instead of waiting for the observer's microtask to come back —
   * otherwise the button's own label and `aria-pressed` lag one task behind the
   * press. This is not a second source of truth: the echo is released on the
   * next observed change, so a write from anywhere else still wins.
   */
  const [echoed, setEchoed] = useState<ThemeName | null>(null);
  const theme = echoed ?? observed;

  useEffect(() => {
    setEchoed(null);
  }, [observed]);

  function apply(next: ThemeName): void {
    document.documentElement.dataset.theme = next;
    setEchoed(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private-mode storage failures must not break the switch.
    }
  }

  const nextTheme: ThemeName = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      className="theme-toggle"
      data-testid="theme-toggle"
      data-theme-current={theme}
      aria-pressed={theme === "light"}
      title={nextTheme === "light" ? "切换到浅色主题" : "切换到深色主题"}
      onClick={() => {
        apply(nextTheme);
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {theme === "light" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        )}
      </svg>
      <span>{theme === "light" ? "浅色" : "深色"}</span>
    </button>
  );
}
