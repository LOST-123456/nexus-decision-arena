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
      "\u8d28\u8be2\u4f9d\u636e\u5145\u5206"
    );
    expect(onDecision).toHaveBeenNthCalledWith(
      2,
      "uphold_claim",
      "\u7ef4\u6301\u539f\u5224\u65ad"
    );
    expect(onDecision).toHaveBeenNthCalledWith(
      3,
      "request_more_analysis",
      "\u8865\u5145\u6750\u6599"
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
});