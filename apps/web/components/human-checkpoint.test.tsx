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
});