import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppNavDrawer } from "./app-nav-drawer";

/**
 * The phone-sized navigation, checked against the real component with only
 * `next/link` faked.
 *
 * What is pinned down here is the modal contract: focus moves into the drawer,
 * Escape and the backdrop close it, focus goes back to the trigger, and the
 * drawer is gone from the DOM while closed so a keyboard user cannot tab into
 * a menu that is not there.
 */

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href?: unknown; children?: React.ReactNode }) =>
      createElement("a", { href: String(href), ...rest }, children)
  };
});

const LINKS = [
  { href: "/history", label: "最近会话" },
  { href: "/research", label: "研究与事实核查" },
  { href: "/research/library", label: "资料库" }
];

afterEach(() => cleanup());

function openDrawer(props: Partial<React.ComponentProps<typeof AppNavDrawer>> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <AppNavDrawer
      open
      pathname="/research/library"
      links={LINKS}
      onClose={onClose}
      {...props}
    />
  );
  return { ...utils, onClose };
}

describe("AppNavDrawer", () => {
  it("renders nothing while closed", () => {
    const { container } = render(
      <AppNavDrawer open={false} pathname="/" links={LINKS} onClose={() => undefined} />
    );

    expect(container.querySelector("[data-testid='app-nav-drawer']")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus onto the close control, not onto a destination", () => {
    openDrawer();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
  });

  it("labels itself as a modal dialog and points at the primary nav", () => {
    openDrawer();

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("导航");
    expect(screen.getByRole("navigation", { name: "主导航" })).toBeTruthy();
  });

  it("marks exactly one destination as the current page", () => {
    openDrawer();

    expect(
      screen.getByRole("link", { name: "资料库" }).getAttribute("aria-current")
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "研究与事实核查" }).getAttribute("aria-current")
    ).toBeNull();
  });

  it("closes on Escape", () => {
    const { onClose } = openDrawer();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a backdrop press but not on a press inside the panel", () => {
    const { onClose } = openDrawer();
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement!;

    fireEvent.mouseDown(dialog);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hands focus back to the trigger when it closes", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();

    const { rerender } = render(
      <AppNavDrawer open={false} pathname="/" links={LINKS} onClose={() => undefined} />
    );
    rerender(
      <AppNavDrawer open pathname="/" links={LINKS} onClose={() => undefined} />
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));

    rerender(
      <AppNavDrawer open={false} pathname="/" links={LINKS} onClose={() => undefined} />
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("closes itself when the route changes, so it never covers the new page", () => {
    // The drawer is controlled, so this checks the whole loop: it asks to
    // close, the parent that owns the state honors it, and the drawer leaves
    // the DOM — which is what a phone reader sees after tapping a destination.
    function Phone() {
      const [open, setOpen] = React.useState(true);
      const [pathname, setPathname] = React.useState("/research");
      return (
        <>
          <AppNavDrawer
            open={open}
            pathname={pathname}
            links={LINKS}
            onClose={() => setOpen(false)}
          />
          <button type="button" onClick={() => setPathname("/history")}>
            去最近会话
          </button>
        </>
      );
    }

    render(<Phone />);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "去最近会话" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Tab inside the drawer", () => {
    openDrawer();

    screen.getByRole("link", { name: "资料库" }).focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });

    // Wraps forward from the last control to the first.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
  });
});
