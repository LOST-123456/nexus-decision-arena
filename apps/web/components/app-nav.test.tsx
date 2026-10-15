import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * The shell that replaced the per-page headers.
 *
 * What is pinned down here:
 *  - the navigation is the only place that decides the active destination, and
 *    it uses longest-prefix matching so `/research/library` never lights up
 *    two entries at once;
 *  - the theme switch writes the attribute the whole token layer keys off, and
 *    persists it, so a reload cannot lose the choice;
 *  - the section bar disappears instead of rendering an empty strip when a
 *    section has no contextual links.
 */

const mocks = vi.hoisted(() => ({ usePathname: vi.fn<() => string>() }));

vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href?: unknown; children?: ReactNode }) =>
      createElement("a", { href: String(href), ...rest }, children)
  };
});

vi.mock("./auth-user-badge", () => ({
  AuthUserBadge: () => null
}));

import { AppNav, AppSubNav, activeHref } from "./app-nav";
import { ThemeToggle } from "./theme-toggle";

const ROUTES = [
  { href: "/history" },
  { href: "/sessions/new" },
  { href: "/sessions/demo" },
  { href: "/research" },
  { href: "/research/library" },
  { href: "/security" }
];

beforeEach(() => {
  mocks.usePathname.mockReset();
  mocks.usePathname.mockReturnValue("/");
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

afterEach(cleanup);

describe("activeHref", () => {
  it("prefers the longest matching destination", () => {
    expect(activeHref("/research/library", ROUTES)).toBe("/research/library");
    expect(activeHref("/research/abc123", ROUTES)).toBe("/research");
    expect(activeHref("/research", ROUTES)).toBe("/research");
  });

  it("returns null when nothing matches", () => {
    expect(activeHref("/does-not-exist", ROUTES)).toBeNull();
    // A prefix match must not leak across segment boundaries.
    expect(activeHref("/security-review", ROUTES)).toBeNull();
  });
});

describe("AppNav", () => {
  it("marks exactly one destination as the current page", () => {
    mocks.usePathname.mockReturnValue("/research/library");
    render(<AppNav />);

    expect(screen.getByRole("link", { name: "资料库" }).getAttribute("aria-current")).toBe(
      "page"
    );
    expect(
      screen.getByRole("link", { name: "研究与事实核查" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("exposes the theme switch", () => {
    render(<AppNav />);
    expect(screen.getByTestId("theme-toggle")).toBeTruthy();
  });
});

describe("AppSubNav", () => {
  it("renders nothing when the section has no contextual links", () => {
    const { container } = render(<AppSubNav label="研究导航" links={[]} />);
    expect(container.querySelector("[data-testid='app-subnav']")).toBeNull();
  });

  it("marks the current contextual link", () => {
    mocks.usePathname.mockReturnValue("/research/session-1/evidence");
    render(
      <AppSubNav
        label="研究导航"
        links={[
          { href: "/research", label: "研究首页" },
          { href: "/research/session-1", label: "研究工作台" },
          { href: "/research/session-1/evidence", label: "证据地图" }
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "证据地图" }).getAttribute("aria-current")).toBe(
      "page"
    );
    expect(
      screen.getByRole("link", { name: "研究工作台" }).getAttribute("aria-current")
    ).toBeNull();
  });
});

describe("ThemeToggle", () => {
  it("applies and persists the light theme, then switches back", () => {
    render(<ThemeToggle />);
    const button = screen.getByTestId("theme-toggle");

    expect(button.textContent).toContain("深色");
    expect(document.documentElement.dataset.theme).toBeUndefined();

    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("nexus-theme")).toBe("light");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toContain("浅色");

    fireEvent.click(button);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("nexus-theme")).toBe("dark");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });
});
