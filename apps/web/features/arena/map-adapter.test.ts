import { describe, expect, it } from "vitest";
import type {
  AgentRole,
  Challenge,
  Claim,
  Conflict
} from "@nexus/shared";
import { newId } from "@nexus/shared";
import type { ReplayableSession } from "./event-reducer";
import {
  DECISION_MAP_EDGE_LEGEND,
  DECISION_MAP_EDGE_SEMANTICS,
  getDecisionMapEdgeVisualSignature,
  toDecisionMap
} from "./map-adapter";

const timestamp = new Date().toISOString();

function baseSession(
  overrides: Partial<ReplayableSession> = {}
): ReplayableSession {
  return {
    sessionId: newId(),
    phase: "ANALYZING",
    operationalStatus: "ACTIVE",
    agents: [],
    claims: [],
    evidence: [],
    challenges: [],
    conflicts: [],
    humanDecisions: [],
    currentConclusion: null,
    lastSequence: 10,
    ...overrides
  };
}

function claim(input: {
  id?: string;
  status: Claim["status"];
  stance?: Claim["stance"];
  roleId?: string;
}): Claim {
  const id = input.id ?? newId();
  return {
    id,
    sessionId: newId(),
    agentRunId: newId(),
    roleId: input.roleId ?? newId(),
    lens: "test",
    statement: `Claim ${input.status}`,
    type: "recommendation",
    stance: input.stance ?? "neutral",
    importance: 4,
    confidence: 0.7,
    evidenceIds: [],
    status: input.status,
    rootClaimId: id,
    revision: 1,
    relations: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function challenge(input: {
  id?: string;
  targetClaimId: string;
  status: Challenge["status"];
}): Challenge {
  return {
    id: input.id ?? newId(),
    sessionId: newId(),
    targetClaimId: input.targetClaimId,
    challengerRunId: newId(),
    challengerRoleId: newId(),
    type: "evidence_gap",
    question: "Is the evidence complete?",
    context: {
      triggerClaimIds: [input.targetClaimId],
      explanation: "Evidence coverage must be verified."
    },
    requiredEvidence: ["source evidence"],
    severity: 5,
    resolutionStrategy: "provide_evidence",
    status: input.status,
    correlationId: newId(),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function conflict(
  type: Conflict["type"] = "evidence"
): Conflict {
  return {
    id: newId(),
    sessionId: newId(),
    claimIds: [newId()],
    challengeIds: [],
    type,
    summary: "Unsupported growth target",
    severity: 5,
    status: "human_review",
    humanDecisionRequired: true,
    resolutionSuggestion: "Request evidence",
    impactScope: {
      analysisAreas: ["market", "finance"],
      stakeholders: ["Project team"]
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

describe("Decision Map adapter", () => {
  it("creates a conflict node and an animated conflict edge", () => {
    const result = toDecisionMap(
      baseSession({
        phase: "CONFLICT_DETECTED",
        conflicts: [conflict()],
        currentConclusion: "Hold scale-up",
        lastSequence: 10
      })
    );

    expect(result.nodes.some((node) => node.type === "conflict")).toBe(true);
    expect(result.edges.some((edge) => edge.animated)).toBe(true);
  });

  it("uses the conflict semantic color and accessible label", () => {
    const currentConflict = conflict("priority");
    const result = toDecisionMap(
      baseSession({
        phase: "HUMAN_REVIEW",
        operationalStatus: "PAUSED",
        conflicts: [currentConflict],
        currentConclusion: "Hold scale-up",
        lastSequence: 12
      })
    );

    const edge = result.edges.find(
      (candidate) =>
        candidate.id === `conflict-edge:${currentConflict.id}`
    );

    expect(edge).toMatchObject({
      animated: true,
      type: "smoothstep",
      style: { stroke: "var(--warning)" }
    });
    expect(edge?.ariaLabel).toBeTruthy();
  });

  it("keeps every edge semantic legend entry unique and complete", () => {
    const semantics = [
      "neutral",
      "running",
      "supports",
      "opposes",
      "challenged",
      "conflict",
      "resolved",
      "failed",
      "rejected"
    ] as const;
    const legendSemantics = DECISION_MAP_EDGE_LEGEND.map(
      (entry) => entry.semantic
    );

    expect([...DECISION_MAP_EDGE_SEMANTICS]).toEqual([...semantics]);
    expect(legendSemantics).toEqual(semantics);
    expect(new Set(legendSemantics).size).toBe(semantics.length);
    expect(
      new Set(DECISION_MAP_EDGE_LEGEND.map((entry) => entry.label)).size
    ).toBe(semantics.length);
    expect(
      new Set(
        semantics.map((semantic) =>
          getDecisionMapEdgeVisualSignature(semantic)
        )
      ).size
    ).toBe(semantics.length);
    expect(
      DECISION_MAP_EDGE_LEGEND.every(
        (entry) => entry.color.length > 0 && entry.strokeWidth > 0
      )
    ).toBe(true);

    const running = DECISION_MAP_EDGE_LEGEND.find(
      (entry) => entry.semantic === "running"
    );
    const supports = DECISION_MAP_EDGE_LEGEND.find(
      (entry) => entry.semantic === "supports"
    );

    expect({
      color: running?.color,
      dashArray: running?.dashArray,
      markerEnd: running?.markerEnd
    }).not.toEqual({
      color: supports?.color,
      dashArray: supports?.dashArray,
      markerEnd: supports?.markerEnd
    });
  });
  it("maps every Claim status to its own semantic node status", () => {
    const statuses: Claim["status"][] = [
      "proposed",
      "supported",
      "accepted",
      "contested",
      "rejected"
    ];
    const claims = statuses.map((status) => claim({ status }));
    const result = toDecisionMap(baseSession({ claims }));
    const expected = [
      "proposed",
      "supported",
      "completed",
      "challenged",
      "rejected"
    ];

    expect(
      claims.map(
        (currentClaim) =>
          result.nodes.find(
            (node) => node.id === `claim:${currentClaim.id}`
          )?.data.status
      )
    ).toEqual(expected);
  });

  it("derives Agent node state from runtime state, not Claim stance", () => {
    const agent: AgentRole & { status: "completed" } = {
      id: newId(),
      key: "market_analyst",
      name: "Market Analyst",
      goal: "Validate demand",
      perspective: "Market evidence",
      evaluationCriteria: ["demand"],
      evidenceRequired: ["pipeline"],
      conflictPreference: ["evidence_gap"],
      lenses: ["market"],
      promptVersionId: newId(),
      status: "completed"
    };
    const currentClaim = claim({
      status: "supported",
      stance: "oppose",
      roleId: agent.id
    });
    const result = toDecisionMap(
      baseSession({ agents: [agent], claims: [currentClaim] })
    );
    const agentNode = result.nodes.find(
      (node) => node.id === `agent:${agent.id}`
    );
    const provenanceEdge = result.edges.find(
      (edge) => edge.id === `agent-claim:${agent.id}:${currentClaim.id}`
    );

    expect(agentNode?.data.status).toBe("completed");
    expect(provenanceEdge?.data?.semantic).toBe("opposes");
    expect(provenanceEdge?.ariaLabel).toBeTruthy();
  });

  it("maps unresolved Challenges to challenged, never failed", () => {
    const currentClaim = claim({ status: "supported" });
    const currentChallenge = challenge({
      targetClaimId: currentClaim.id,
      status: "unresolved"
    });
    const result = toDecisionMap(
      baseSession({
        claims: [currentClaim],
        challenges: [currentChallenge]
      })
    );
    const challengeNode = result.nodes.find(
      (node) => node.id === `challenge:${currentChallenge.id}`
    );
    const challengeEdge = result.edges.find(
      (edge) => edge.id === `challenge-edge:${currentChallenge.id}`
    );

    expect(challengeNode?.data.status).toBe("challenged");
    expect(challengeEdge?.data?.semantic).toBe("challenged");
    expect(challengeEdge?.ariaLabel).toBeTruthy();
  });
});
