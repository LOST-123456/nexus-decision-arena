import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HumanCheckpoint } from "./human-checkpoint";

describe("HumanCheckpoint", () => {
  it("submits each documented human action with a real button", () => {
    const onDecision = vi.fn();

    render(
      <HumanCheckpoint
        conflictSummary="Procurement evidence is missing"
        onDecision={onDecision}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "采纳质询" }));
    fireEvent.click(screen.getByRole("button", { name: "维持判断" }));
    fireEvent.click(screen.getByRole("button", { name: "要求补充分析" }));

    expect(onDecision).toHaveBeenNthCalledWith(
      1,
      "accept_challenge",
      "质询依据充分"
    );
    expect(onDecision).toHaveBeenNthCalledWith(
      2,
      "uphold_claim",
      "维持原判断"
    );
    expect(onDecision).toHaveBeenNthCalledWith(
      3,
      "request_more_analysis",
      "补充材料"
    );
  });
});
