import { describe, expect, it } from "vitest";
import {
  canTransitionConflict,
  ClaimSchema,
  ConflictSchema,
  CONFLICT_STATUSES,
  decisionWritebackPlan,
  DecisionWritebackError,
  EvidenceSchema,
  hasVerifiedEvidence,
  isConflictAwaitingHumanDecision,
  isFinalConflictStatus,
  newId,
  nextConflictStatusForDecision,
  resolveUpheldClaimStatus,
  transitionConflictStatus
} from "../index";
import type { Claim, Conflict, ConflictStatus, Evidence } from "../index";

const timestamp = new Date().toISOString();

function baseClaim(overrides: Partial<Claim> = {}): Claim {
  const id = overrides.id ?? newId();
  return ClaimSchema.parse({
    id,
    sessionId: newId(),
    agentRunId: newId(),
    roleId: newId(),
    lens: "market",
    statement: "The growth target lacks evidence.",
    type: "assumption",
    stance: "oppose",
    importance: 3,
    confidence: 0.4,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: id,
    revision: 1,
    relations: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  });
}

function baseConflict(
  claimIds: string[],
  status: ConflictStatus = "human_review",
  overrides: Partial<Conflict> = {}
): Conflict {
  return ConflictSchema.parse({
    id: newId(),
    sessionId: newId(),
    claimIds,
    challengeIds: [],
    type: "evidence",
    summary: "Procurement evidence is missing.",
    severity: 5,
    status,
    humanDecisionRequired: true,
    resolutionSuggestion: "Adopt the challenge.",
    impactScope: { analysisAreas: ["market"], stakeholders: ["Project team"] },
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides
  });
}

function baseEvidence(
  claimId: string,
  verificationStatus: Evidence["verificationStatus"]
): Evidence {
  return EvidenceSchema.parse({
    id: newId(),
    sessionId: newId(),
    claimId,
    kind: "calculation",
    title: "Procurement pipeline",
    content: "Derived from the signed pipeline.",
    description: "Calculated from the project input.",
    direction: "supports",
    reliability: 0.8,
    verificationStatus,
    retrievedAt: timestamp,
    createdBy: "system"
  });
}

describe("conflict state machine", () => {
  it("exposes every conflict status exactly once", () => {
    expect(CONFLICT_STATUSES).toEqual([
      "detected",
      "human_review",
      "resolved"
    ]);
  });

  it("allows the review and resolution transitions", () => {
    expect(canTransitionConflict("detected", "human_review")).toBe(true);
    expect(canTransitionConflict("detected", "resolved")).toBe(true);
    expect(canTransitionConflict("human_review", "resolved")).toBe(true);
    expect(canTransitionConflict("human_review", "detected")).toBe(true);
  });

  it("treats resolved as terminal", () => {
    expect(canTransitionConflict("resolved", "detected")).toBe(false);
    expect(canTransitionConflict("resolved", "human_review")).toBe(false);
    expect(isFinalConflictStatus("resolved")).toBe(true);
    expect(isFinalConflictStatus("detected")).toBe(false);
  });

  it("throws from transitionConflictStatus on an illegal move", () => {
    expect(() => transitionConflictStatus("resolved", "detected")).toThrow(
      /Invalid conflict transition/
    );
    expect(transitionConflictStatus("detected", "human_review")).toBe(
      "human_review"
    );
  });

  it("maps a human action onto the conflict status", () => {
    expect(nextConflictStatusForDecision("accept_challenge")).toBe("resolved");
    expect(nextConflictStatusForDecision("uphold_claim")).toBe("resolved");
    expect(nextConflictStatusForDecision("request_more_analysis")).toBe(
      "detected"
    );
  });

  it("does not treat a resolved conflict as an open checkpoint", () => {
    expect(isConflictAwaitingHumanDecision(baseConflict([newId()]))).toBe(true);
    expect(
      isConflictAwaitingHumanDecision(baseConflict([newId()], "resolved"))
    ).toBe(false);
    expect(
      isConflictAwaitingHumanDecision(
        baseConflict([newId()], "human_review", {
          humanDecisionRequired: false
        })
      )
    ).toBe(false);
  });
});

describe("evidence lookup helpers", () => {
  it("only counts verified evidence of the same claim", () => {
    const claim = baseClaim();
    expect(hasVerifiedEvidence(claim.id, [])).toBe(false);
    expect(
      hasVerifiedEvidence(claim.id, [baseEvidence(claim.id, "unverified")])
    ).toBe(false);
    expect(
      hasVerifiedEvidence(claim.id, [baseEvidence(newId(), "verified")])
    ).toBe(false);
    expect(
      hasVerifiedEvidence(claim.id, [baseEvidence(claim.id, "verified")])
    ).toBe(true);
  });

  it("keeps an unverified important claim out of the accepted state", () => {
    const important = baseClaim({ importance: 5 });
    expect(resolveUpheldClaimStatus(important, [])).toBe("supported");
    expect(
      resolveUpheldClaimStatus(important, [
        baseEvidence(important.id, "verified")
      ])
    ).toBe("accepted");
    const minor = baseClaim({ importance: 2 });
    expect(resolveUpheldClaimStatus(minor, [])).toBe("accepted");
  });
});

describe("decisionWritebackPlan", () => {
  it("rejects the challenge by rejecting the contested claim and closing the conflict", () => {
    const claim = baseClaim();
    const conflict = baseConflict([claim.id]);
    const plan = decisionWritebackPlan({
      action: "accept_challenge",
      conflict,
      claims: [claim],
      evidence: []
    });
    expect(plan.conflictId).toBe(conflict.id);
    expect(plan.conflictStatus).toBe("resolved");
    expect(plan.claimUpdates).toEqual([
      { claimId: claim.id, status: "rejected", reason: "challenge_accepted" }
    ]);
  });

  it("upheld ruling accepts the claim when the evidence allows it", () => {
    const claim = baseClaim({ importance: 5 });
    const plan = decisionWritebackPlan({
      action: "uphold_claim",
      conflict: baseConflict([claim.id]),
      claims: [claim],
      evidence: [baseEvidence(claim.id, "verified")]
    });
    expect(plan.conflictStatus).toBe("resolved");
    expect(plan.claimUpdates).toEqual([
      { claimId: claim.id, status: "accepted", reason: "claim_upheld" }
    ]);
  });

  it("downgrades an upheld important claim without verified evidence", () => {
    const claim = baseClaim({ importance: 4 });
    const plan = decisionWritebackPlan({
      action: "uphold_claim",
      conflict: baseConflict([claim.id]),
      claims: [claim],
      evidence: [baseEvidence(claim.id, "unverified")]
    });
    expect(plan.claimUpdates).toEqual([
      {
        claimId: claim.id,
        status: "supported",
        reason: "claim_upheld_without_verified_evidence"
      }
    ]);
  });

  it("re-opens the conflict when more analysis is requested", () => {
    const claim = baseClaim();
    const plan = decisionWritebackPlan({
      action: "request_more_analysis",
      conflict: baseConflict([claim.id]),
      claims: [claim],
      evidence: []
    });
    expect(plan.conflictStatus).toBe("detected");
    expect(plan.claimUpdates).toEqual([
      { claimId: claim.id, status: "contested", reason: "supplement_requested" }
    ]);
  });

  it("marks every claim in dispute as contested when a supplement is requested", () => {
    const first = baseClaim();
    const second = baseClaim();
    const plan = decisionWritebackPlan({
      action: "request_more_analysis",
      conflict: baseConflict([first.id, second.id]),
      claims: [first, second],
      evidence: []
    });
    expect(plan.conflictStatus).toBe("detected");
    expect(plan.claimUpdates).toEqual([
      { claimId: first.id, status: "contested", reason: "supplement_requested" },
      { claimId: second.id, status: "contested", reason: "supplement_requested" }
    ]);
  });

  it("closes a multi-claim contradiction without flipping either side", () => {
    const first = baseClaim();
    const second = baseClaim();
    const plan = decisionWritebackPlan({
      action: "uphold_claim",
      conflict: baseConflict([first.id, second.id]),
      claims: [first, second],
      evidence: []
    });
    expect(plan.conflictStatus).toBe("resolved");
    expect(plan.claimUpdates).toEqual([]);
  });

  it("ignores a duplicate claim reference inside one conflict", () => {
    const claim = baseClaim();
    const plan = decisionWritebackPlan({
      action: "accept_challenge",
      conflict: baseConflict([claim.id, claim.id]),
      claims: [claim],
      evidence: []
    });
    expect(plan.claimUpdates).toHaveLength(1);
  });

  it("resolves a conflict that never passed through human review", () => {
    const claim = baseClaim();
    const plan = decisionWritebackPlan({
      action: "accept_challenge",
      conflict: baseConflict([claim.id], "detected"),
      claims: [claim],
      evidence: []
    });
    expect(plan.conflictStatus).toBe("resolved");
  });

  it("refuses to re-open a resolved conflict", () => {
    const claim = baseClaim();
    expect(() =>
      decisionWritebackPlan({
        action: "request_more_analysis",
        conflict: baseConflict([claim.id], "resolved"),
        claims: [claim],
        evidence: []
      })
    ).toThrow(DecisionWritebackError);
  });

  it("treats a repeated terminal ruling as an idempotent no-op", () => {
    const claim = baseClaim();
    const plan = decisionWritebackPlan({
      action: "uphold_claim",
      conflict: baseConflict([claim.id], "resolved"),
      claims: [claim],
      evidence: []
    });
    expect(plan.conflictStatus).toBe("resolved");
  });

  it("fails closed when the conflict points at an unknown claim", () => {
    expect(() =>
      decisionWritebackPlan({
        action: "accept_challenge",
        conflict: baseConflict([newId()]),
        claims: [baseClaim()],
        evidence: []
      })
    ).toThrow(DecisionWritebackError);
  });

  it("never accepts an important claim without verified evidence", () => {
    for (const importance of [4, 5]) {
      for (const action of ["accept_challenge", "uphold_claim"] as const) {
        const claim = baseClaim({ importance });
        const plan = decisionWritebackPlan({
          action,
          conflict: baseConflict([claim.id]),
          claims: [claim],
          evidence: []
        });
        expect(plan.claimUpdates[0]?.status).not.toBe("accepted");
      }
    }
  });

  it("accepts a minor claim without verified evidence", () => {
    for (const importance of [1, 3]) {
      const claim = baseClaim({ importance });
      const plan = decisionWritebackPlan({
        action: "uphold_claim",
        conflict: baseConflict([claim.id]),
        claims: [claim],
        evidence: []
      });
      expect(plan.claimUpdates[0]?.status).toBe("accepted");
    }
  });
});
