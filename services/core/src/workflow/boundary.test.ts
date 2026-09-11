import { describe, expect, it } from "vitest";
import {
  AgentRoleSchema,
  newId,
  type AgentRole,
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

const role = (key: AgentRole["key"]): AgentRole =>
  AgentRoleSchema.parse({
    id: newId(),
    key,
    name: key,
    goal: "Validate",
    perspective: "Evidence",
    evaluationCriteria: ["evidence"],
    evidenceRequired: ["source"],
    conflictPreference: ["evidence_gap"],
    lenses: ["market"],
    promptVersionId: newId()
  });

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

describe("claim selection boundaries", () => {
  it("clamps the selection limit to five", () => {
    const claims = Array.from({ length: 6 }, (_, index) =>
      claim(`claim ${index}`, 5, 0.5, 0)
    );

    expect(selectClaims(claims, 10)).toHaveLength(5);
  });

  it("treats a negative selection limit as zero", () => {
    const claims = [
      claim("first", 5, 0.5, 0),
      claim("second", 5, 0.5, 0)
    ];

    expect(selectClaims(claims, -1)).toHaveLength(0);
  });
});

describe("challenger assignment boundaries", () => {
  it("clamps the challenger limit to two", () => {
    const claimWithRole = {
      ...claim("market claim", 5, 0.4, 0),
      roleId: newId()
    };
    const roles = [
      role("finance_analyst"),
      role("risk_auditor"),
      role("technical_expert")
    ];

    expect(assignChallengers(claimWithRole, roles, 10)).toHaveLength(2);
  });

  it("deduplicates roles by key before selection", () => {
    const claimWithRole = {
      ...claim("market claim", 5, 0.4, 0),
      roleId: newId()
    };
    const roles = [
      role("finance_analyst"),
      role("finance_analyst"),
      role("risk_auditor")
    ];

    expect(assignChallengers(claimWithRole, roles, 2).map((item) => item.key))
      .toEqual(["finance_analyst", "risk_auditor"]);
  });
});

describe("conflict detection boundaries", () => {
  it("skips an unresolved challenge whose target claim is absent", () => {
    const challengeFixture = challenge(newId(), "unresolved", 5);

    const conflicts = detectConflicts({
      sessionId: newId(),
      claims: [],
      challenges: [challengeFixture]
    });

    expect(conflicts).toHaveLength(0);
  });
});
