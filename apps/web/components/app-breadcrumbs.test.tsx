import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppBreadcrumbs } from "./app-breadcrumbs";

/**
 * The trail, checked against the real component.
 *
 * What is pinned down here: a dynamic segment gets the name the page handed
 * over rather than the raw id, an unknown segment still shows itself instead
 * of vanishing, the home page has no trail at all, and the last crumb is the
 * current page rather than a link to where the reader already is.
 */

const mocks = vi.hoisted(() => ({ usePathname: vi.fn<() => string>() }));

vi.mock("next/navigation", () => ({ usePathname: mocks.usePathname }));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href?: unknown; children?: React.ReactNode }) =>
      createElement("a", { href: String(href), ...rest }, children)
  };
});

afterEach(() => cleanup());

function renderAt(pathname: string, labels?: Record<string, string>) {
  mocks.usePathname.mockReturnValue(pathname);
  // A default rather than a conditional spread: `exactOptionalPropertyTypes`
  // rejects an explicitly-undefined optional prop.
  return render(<AppBreadcrumbs labels={labels ?? {}} />);
}

function crumbLabels(): string[] {
  const trail = screen.getByTestId("app-breadcrumbs");
  return Array.from(trail.querySelectorAll("li")).map((li) => {
    const link = li.querySelector("a");
    return (link ?? li.querySelector("[aria-current='page']"))?.textContent ?? "";
  });
}

describe("AppBreadcrumbs", () => {
  it("has nothing to say on the home page", () => {
    renderAt("/");

    expect(screen.queryByTestId("app-breadcrumbs")).toBeNull();
  });

  it("spells out the route families with their real names", () => {
    renderAt("/research/library");

    expect(crumbLabels()).toEqual(["首页", "研究与事实核查", "资料库"]);
  });

  it("labels a dynamic segment with the name the page knows", () => {
    renderAt("/research/0199e6d0/evidence", {
      "0199e6d0": "第四季度出货量是否真实增长"
    });

    expect(crumbLabels()).toEqual([
      "首页",
      "研究与事实核查",
      "第四季度出货量是否真实增长",
      "证据清单"
    ]);
  });

  it("falls back to the raw segment rather than dropping the crumb", () => {
    renderAt("/research/abc123");

    expect(crumbLabels()).toEqual(["首页", "研究与事实核查", "abc123"]);
  });

  it("makes the last crumb the current page instead of a link", () => {
    renderAt("/research/library");

    const trail = screen.getByTestId("app-breadcrumbs");
    expect(trail.querySelector("[aria-current='page']")?.textContent).toBe("资料库");
    // Home and the family root are the only links; the current page is not.
    expect(trail.querySelectorAll("a")).toHaveLength(2);
  });
});
