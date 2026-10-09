import { describe, expect, it } from "vitest";
import {
  EvidenceVerificationError,
  EvidenceVerificationRequestSchema,
  planEvidenceVerification,
  isVerifiedEvidence
} from "./evidence-verification";
import type { Evidence } from "../index";

const NOW = new Date("2026-01-15T00:00:00.000Z");

function item(overrides: Partial<Evidence> = {}): Pick<
  Evidence,
  "id" | "kind" | "verificationStatus"
> {
  return {
    id: "01a12076-31a5-77bb-991f-6dcee940cbda",
    kind: "external_reference",
    verificationStatus: "unverified",
    ...overrides
  };
}

describe("EvidenceVerificationRequestSchema", () => {
  it("requires a reason", () => {
    expect(() =>
      EvidenceVerificationRequestSchema.parse({ status: "verified" })
    ).toThrow();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      EvidenceVerificationRequestSchema.parse({
        status: "confirmed",
        verificationNote: "looks right"
      })
    ).toThrow();
  });

  it("does not expose verifiedBy to the client", () => {
    const parsed = EvidenceVerificationRequestSchema.parse({
      status: "verified",
      verificationNote: "checked"
    });
    expect(parsed).not.toHaveProperty("verifiedBy");
  });
});

describe("planEvidenceVerification", () => {
  it("records who verified and why", () => {
    const plan = planEvidenceVerification({
      evidence: item(),
      status: "verified",
      verifiedBy: "Researcher One",
      verificationNote: "Excerpt matches page 14.",
      now: NOW
    });

    expect(plan.from).toBe("unverified");
    expect(plan.to).toBe("verified");
    expect(plan.patch.verifiedBy).toBe("Researcher One");
    expect(plan.patch.verifiedAt).toBe(NOW.toISOString());
    expect(plan.patch.verificationNote).toBe("Excerpt matches page 14.");
  });

  it("refuses a transition that changes nothing", () => {
    expect(() =>
      planEvidenceVerification({
        evidence: item({ verificationStatus: "verified" }),
        status: "verified",
        verifiedBy: "Researcher One",
        verificationNote: "again"
      })
    ).toThrow(/already verified/i);
  });

  it("refuses an anonymous reviewer", () => {
    expect(() =>
      planEvidenceVerification({
        evidence: item(),
        status: "verified",
        verifiedBy: "   ",
        verificationNote: "checked"
      })
    ).toThrow(/identified reviewer/i);
  });

  it("refuses an empty reason", () => {
    expect(() =>
      planEvidenceVerification({
        evidence: item(),
        status: "verified",
        verifiedBy: "Researcher One",
        verificationNote: "   "
      })
    ).toThrow(/recorded reason/i);
  });

  it("never lets an assumption become verified", () => {
    expect(() =>
      planEvidenceVerification({
        evidence: item({ kind: "assumption" }),
        status: "verified",
        verifiedBy: "Researcher One",
        verificationNote: "seems sound"
      })
    ).toThrow(/Assumptions cannot be verified/i);
  });

  it("allows sending verified material back for checking, with a reason", () => {
    const plan = planEvidenceVerification({
      evidence: item({ verificationStatus: "verified" }),
      status: "unverified",
      verifiedBy: "Researcher Two",
      verificationNote: "Source was retracted, re-check needed.",
      now: NOW
    });

    expect(plan.to).toBe("unverified");
    expect(plan.patch.verificationNote).toBe("Source was retracted, re-check needed.");
  });

  it("allows an assumption to be rejected", () => {
    const plan = planEvidenceVerification({
      evidence: item({ kind: "assumption" }),
      status: "rejected",
      verifiedBy: "Researcher One",
      verificationNote: "Unfounded.",
      now: NOW
    });
    expect(plan.to).toBe("rejected");
  });

  it("throws the typed error so callers can map it to 409", () => {
    try {
      planEvidenceVerification({
        evidence: item(),
        status: "verified",
        verifiedBy: "",
        verificationNote: "checked"
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceVerificationError);
    }
  });
});

describe("isVerifiedEvidence", () => {
  it("only treats verified material as counting", () => {
    expect(isVerifiedEvidence({ verificationStatus: "verified" })).toBe(true);
    expect(isVerifiedEvidence({ verificationStatus: "unverified" })).toBe(false);
    expect(isVerifiedEvidence({ verificationStatus: "rejected" })).toBe(false);
  });
});
