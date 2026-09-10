import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  ClaimSchema,
  ConflictSchema,
  EvidenceSchema,
  ExecutionEventSchema,
  newId
} from "../index";

describe("decision domain schemas", () => {
  it("accepts a valid Claim", () => {
    const id = newId();
    const claim = ClaimSchema.parse({
      id,
      sessionId: newId(),
      agentRunId: newId(),
      roleId: newId(),
      lens: "market-size",
      statement: "The two-year target is not supported by current evidence.",
      type: "assumption",
      stance: "oppose",
      importance: 5,
      confidence: 0.74,
      evidenceIds: [],
      status: "proposed",
      rootClaimId: id,
      revision: 1,
      relations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    expect(claim.revision).toBe(1);
  });

  it("rejects confidence outside 0..1", () => {
    expect(() =>
      EvidenceSchema.parse({
        id: newId(),
        sessionId: newId(),
        claimId: newId(),
        kind: "calculation",
        title: "Invalid confidence",
        content: "invalid",
        description: "invalid",
        direction: "supports",
        reliability: 2,
        verificationStatus: "unverified",
        retrievedAt: new Date().toISOString(),
        createdBy: "agent"
      })
    ).toThrow();
  });

  it("requires an event correlation ID", () => {
    expect(() =>
      ExecutionEventSchema.parse({
        id: newId(),
        sessionId: newId(),
        sequence: 1,
        type: "SESSION_STATE_CHANGED",
        payload: {},
        occurredAt: new Date().toISOString()
      })
    ).toThrow();
  });

  it("accepts a high-severity challenge", () => {
    expect(
      ChallengeSchema.parse({
        id: newId(),
        sessionId: newId(),
        targetClaimId: newId(),
        challengerRunId: newId(),
        challengerRoleId: newId(),
        type: "evidence_gap",
        question: "Where is the source for 200 labs?",
        context: {
          triggerClaimIds: [newId()],
          explanation: "The growth target drives the revenue forecast."
        },
        requiredEvidence: ["Procurement pipeline"],
        severity: 5,
        resolutionStrategy: "provide_evidence",
        status: "open",
        correlationId: newId(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }).severity
    ).toBe(5);
  });

  it("rejects a conflict without a human requirement field", () => {
    expect(() =>
      ConflictSchema.parse({
        id: newId(),
        sessionId: newId(),
        claimIds: [newId(), newId()],
        challengeIds: [],
        type: "evidence",
        summary: "Conflicting growth assumptions",
        severity: 4,
        status: "detected",
        resolutionSuggestion: "Request procurement evidence",
        impactScope: {
          analysisAreas: ["market", "finance"],
          stakeholders: ["Project team"]
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      })
    ).toThrow();
  });
});
