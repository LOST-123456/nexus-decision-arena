import { describe, expect, it } from "vitest";
import { EvidenceSchema, newId, type Evidence } from "../index";
import {
  SEVERE_CHALLENGE_THRESHOLD,
  deriveClaimVerdict,
  deriveClaimVerdicts,
  isEvidenceNotYetEffective,
  summarizeCrossReview,
  type VerdictChallengeSignal,
  type VerdictReviewSignal
} from "./claim-verdict";
import { applyReviewToStatus, reviewOutcomeLabel } from "./review-outcome";

const NOW = new Date("2026-01-15T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const CLAIM = newId();

function evidence(overrides: Record<string, unknown> = {}): Evidence {
  return EvidenceSchema.parse({
    id: newId(),
    sessionId: newId(),
    claimIds: [CLAIM],
    kind: "external_reference",
    title: "Shipment figures",
    content: "Shipments rose 12%.",
    description: "Vendor-reported growth.",
    sourceRef: "https://example.org/report",
    direction: "supports",
    reliability: 0.7,
    verificationStatus: "unverified",
    retrievedAt: NOW_ISO,
    createdBy: "human",
    ...overrides
  });
}

function verified(overrides: Record<string, unknown> = {}): Evidence {
  return evidence({
    verificationStatus: "verified",
    verifiedBy: "researcher-1",
    verifiedAt: NOW_ISO,
    verificationNote: "Checked against the published table.",
    ...overrides
  });
}

/** Evidence produced by an agent run rather than a person. */
function agentEvidence(runId: string, overrides: Record<string, unknown> = {}) {
  return evidence({ createdBy: "agent", agentRunId: runId, ...overrides });
}

function challenge(
  overrides: Partial<VerdictChallengeSignal> = {}
): VerdictChallengeSignal {
  return {
    targetClaimId: CLAIM,
    status: "unresolved",
    severity: 5,
    question: "Where is the procurement record that backs this?",
    requiredEvidence: ["采购记录"],
    resolutionStrategy: "provide_evidence",
    createdAt: NOW_ISO,
    ...overrides
  };
}

function review(overrides: Partial<VerdictReviewSignal> = {}): VerdictReviewSignal {
  return {
    claimId: CLAIM,
    outcome: "confirmed",
    rationale: "与年报第 14 页逐字核对一致。",
    reviewer: "Owner (owner)",
    evidenceIds: [],
    sourceIds: [],
    verdictStatusAtReview: "supported",
    verdictConfidenceAtReview: 0.6,
    createdAt: NOW_ISO,
    ...overrides
  };
}

describe("verdict · agent agreement is not evidence", () => {
  it("stays insufficient_evidence when every agent agrees but nothing is verified", () => {
    // Three separate agent runs all support the claim. Agreement is not proof:
    // none of the material has been checked, so nothing may be concluded.
    const items = [
      agentEvidence(newId(), { title: "Agent A support" }),
      agentEvidence(newId(), { title: "Agent B support" }),
      agentEvidence(newId(), { title: "Agent C support" })
    ];

    const verdict = deriveClaimVerdict({ id: CLAIM }, items, { now: NOW });

    expect(verdict.status).toBe("insufficient_evidence");
    expect(verdict.confidence).toBe(0);
    expect(verdict.counts.verified).toBe(0);
    expect(verdict.counts.unverified).toBe(3);
    expect(verdict.effectiveStatus).toBe("insufficient_evidence");
    expect(verdict.rationale).not.toMatch(/support/i);
  });

  it("does not let an agent majority outweigh verified opposing evidence", () => {
    const items = [
      agentEvidence(newId()),
      agentEvidence(newId()),
      agentEvidence(newId()),
      verified({ direction: "opposes", title: "Audited export records" })
    ];

    const verdict = deriveClaimVerdict({ id: CLAIM }, items, { now: NOW });

    // The three agent votes were never checked, so they cannot carry the day.
    expect(verdict.status).toBe("refuted");
    expect(verdict.counts.unverified).toBe(3);
    expect(verdict.counts.verifiedOpposing).toBe(1);
    expect(verdict.confidence).toBeLessThan(1);
    expect(verdict.needsWork).toBe(true);
  });

  it("reports mixed evidence rather than picking the larger side", () => {
    const items = [
      verified({ direction: "supports" }),
      verified({ direction: "supports" }),
      verified({ direction: "opposes", title: "Contradicting audit" })
    ];

    const verdict = deriveClaimVerdict({ id: CLAIM }, items, { now: NOW });

    expect(verdict.status).toBe("mixed_evidence");
    expect(verdict.confidence).toBeLessThanOrEqual(0.6);
    expect(verdict.counts.verifiedSupporting).toBe(2);
    expect(verdict.counts.verifiedOpposing).toBe(1);
  });
});

describe("verdict · time bounds are never bypassed", () => {
  it("excludes expired material instead of silently leaning on it", () => {
    const expired = verified({
      validityPeriod: { to: "2025-01-01T00:00:00.000Z" }
    });

    const verdict = deriveClaimVerdict({ id: CLAIM }, [expired], { now: NOW });

    expect(verdict.status).toBe("insufficient_evidence");
    expect(verdict.counts.expired).toBe(1);
    expect(verdict.counts.verified).toBe(0);
    expect(verdict.limits.join(" ")).toContain("超出有效期");
    expect(verdict.needsWork).toBe(true);
  });

  it("excludes material whose validity window has not opened yet", () => {
    const future = verified({
      validityPeriod: { from: "2027-01-01T00:00:00.000Z" }
    });

    expect(isEvidenceNotYetEffective(future, NOW)).toBe(true);
    const verdict = deriveClaimVerdict({ id: CLAIM }, [future], { now: NOW });
    expect(verdict.status).toBe("insufficient_evidence");
    expect(verdict.counts.notYetEffective).toBe(1);
    expect(verdict.limits.join(" ")).toContain("尚未开始");
  });

  it("drops a supported claim when the only support has expired", () => {
    const items = [
      verified({ validityPeriod: { to: "2025-01-01T00:00:00.000Z" } }),
      verified({ direction: "opposes", title: "Current records" })
    ];

    const verdict = deriveClaimVerdict({ id: CLAIM }, items, { now: NOW });

    expect(verdict.status).toBe("refuted");
    expect(verdict.counts.expired).toBe(1);
  });
});

describe("verdict · cross-examination uncertainty", () => {
  it("cannot assert direction while a severe challenge is open", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM }, [verified()], {
      now: NOW,
      challenges: [challenge()]
    });

    expect(verdict.status).toBe("inconclusive");
    expect(verdict.confidence).toBeLessThanOrEqual(0.4);
    expect(verdict.openQuestions).toHaveLength(1);
    expect(verdict.crossReview.severeUnresolved).toBe(1);
    expect(verdict.needsWork).toBe(true);
    expect(verdict.effectiveStatus).toBe("inconclusive");
  });

  it("keeps the directional verdict once the challenge is resolved", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM }, [verified()], {
      now: NOW,
      challenges: [challenge({ status: "resolved" })]
    });

    expect(verdict.status).toBe("supported");
    expect(verdict.crossReview.unresolved).toBe(0);
    expect(verdict.openQuestions).toHaveLength(0);
  });

  it("treats answered-but-not-resolved challenges as still open", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM }, [verified()], {
      now: NOW,
      challenges: [challenge({ status: "answered" })]
    });

    expect(verdict.status).toBe("inconclusive");
  });

  it("does not let a low-severity question block a verified conclusion", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM }, [verified()], {
      now: NOW,
      challenges: [challenge({ severity: SEVERE_CHALLENGE_THRESHOLD - 1 })]
    });

    expect(verdict.status).toBe("supported");
    expect(verdict.openQuestions).toHaveLength(1);
  });

  it("does not upgrade a claim that has no verified evidence", () => {
    // An open challenge can only lower confidence, never raise it.
    const verdict = deriveClaimVerdict({ id: CLAIM }, [evidence()], {
      now: NOW,
      challenges: [challenge()]
    });

    expect(verdict.status).toBe("insufficient_evidence");
  });

  it("blocks a refutation the same way it blocks support", () => {
    const verdict = deriveClaimVerdict(
      { id: CLAIM },
      [verified({ direction: "opposes" })],
      { now: NOW, challenges: [challenge()] }
    );

    expect(verdict.status).toBe("inconclusive");
  });

  it("summarizes cross review deterministically", () => {
    const summary = summarizeCrossReview([
      challenge({ severity: 5 }),
      challenge({ severity: 2, question: "Minor wording question" }),
      challenge({ severity: 4, status: "resolved" })
    ]);

    expect(summary.challenges).toBe(3);
    expect(summary.unresolved).toBe(2);
    expect(summary.severeUnresolved).toBe(1);
    expect(summary.openQuestions[0]).toBe(
      "Where is the procurement record that backs this?"
    );
    expect(summary.lastReviewedAt).toBe(NOW_ISO);
  });
});

describe("verdict · human rulings", () => {
  it("lets a confirmation stand on the derived verdict without upgrading it", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM }, [evidence()], {
      now: NOW,
      reviews: [review({ outcome: "confirmed" })]
    });

    // The reviewer accepted an unresolved claim; the conclusion stays unresolved.
    expect(verdict.status).toBe("insufficient_evidence");
    expect(verdict.effectiveStatus).toBe("insufficient_evidence");
    expect(verdict.review?.reviewer).toBe("Owner (owner)");
  });

  it("records a rejected claim as refuted while keeping the derived status", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM }, [verified()], {
      now: NOW,
      reviews: [
        review({
          outcome: "rejected",
          rationale: "原始报表口径与主张不一致，主张不成立。"
        })
      ]
    });

    expect(verdict.status).toBe("supported");
    expect(verdict.effectiveStatus).toBe("refuted");
    expect(verdict.review?.rationale).toContain("不成立");
  });

  it("returns the claim to insufficient evidence when more material is demanded", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM }, [verified()], {
      now: NOW,
      reviews: [
        review({
          outcome: "needs_more_evidence",
          rationale: "还缺采购记录，暂不能确认。"
        })
      ]
    });

    expect(verdict.status).toBe("supported");
    expect(verdict.effectiveStatus).toBe("insufficient_evidence");
    expect(verdict.needsWork).toBe(true);
  });

  it("uses the latest ruling and keeps earlier ones out of the projection", () => {
    const older = review({
      outcome: "rejected",
      createdAt: "2026-01-10T00:00:00.000Z"
    });
    const newer = review({
      outcome: "confirmed",
      createdAt: "2026-01-14T00:00:00.000Z"
    });

    const verdict = deriveClaimVerdict({ id: CLAIM }, [verified()], {
      now: NOW,
      reviews: [older, newer]
    });

    expect(verdict.review?.outcome).toBe("confirmed");
    expect(verdict.effectiveStatus).toBe("supported");
  });

  it("ignores rulings recorded against a different claim", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM }, [verified()], {
      now: NOW,
      reviews: [review({ claimId: newId() })]
    });

    expect(verdict.review).toBeNull();
    expect(verdict.effectiveStatus).toBe("supported");
  });

  it("maps rulings to effective statuses explicitly", () => {
    expect(applyReviewToStatus("supported", null)).toBe("supported");
    expect(applyReviewToStatus("inconclusive", "confirmed")).toBe("inconclusive");
    expect(applyReviewToStatus("supported", "rejected")).toBe("refuted");
    expect(applyReviewToStatus("supported", "needs_more_evidence")).toBe(
      "insufficient_evidence"
    );
    expect(reviewOutcomeLabel("needs_more_evidence")).toBe("要求补充证据");
  });
});

describe("deriveClaimVerdicts", () => {
  it("applies cross-review and rulings to every claim in one pass", () => {
    const other = newId();
    const verdicts = deriveClaimVerdicts(
      [{ id: CLAIM }, { id: other }],
      [verified()],
      {
        now: NOW,
        challenges: [challenge()],
        reviews: [review()]
      }
    );

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]?.status).toBe("inconclusive");
    expect(verdicts[0]?.review).not.toBeNull();
    expect(verdicts[1]?.status).toBe("unsupported");
  });
});
