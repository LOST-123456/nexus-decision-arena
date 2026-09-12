import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Timeline } from "./timeline";

describe("Timeline", () => {
  it("selects a historical sequence with a real button", () => {
    const onSelect = vi.fn();

    render(
      <Timeline
        events={[
          { id: "event-1", sequence: 1, type: "SESSION_STATE_CHANGED" },
          { id: "event-8", sequence: 8, type: "CLAIM_CREATED" }
        ]}
        selectedSequence={8}
        onSelect={onSelect}
      />
    );

    const historical = screen.getByRole("button", {
      name: /Sequence 1 SESSION_STATE_CHANGED/i
    });
    expect(historical.getAttribute("aria-current")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /Sequence 8 CLAIM_CREATED/i })
        .getAttribute("aria-current")
    ).toBe("step");

    fireEvent.click(historical);
    expect(onSelect).toHaveBeenCalledWith(1);
  });
});
