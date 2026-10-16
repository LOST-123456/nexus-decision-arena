import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FullPageNotice, Notice } from "./notice";

afterEach(() => cleanup());

describe("Notice", () => {
  it("renders the full skeleton", () => {
    render(
      <Notice
        eyebrow="404 / NOT FOUND"
        title="页面不存在"
        reason="原因"
        hint="提示"
        actions={
          <button type="button">重试</button>
        }
      />
    );

    expect(screen.getByText("404 / NOT FOUND")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "页面不存在" })).toBeTruthy();
    expect(screen.getByText("原因")).toBeTruthy();
    expect(screen.getByText("提示")).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("defaults to the danger tone, which is the panel's own base styling", () => {
    const { container } = render(<Notice eyebrow="E" title="T" />);

    expect(
      container.querySelector(".workspace-notice")?.getAttribute("data-tone")
    ).toBe("danger");
  });

  it("omits the reason, the hint and the actions row when there is nothing to say", () => {
    const { container } = render(<Notice eyebrow="E" title="T" />);

    expect(container.querySelector(".workspace-notice-reason")).toBeNull();
    expect(container.querySelector(".workspace-notice-hint")).toBeNull();
    expect(container.querySelector(".workspace-notice-actions")).toBeNull();
  });

  it("carries the tone and the live-region wiring through", () => {
    const { container } = render(
      <Notice
        eyebrow="LOADING"
        title="正在载入"
        tone="loading"
        role="status"
        live="polite"
      />
    );
    const section = container.querySelector(".workspace-notice");

    expect(section?.getAttribute("data-tone")).toBe("loading");
    expect(section?.getAttribute("role")).toBe("status");
    expect(section?.getAttribute("aria-live")).toBe("polite");
  });

  it("leaves role off when the panel is not announcing anything", () => {
    const { container } = render(<Notice eyebrow="E" title="T" />);

    expect(
      container.querySelector(".workspace-notice")?.hasAttribute("role")
    ).toBe(false);
  });
});

describe("FullPageNotice", () => {
  it("makes the panel the landmark the skip link points at", () => {
    render(<FullPageNotice testId="not-found" eyebrow="E" title="T" />);

    const main = screen.getByTestId("not-found");
    expect(main.tagName).toBe("MAIN");
    expect(main.id).toBe("main");
    // Focus has to be movable onto it for the skip link to do more than scroll.
    expect(main.getAttribute("tabindex")).toBe("-1");
    expect(main.className).toContain("workspace-fallback");
  });
});
