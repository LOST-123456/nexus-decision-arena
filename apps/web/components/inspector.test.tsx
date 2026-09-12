import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { Inspector } from "./inspector";

describe("Inspector", () => {
  it("shows the structured decision rationale", () => {
    render(
      <Inspector
        data={{
          claim: {
            id: newId(),
            statement: "The growth target lacks evidence",
            status: "contested"
          },
          evidence: [],
          challenges: [],
          conflicts: [],
          decisionRationale: {
            outcome: "contested",
            summary: "Procurement evidence is still missing.",
            decisiveChallengeIds: [],
            evidenceIds: []
          }
        }}
      />
    );

    expect(
      screen.getByText("Procurement evidence is still missing.")
    ).toBeTruthy();
    expect(screen.getByText("DECISION RATIONALE")).toBeTruthy();
  });
});
