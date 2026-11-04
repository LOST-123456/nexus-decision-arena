import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HumanCheckpoint } from "./human-checkpoint";

/**
 * This file renders the same panel several times, so each test must start from
 * an empty document — otherwise the button queries below match leftovers from
 * the previous render and report the wrong element.
 */
afterEach(cleanup);

describe("HumanCheckpoint", () => {
  it("submits each documented human action with a real button", () => {
    const onDecision = vi.fn();

    render(
      <HumanCheckpoint
        conflictSummary="Procurement evidence is missing"
        onDecision={onDecision}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "\u91c7\u7eb3\u8d28\u8be2" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "\u7ef4\u6301\u5224\u65ad" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "\u8981\u6c42\u8865\u5145\u5206\u6790" })
    );

    expect(onDecision).toHaveBeenNthCalledWith(
      1,
      "accept_challenge",
      "\u8d28\u8be2\u4f9d\u636e\u5145\u5206\uff0c\u63a5\u53d7\u8be5\u8d28\u8be2\u7ed3\u8bba\u3002",
      []
    );
    expect(onDecision).toHaveBeenNthCalledWith(
      2,
      "uphold_claim",
      "\u7ecf\u590d\u6838\u7ef4\u6301\u539f\u5224\u65ad\uff0c\u5e76\u4fdd\u7559\u6301\u7eed\u76d1\u6d4b\u8981\u6c42\u3002",
      []
    );
    expect(onDecision).toHaveBeenNthCalledWith(
      3,
      "request_more_analysis",
      "\u73b0\u6709\u8bc1\u636e\u4e0d\u8db3\u4ee5\u88c1\u51b3\uff0c\u8981\u6c42\u8865\u5145\u4e00\u8f6e\u5206\u6790\u3002",
      []
    );
  });

  it("labels preview-only decisions as non-persistent", () => {
    render(
      <HumanCheckpoint
        conflictSummary="Preview conflict"
        onDecision={vi.fn()}
        previewOnly
      />
    );

    expect(screen.getByText("PREVIEW / NOT PERSISTED")).toBeTruthy();
  });

  /**
   * The reported bug: "the two buttons next to 采纳质询 do nothing".
   *
   * They did submit — the decisions are in the database — but the panel gave no
   * sign of it: one click greyed out all three buttons with unchanged labels,
   * the request then blocked for 25 seconds, and the panel came back looking
   * identical. These tests pin the three signals that tell the user otherwise.
   */
  it("shows which action is in flight and why the other two are closed", () => {
    render(
      <HumanCheckpoint
        conflictSummary="Procurement evidence is missing"
        onDecision={vi.fn()}
        pendingAction="request_more_analysis"
      />
    );

    const inFlight = screen.getByRole("button", { name: "提交中…" });
    expect(inFlight.getAttribute("aria-busy")).toBe("true");

    for (const name of ["采纳质询", "维持判断"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      // Disabled without an explanation is indistinguishable from broken.
      expect(button.getAttribute("title")).toContain("完成后才能再选");
    }

    expect(screen.getByRole("status").textContent).toContain("补充的一轮分析");
  });

  it("ignores clicks while a decision is in flight", () => {
    const onDecision = vi.fn();
    render(
      <HumanCheckpoint
        conflictSummary="Conflict"
        onDecision={onDecision}
        pendingAction="uphold_claim"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "采纳质询" }));
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("proves the previous decision took effect", () => {
    render(
      <HumanCheckpoint
        conflictSummary="Conflict"
        onDecision={vi.fn()}
        lastOutcome={{
          action: "request_more_analysis",
          previousConclusion: "建议立项",
          conclusion: "重新评估采购证据"
        }}
      />
    );

    const receipt =
      screen.getByText(/上一步/).closest("p")?.textContent ?? "";
    expect(receipt).toContain("要求补充分析");
    expect(receipt).toContain("建议立项");
    expect(receipt).toContain("重新评估采购证据");
  });

  it("says which round it is and how many conflicts are left", () => {
    render(
      <HumanCheckpoint
        conflictSummary="Conflict"
        conflictType="evidence"
        onDecision={vi.fn()}
        round={2}
        queue={{ position: 3, total: 20 }}
      />
    );

    expect(screen.getByText("第 2 轮")).toBeTruthy();
    expect(screen.getByText("本轮待裁决 3 / 20")).toBeTruthy();
    expect(screen.getByText("证据缺口")).toBeTruthy();
  });

  it("announces a rejection instead of swallowing it", () => {
    render(
      <HumanCheckpoint
        conflictSummary="Conflict"
        onDecision={vi.fn()}
        errorMessage="该质询已不再等待人工裁决"
      />
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "该质询已不再等待人工裁决"
    );
  });
});