import { describe, expect, it } from "vitest";
import {
  assertClaimInvariants,
  ChallengeSchema,
  ClaimSchema,
  canTransition,
  EvidenceSchema,
  isConclusionFinal,
  newId,
  sessionPhaseStep,
  transitionSession
} from "../index";
import type { SessionPhase } from "../index";

const baseClaim = () => {
  const id = newId();
  return ClaimSchema.parse({
    id,
    sessionId: newId(),
    agentRunId: newId(),
    roleId: newId(),
    lens: "market-size",
    statement: "The market is large.",
    type: "assumption",
    stance: "support",
    importance: 5,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: id,
    revision: 1,
    relations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
};

const baseEvidence = (
  claimId: string,
  verificationStatus: "unverified" | "verified" | "rejected"
) => {
  return EvidenceSchema.parse({
    id: newId(),
    sessionId: newId(),
    claimIds: [claimId],
    kind: "calculation",
    title: "Market size calculation",
    content: "The calculation supports the market-size Claim.",
    description: "Calculated from the project input.",
    direction: "supports",
    reliability: 0.9,
    verificationStatus,
    ...(verificationStatus === "unverified"
      ? {}
      : {
          verifiedBy: "workflow-test-operator",
          verifiedAt: new Date().toISOString(),
          verificationNote: "Reviewed for the workflow test."
        }),
    retrievedAt: new Date().toISOString(),
    createdBy: "system"
  });
};

describe("claim invariants", () => {
  it("rejects a root Claim with revision greater than one", () => {
    const claim = baseClaim();
    expect(() =>
      assertClaimInvariants({ ...claim, revision: 2 }, [])
    ).toThrow("Root claim revision must be 1");
  });

  it("rejects an accepted important Claim without verified evidence", () => {
    const claim = baseClaim();
    expect(() =>
      assertClaimInvariants({ ...claim, status: "accepted" }, [])
    ).toThrow("Accepted important claims require verified evidence");
  });

  it("accepts an accepted important Claim with verified evidence", () => {
    const claim = baseClaim();
    const evidence = baseEvidence(claim.id, "verified");

    expect(() =>
      assertClaimInvariants(
        {
          ...claim,
          status: "accepted",
          evidenceIds: [evidence.id]
        },
        [evidence]
      )
    ).not.toThrow();
  });

  it("rejects an accepted important Claim with unverified evidence", () => {
    const claim = baseClaim();
    const evidence = baseEvidence(claim.id, "unverified");

    expect(() =>
      assertClaimInvariants(
        {
          ...claim,
          status: "accepted",
          evidenceIds: [evidence.id]
        },
        [evidence]
      )
    ).toThrow("Accepted important claims require verified evidence");
  });

  it("rejects evidence that the Claim does not declare", () => {
    const claim = baseClaim();
    const evidence = baseEvidence(claim.id, "verified");

    expect(() =>
      assertClaimInvariants(
        { ...claim, importance: 3, evidenceIds: [] },
        [evidence]
      )
    ).toThrow("Evidence references must be declared on the claim");
  });

  it("rejects a revision without a predecessor", () => {
    const claim = baseClaim();
    expect(() =>
      assertClaimInvariants(
        { ...claim, rootClaimId: newId(), revision: 2 },
        []
      )
    ).toThrow("A revision must reference its predecessor");
  });

  it("accepts a non-root revision with a predecessor", () => {
    const claim = baseClaim();

    expect(() =>
      assertClaimInvariants(
        {
          ...claim,
          rootClaimId: newId(),
          revisionOfClaimId: newId(),
          revision: 2
        },
        []
      )
    ).not.toThrow();
  });

  it("rejects a non-root revision that does not advance beyond one", () => {
    const claim = baseClaim();

    expect(() =>
      assertClaimInvariants(
        { ...claim, rootClaimId: newId(), revision: 1 },
        []
      )
    ).toThrow("A revision must have revision greater than 1");
  });

  it("rejects an accepted important Claim with an unresolved severe Challenge", () => {
    const claim = baseClaim();
    const evidence = baseEvidence(claim.id, "verified");
    const challenge = ChallengeSchema.parse({
      id: newId(),
      sessionId: claim.sessionId,
      targetClaimId: claim.id,
      challengerRunId: newId(),
      challengerRoleId: newId(),
      type: "evidence_gap",
      question: "Where is the independent source?",
      context: {
        triggerClaimIds: [claim.id],
        explanation: "The claim remains contested."
      },
      requiredEvidence: ["independent source"],
      severity: 4,
      resolutionStrategy: "provide_evidence",
      status: "unresolved",
      correlationId: newId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    expect(() =>
      assertClaimInvariants(
        {
          ...claim,
          status: "accepted",
          evidenceIds: [evidence.id]
        },
        [evidence],
        [challenge]
      )
    ).toThrow(
      "Accepted important claims cannot have unresolved severe challenges"
    );
  });
});

const sessionPhases = [
  "CREATED",
  "PLANNING",
  "ANALYZING",
  "CHALLENGING",
  "CONFLICT_DETECTED",
  "HUMAN_REVIEW",
  "REASSESSING",
  "DECIDED",
  "REPORT_READY"
] as const satisfies readonly SessionPhase[];

const expectedTransitions = {
  CREATED: ["PLANNING"],
  PLANNING: ["ANALYZING"],
  ANALYZING: ["CHALLENGING"],
  CHALLENGING: ["CONFLICT_DETECTED", "DECIDED"],
  CONFLICT_DETECTED: ["HUMAN_REVIEW", "DECIDED"],
  HUMAN_REVIEW: ["REASSESSING", "DECIDED"],
  REASSESSING: ["CHALLENGING", "DECIDED"],
  DECIDED: ["REPORT_READY"],
  REPORT_READY: []
} as const satisfies Record<SessionPhase, readonly SessionPhase[]>;

const allowedTransitions: ReadonlyArray<
  readonly [SessionPhase, SessionPhase]
> = sessionPhases.flatMap((from) =>
  expectedTransitions[from].map((to) => [from, to] as const)
);

const rejectedTransitions = [
  ["CREATED", "CHALLENGING"],
  ["PLANNING", "CHALLENGING"],
  ["ANALYZING", "DECIDED"],
  ["CHALLENGING", "HUMAN_REVIEW"],
  ["CONFLICT_DETECTED", "CHALLENGING"],
  ["REASSESSING", "REPORT_READY"],
  ["DECIDED", "CHALLENGING"],
  ["REPORT_READY", "DECIDED"]
] as const satisfies ReadonlyArray<
  readonly [SessionPhase, SessionPhase]
>;

describe("session transitions", () => {
  it.each(sessionPhases)(
    "matches every transition from %s",
    (from) => {
      const expectedTargets = new Set<SessionPhase>(
        expectedTransitions[from]
      );

      for (const to of sessionPhases) {
        expect(canTransition(from, to)).toBe(expectedTargets.has(to));
      }
    }
  );

  it.each(allowedTransitions)(
    "returns the next phase for %s -> %s",
    (from, to) => {
      expect(canTransition(from, to)).toBe(true);
      expect(transitionSession(from, to)).toBe(to);
    }
  );

  it.each(rejectedTransitions)(
    "rejects %s -> %s",
    (from, to) => {
      expect(canTransition(from, to)).toBe(false);
      expect(() => transitionSession(from, to)).toThrow(
        `Invalid session transition: ${from} -> ${to}`
      );
    }
  );

  it("treats REPORT_READY as terminal", () => {
    for (const to of sessionPhases) {
      expect(canTransition("REPORT_READY", to)).toBe(false);
      expect(() => transitionSession("REPORT_READY", to)).toThrow(
        `Invalid session transition: REPORT_READY -> ${to}`
      );
    }
  });
});

/**
 * 后台跑那十几秒里，页面只剩阶段名和时针在动，看着像卡死。
 * 步序号把「还要等几步」变成看得见的东西；结论定没定稿决定页头怎么称呼它。
 */
describe("sessionPhaseStep", () => {
  it("PLANNING → CONFLICT_DETECTED 依次是第 1..4 步", () => {
    expect(sessionPhaseStep("PLANNING")).toMatchObject({ step: 1, total: 4 });
    expect(sessionPhaseStep("ANALYZING")).toMatchObject({ step: 2, total: 4 });
    expect(sessionPhaseStep("CHALLENGING")).toMatchObject({ step: 3, total: 4 });
    expect(sessionPhaseStep("CONFLICT_DETECTED")).toMatchObject({
      step: 4,
      total: 4
    });
  });

  it("REASSESSING 是回头重跑第 2 步，并标出来这不是退步", () => {
    expect(sessionPhaseStep("REASSESSING")).toMatchObject({
      step: 2,
      total: 4,
      restarted: true
    });
  });

  it("不在机器步上的阶段返回 null，不硬凑一个数字", () => {
    for (const phase of ["CREATED", "HUMAN_REVIEW", "DECIDED", "REPORT_READY"]) {
      expect(sessionPhaseStep(phase)).toBeNull();
    }
    expect(sessionPhaseStep("NOT_A_PHASE")).toBeNull();
  });
});

describe("isConclusionFinal", () => {
  it("只有出了结论之后才算定稿", () => {
    expect(isConclusionFinal("DECIDED")).toBe(true);
    expect(isConclusionFinal("REPORT_READY")).toBe(true);
  });

  it("分析中、质询中、等人工裁决时都还没定稿", () => {
    for (const phase of [
      "CREATED",
      "PLANNING",
      "ANALYZING",
      "CHALLENGING",
      "CONFLICT_DETECTED",
      "HUMAN_REVIEW",
      "REASSESSING"
    ]) {
      expect(isConclusionFinal(phase)).toBe(false);
    }
  });
});
