import { describe, expect, it } from "vitest";
import {
  AgentRoleSchema,
  newId,
  type Challenge,
  type Claim
} from "@nexus/shared";
import { assignChallengers } from "./challenger-assigner";
import { selectClaims } from "./claim-selector";
import { detectConflicts } from "./conflict-detector";

const claim = (
  statement: string,
  importance: number,
  confidence: number,
  evidenceCount: number,
  type: Claim["type"] = "assumption"
): Claim => {
  const id = newId();
  return {
    id,
    sessionId: newId(),
    agentRunId: newId(),
    roleId: newId(),
    lens: "market",
    statement,
    type,
    stance: "support",
    importance: importance as Claim["importance"],
    confidence,
    evidenceIds: Array.from({ length: evidenceCount }, () => newId()),
    status: "proposed",
    rootClaimId: id,
    revision: 1,
    relations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
};

const challenge = (
  targetClaimId: string,
  status: Challenge["status"] = "unresolved",
  severity: number = 5
): Challenge => ({
  id: newId(),
  sessionId: newId(),
  targetClaimId,
  challengerRunId: newId(),
  challengerRoleId: newId(),
  type: "evidence_gap",
  question: "Where is the supporting evidence?",
  context: {
    triggerClaimIds: [targetClaimId],
    explanation: "The claim has no attached evidence."
  },
  requiredEvidence: ["source"],
  severity,
  resolutionStrategy: "provide_evidence",
  status,
  correlationId: newId(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

describe("claim selection", () => {
  it("prioritizes importance, evidence gaps, and lower confidence", () => {
    const highEvidence = claim("well supported", 5, 0.9, 3, "fact");
    const weakAssumption = claim("weak assumption", 5, 0.4, 0, "assumption");
    const lowerImportance = claim("secondary", 4, 0.2, 0, "assumption");

    expect(
      selectClaims([highEvidence, lowerImportance, weakAssumption], 2).map(
        (item) => item.id
      )
    ).toEqual([weakAssumption.id, highEvidence.id]);
  });
});

describe("challenger assignment", () => {
  it("assigns different roles deterministically", () => {
    const marketId = newId();
    const roles = [
      AgentRoleSchema.parse({
        id: marketId,
        key: "market_analyst",
        name: "Market Analyst",
        goal: "Validate demand",
        perspective: "Market evidence",
        evaluationCriteria: ["evidence"],
        evidenceRequired: ["source"],
        conflictPreference: ["evidence_gap"],
        lenses: ["market"],
        promptVersionId: newId()
      }),
      AgentRoleSchema.parse({
        id: newId(),
        key: "finance_analyst",
        name: "Finance Analyst",
        goal: "Validate economics",
        perspective: "Unit economics",
        evaluationCriteria: ["assumption"],
        evidenceRequired: ["model"],
        conflictPreference: ["assumption"],
        lenses: ["finance"],
        promptVersionId: newId()
      })
    ];
    const result = assignChallengers(
      { ...claim("market claim", 5, 0.4, 0), roleId: marketId },
      roles,
      1
    );

    expect(result[0]?.key).toBe("finance_analyst");
  });
});

describe("conflict detection", () => {
  it("detects a logic conflict from contradicting claims", () => {
    const left = claim("Claim A", 5, 0.8, 2, "fact");
    const right = claim("Claim B", 5, 0.8, 2, "fact");
    left.relations.push({ targetClaimId: right.id, type: "contradicts" });

    const conflicts = detectConflicts({
      sessionId: newId(),
      claims: [left, right],
      challenges: []
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.type).toBe("logic");
    expect(conflicts[0]?.claimIds).toEqual([left.id, right.id]);
  });

  it("detects an evidence conflict from an unresolved severe challenge", () => {
    const target = claim("Claim C", 5, 0.8, 0, "assumption");
    const challengeFixture = challenge(target.id, "unresolved", 4);

    const conflicts = detectConflicts({
      sessionId: newId(),
      claims: [target],
      challenges: [challengeFixture]
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.type).toBe("evidence");
    expect(conflicts[0]?.challengeIds).toEqual([challengeFixture.id]);
    expect(conflicts[0]?.claimIds).toEqual([target.id]);
    expect(conflicts[0]?.severity).toBe(4);
  });

  it("ignores challenges that are not unresolved or are below severity 4", () => {
    const target = claim("Claim D", 5, 0.8, 0, "assumption");

    const conflicts = detectConflicts({
      sessionId: newId(),
      claims: [target],
      challenges: [
        challenge(target.id, "open", 5),
        challenge(target.id, "unresolved", 3)
      ]
    });

    expect(conflicts).toHaveLength(0);
  });
  it("deduplicates reciprocal and self contradictions", () => {
    const left = claim("left", 5, 0.4, 0);
    const right = claim("right", 5, 0.4, 0);
    right.sessionId = left.sessionId;
    right.relations = [
      { targetClaimId: left.id, type: "contradicts" },
      { targetClaimId: right.id, type: "contradicts" }
    ];
    left.relations = [
      { targetClaimId: right.id, type: "contradicts" }
    ];

    const conflicts = detectConflicts({
      sessionId: left.sessionId,
      claims: [left, right],
      challenges: []
    });

    expect(conflicts).toHaveLength(1);
    expect(new Set(conflicts[0]?.claimIds)).toEqual(
      new Set([left.id, right.id])
    );
  });
});
