import { describe, expect, it } from "vitest";
import {
  assertClaimInvariants,
  ClaimSchema,
  canTransition,
  newId,
  transitionSession
} from "../index";

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

  it("rejects a revision without a predecessor", () => {
    const claim = baseClaim();
    expect(() =>
      assertClaimInvariants(
        { ...claim, rootClaimId: newId(), revision: 2 },
        []
      )
    ).toThrow("A revision must reference its predecessor");
  });
});

describe("session transitions", () => {
  it("allows the frozen happy path", () => {
    expect(canTransition("PLANNING", "ANALYZING")).toBe(true);
    expect(canTransition("ANALYZING", "CHALLENGING")).toBe(true);
    expect(canTransition("HUMAN_REVIEW", "REASSESSING")).toBe(true);
    expect(canTransition("DECIDED", "REPORT_READY")).toBe(true);
  });

  it("rejects skipping the analysis phase", () => {
    expect(canTransition("CREATED", "CHALLENGING")).toBe(false);
    expect(() => transitionSession("CREATED", "CHALLENGING")).toThrow(
      "Invalid session transition: CREATED -> CHALLENGING"
    );
  });
});
