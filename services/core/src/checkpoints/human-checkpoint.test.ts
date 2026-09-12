import { describe, expect, it } from "vitest";
import type { HumanDecision } from "@nexus/shared";
import { applyHumanDecision } from "./human-checkpoint";

function decision(
  action: HumanDecision["action"],
  newConclusion: string
): HumanDecision {
  return {
    id: "0198f3c0-0000-7000-8000-000000000001",
    sessionId: "0198f3c0-0000-7000-8000-000000000002",
    conflictId: "0198f3c0-0000-7000-8000-000000000003",
    action,
    rationale: "Evidence-based decision",
    affectedClaimIds: [],
    affectedAgentRoleIds: [],
    previousConclusion: "Limited due diligence",
    newConclusion,
    operatorId: "operator-1",
    createdAt: "2026-09-10T04:00:00.000Z"
  };
}

describe("applyHumanDecision", () => {
  it("closes an accepted or upheld checkpoint as decided", () => {
    expect(
      applyHumanDecision({
        decision: decision("accept_challenge", "Limited pilot"),
        currentPhase: "HUMAN_REVIEW"
      })
    ).toEqual({
      phase: "DECIDED",
      conclusion: "Limited pilot"
    });
  });

  it("returns a request for more analysis to reassessment", () => {
    expect(
      applyHumanDecision({
        decision: decision("request_more_analysis", "Request more evidence"),
        currentPhase: "HUMAN_REVIEW"
      })
    ).toEqual({
      phase: "REASSESSING",
      conclusion: "Request more evidence"
    });
  });
});