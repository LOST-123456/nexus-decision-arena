import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ActionLink, Button, HardActionLink } from "./button";

afterEach(() => cleanup());

describe("Button", () => {
  it("carries the shared action class", () => {
    render(<Button>重试</Button>);

    expect(screen.getByRole("button", { name: "重试" }).className).toContain(
      "workspace-retry"
    );
  });

  it("does not become a submit button by accident", () => {
    render(<Button>重试</Button>);

    expect(screen.getByRole("button").getAttribute("type")).toBe("button");
  });

  it("forwards the click handler", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>重试</Button>);

    fireEvent.click(screen.getByRole("button"));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps caller classes alongside the shared one", () => {
    render(<Button className="extra">重试</Button>);

    const className = screen.getByRole("button").className;
    expect(className).toContain("workspace-retry");
    expect(className).toContain("extra");
  });
});

describe("ActionLink", () => {
  it("renders an in-app link with the shared action class", () => {
    render(<ActionLink href="/history">返回最近会话</ActionLink>);

    const link = screen.getByRole("link", { name: "返回最近会话" });
    expect(link.getAttribute("href")).toBe("/history");
    expect(link.className).toContain("workspace-retry");
  });
});

describe("HardActionLink", () => {
  it("renders a plain anchor for the case with no router to navigate with", () => {
    render(<HardActionLink href="/">返回首页</HardActionLink>);

    const link = screen.getByRole("link", { name: "返回首页" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/");
    expect(link.className).toContain("workspace-retry");
  });
});
