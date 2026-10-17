import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog, type ConfirmDialogProps } from "./dialog";

afterEach(() => cleanup());

function Harness(props: Partial<ConfirmDialogProps>) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        打开确认
      </button>
      <ConfirmDialog
        open={open}
        title="撤销共享授权"
        description="该账号将立即失去访问权限。"
        confirmLabel="撤销"
        onConfirm={props.onConfirm ?? (() => setOpen(false))}
        onCancel={() => setOpen(false)}
        {...props}
      />
    </div>
  );
}

function openDialog(props: Partial<ConfirmDialogProps> = {}) {
  const utils = render(<Harness {...props} />);
  const trigger = screen.getByRole("button", { name: "打开确认" });
  // jsdom does not move focus on a synthetic click the way a real pointer
  // press does, so the trigger is focused explicitly — otherwise there is no
  // "whatever opened it" to hand focus back to.
  trigger.focus();
  fireEvent.click(trigger);
  return utils;
}

describe("ConfirmDialog", () => {
  it("renders nothing while closed", () => {
    render(<Harness />);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("wires the title and the description to the dialog for assistive tech", () => {
    openDialog();

    const dialog = screen.getByRole("dialog");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    const describedBy = dialog.getAttribute("aria-describedby");

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(labelledBy).toBeTruthy();
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe("撤销共享授权");
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      "该账号将立即失去访问权限。"
    );
  });

  it("moves focus onto the safe control, not the destructive one", () => {
    openDialog();

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  });

  it("hands focus back to whatever opened it", () => {
    openDialog();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "打开确认" })
    );
  });

  it("cancels on Escape", () => {
    const onCancel = vi.fn();
    openDialog({ onCancel });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("keeps Escape from dismissing while the action is in flight", () => {
    const onCancel = vi.fn();
    openDialog({ onCancel, busy: true });

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("wraps Tab forward from the last control to the first", () => {
    openDialog();

    screen.getByRole("button", { name: "撤销" }).focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "取消" }));
  });

  it("wraps Shift+Tab backward from the first control to the last", () => {
    openDialog();

    screen.getByRole("button", { name: "取消" }).focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "撤销" }));
  });

  it("cancels on a backdrop press but not on a press inside the panel", () => {
    const onCancel = vi.fn();
    openDialog({ onCancel });
    const dialog = screen.getByRole("dialog");
    // The panel carries the dialog role; the backdrop is its parent.
    const backdrop = dialog.parentElement!;

    fireEvent.mouseDown(dialog);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.mouseDown(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("confirms, and locks both controls while the action is in flight", () => {
    const onConfirm = vi.fn();
    openDialog({ onConfirm, busy: true });

    const confirm = screen.getByRole("button", { name: "处理中…" }) as HTMLButtonElement;
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("marks the confirm control as destructive on the danger tone", () => {
    openDialog();

    expect(
      screen.getByRole("button", { name: "撤销" }).className
    ).toContain("dialog-confirm-danger");
  });

  it("keeps the accent styling on the neutral tone", () => {
    openDialog({ tone: "neutral", confirmLabel: "知道了" });

    expect(
      screen.getByRole("button", { name: "知道了" }).className
    ).not.toContain("dialog-confirm-danger");
  });

  it("locks the page behind it and gives the scroll back", () => {
    openDialog();

    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(document.body.style.overflow).toBe("");
  });
});
