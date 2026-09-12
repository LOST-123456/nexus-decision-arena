import { describe, expect, it } from "vitest";
import { newId, type Challenge, type Claim, type Conflict } from "@nexus/shared";
import { DecisionReplay } from "./decision-replay";

const timestamp = "2026-09-10T04:00:00.000Z";

describe("DecisionReplay", () => {
  it("returns the exact state at a selected event sequence", () => {
    const sessionId = newId();
    const replay = new DecisionReplay([
      {
        id: newId(),
        sessionId,
        sequence: 1,
        correlationId: newId(),
        type: "SESSION_STATE_CHANGED",
        payload: { phase: "PLANNING" },
        occurredAt: timestamp
      },
      {
        id: newId(),
        sessionId,
        sequence: 2,
        correlationId: newId(),
        type: "SESSION_STATE_CHANGED",
        payload: {
          phase: "ANALYZING",
          operationalStatus: "ACTIVE",
          currentConclusion: "Initial conclusion"
        },
        occurredAt: timestamp
      }
    ]);

    expect(replay.snapshotAt(1)).toMatchObject({
      phase: "PLANNING",
      currentConclusion: null
    });
    expect(replay.snapshotAt(2)).toMatchObject({
      phase: "ANALYZING",
      currentConclusion: "Initial conclusion"
    });
  });

  it("reconstructs entities and updates without mutating source events", () => {
    const sessionId = newId();
    const claimId = newId();
    const challengeId = newId();
    const conflictId = newId();
    const claim: Claim = {
      id: claimId,
      sessionId,
      agentRunId: newId(),
      roleId: newId(),
      lens: "market",
      statement: "The growth target lacks evidence",
      type: "assumption",
      stance: "oppose",
      importance: 5,
      confidence: 0.2,
      evidenceIds: [],
      status: "proposed",
      rootClaimId: claimId,
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const challenge: Challenge = {
      id: challengeId,
      sessionId,
      targetClaimId: claimId,
      challengerRunId: newId(),
      challengerRoleId: newId(),
      type: "evidence_gap",
      question: "Where is the procurement evidence?",
      context: {
        triggerClaimIds: [claimId],
        explanation: "The growth target lacks evidence."
      },
      requiredEvidence: ["Procurement pipeline"],
      severity: 5,
      resolutionStrategy: "provide_evidence",
      status: "open",
      correlationId: newId(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const conflict: Conflict = {
      id: conflictId,
      sessionId,
      claimIds: [claimId],
      challengeIds: [challengeId],
      type: "evidence",
      summary: "Procurement evidence is missing",
      severity: 5,
      status: "human_review",
      humanDecisionRequired: true,
      resolutionSuggestion: "Adopt the challenge",
      impactScope: {
        analysisAreas: ["market", "finance"],
        stakeholders: ["Project team"]
      },
      createdAt: timestamp,
      updatedAt: timestamp
    };
    const events = [
      {
        id: newId(),
        sessionId,
        sequence: 3,
        correlationId: newId(),
        type: "CLAIM_CREATED" as const,
        payload: claim,
        occurredAt: timestamp
      },
      {
        id: newId(),
        sessionId,
        sequence: 2,
        correlationId: newId(),
        type: "CHALLENGE_CREATED" as const,
        payload: challenge,
        occurredAt: timestamp
      },
      {
        id: newId(),
        sessionId,
        sequence: 4,
        correlationId: newId(),
        type: "CONFLICT_DETECTED" as const,
        payload: conflict,
        occurredAt: timestamp
      },
      {
        id: newId(),
        sessionId,
        sequence: 5,
        correlationId: newId(),
        type: "HUMAN_REVIEW_REQUIRED" as const,
        payload: { conflictId },
        occurredAt: timestamp
      }
    ];
    const snapshot = new DecisionReplay(events).snapshotAt(3);

    expect(snapshot.claims).toEqual([claim]);
    snapshot.claims[0]!.statement = "mutated";
    expect(claim.statement).toBe("The growth target lacks evidence");
    expect(snapshot.challenges).toEqual([challenge]);
    expect(snapshot.conflicts).toEqual([]);
    expect(events.map((event) => event.sequence)).toEqual([3, 2, 4, 5]);

    expect(new DecisionReplay(events).snapshotAt(5)).toMatchObject({
      phase: "HUMAN_REVIEW",
      operationalStatus: "PAUSED",
      conflicts: [conflict]
    });
  });
});
