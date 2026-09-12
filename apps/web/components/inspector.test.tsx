import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { newId, type ClaimInspectorDTO } from "@nexus/shared";
import { Inspector } from "./inspector";

function inspectorFixture(): ClaimInspectorDTO {
  const id = newId();
  const timestamp = new Date().toISOString();
  return {
    claim: {
      id,
      sessionId: newId(),
      agentRunId: newId(),
      roleId: newId(),
      lens: "market",
      statement: "The growth target lacks evidence",
      type: "assumption",
      stance: "oppose",
      importance: 5,
      confidence: 0.2,
      evidenceIds: [],
      status: "contested",
      rootClaimId: id,
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    evidence: [],
    challenges: [],
    conflicts: [],
    provenance: {
      agentRun: undefined,
      promptVersion: undefined
    },
    decisionRationale: {
      outcome: "contested",
      summary: "Procurement evidence is still missing.",
      decisiveChallengeIds: [],
      evidenceIds: []
    }
  };
}

describe("Inspector", () => {
  it("shows the structured decision rationale", () => {
    render(<Inspector data={inspectorFixture()} />);

    expect(
      screen.getByText("Procurement evidence is still missing.")
    ).toBeTruthy();
    expect(screen.getByText("DECISION RATIONALE")).toBeTruthy();
  });
});