import { describe, expect, it } from "vitest";
import {
  assertClaimInvariants,
  ClaimSchema,
  canTransition,
  EvidenceSchema,
  newId,
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
    claimId,
    kind: "calculation",
    title: "Market size calculation",
    content: "The calculation supports the market-size Claim.",
    description: "Calculated from the project input.",
    direction: "supports",
    reliability: 0.9,
    verificationStatus,
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
  HUMAN_REVIEW: ["REASSESSING"],
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
  ["HUMAN_REVIEW", "DECIDED"],
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
