import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The front door has to name both surfaces.
 *
 * The page used to describe the arena and offer two buttons into it. Everything
 * else in the product — sources, citations, fact-check reports — was reachable
 * only from the nav, and the page's own copy never mentioned it. The headline
 * claim of a front door is "here is what this thing does"; if half of it is
 * missing, the other half is being presented as the whole product.
 *
 * These assertions are structural rather than textual: the copy will be edited,
 * but "both paths are present, each with its own entry points" must survive.
 *
 * The decision map is stubbed — this file is about information architecture,
 * and driving React Flow in jsdom would test the canvas, not the page.
 */

vi.mock("../components/decision-map", () => ({
  DecisionMap: () => null
}));

const { default: HomePage } = await import("./page");

const linksIn = (testId: string): string[] =>
  within(screen.getByTestId(testId))
    .getAllByRole("link")
    .map((link) => link.getAttribute("href") ?? "");

afterEach(() => {
  cleanup();
});

describe("首页 · 两条路径", () => {
  it("names both surfaces, not just the arena", () => {
    render(<HomePage />);

    expect(screen.getByTestId("entry-path-arena")).toBeTruthy();
    expect(screen.getByTestId("entry-path-research")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 3, name: "决策竞技场" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 3, name: "研究与事实核查" })
    ).toBeTruthy();
  });

  it("gives each surface its own entry points", () => {
    render(<HomePage />);

    expect(linksIn("entry-path-arena")).toEqual([
      "/sessions/new",
      "/sessions/demo"
    ]);
    // The research half must not fall back to an arena route: that was the
    // original defect, in one line.
    expect(linksIn("entry-path-research")).toEqual([
      "/research",
      "/research/library"
    ]);
  });

  it("does not link the same destination from both cards", () => {
    render(<HomePage />);

    const arena = linksIn("entry-path-arena");
    const research = linksIn("entry-path-research");
    expect(research.some((href) => arena.includes(href))).toBe(false);
  });

  it("keeps one h1 and files both paths under a section heading", () => {
    render(<HomePage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByRole("heading", { level: 2, name: "从哪里开始" })
    ).toBeTruthy();
  });
});
