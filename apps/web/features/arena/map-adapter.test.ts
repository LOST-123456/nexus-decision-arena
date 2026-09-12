import { describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { toDecisionMap } from "./map-adapter";

describe("Decision Map adapter", () => {
  it("creates a conflict node and an animated conflict edge", () => {
    const result = toDecisionMap({
      sessionId: newId(),
      phase: "CONFLICT_DETECTED",
      operationalStatus: "ACTIVE",
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [
        {
          id: newId(),
          sessionId: newId(),
          claimIds: [newId()],
          challengeIds: [],
          type: "evidence",
          summary: "Unsupported growth target",
          severity: 5,
          status: "human_review",
          humanDecisionRequired: true,
          resolutionSuggestion: "Request evidence",
          impactScope: {
            analysisAreas: ["market", "finance"],
            stakeholders: ["Project team"]
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      humanDecisions: [],
      currentConclusion: "暂缓规模化",
      lastSequence: 10
    });

    expect(result.nodes.some((node) => node.type === "conflict")).toBe(true);
    expect(result.edges.some((edge) => edge.animated)).toBe(true);
  });

  it("uses the conflict semantic color for unresolved conflict edges", () => {
    const conflictId = newId();
    const result = toDecisionMap({
      sessionId: newId(),
      phase: "HUMAN_REVIEW",
      operationalStatus: "PAUSED",
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [
        {
          id: conflictId,
          sessionId: newId(),
          claimIds: [newId()],
          challengeIds: [],
          type: "priority",
          summary: "Pilot scope conflicts with the scale target",
          severity: 5,
          status: "human_review",
          humanDecisionRequired: true,
          resolutionSuggestion: "Approve a limited pilot",
          impactScope: {
            analysisAreas: ["operations"],
            stakeholders: ["Project team"]
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      humanDecisions: [],
      currentConclusion: "暂缓规模化",
      lastSequence: 12
    });

    const edge = result.edges.find(
      (candidate) => candidate.id === `conflict-edge:${conflictId}`
    );

    expect(edge).toMatchObject({
      animated: true,
      type: "smoothstep",
      style: { stroke: "var(--warning)" }
    });
  });
});
