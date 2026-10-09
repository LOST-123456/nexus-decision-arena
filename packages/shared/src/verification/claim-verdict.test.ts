import { describe, expect, it } from "vitest";
import { EvidenceSchema, newId, type Evidence } from "../index";
import {
  deriveClaimVerdict,
  deriveClaimVerdicts,
  evidenceForClaim,
  isEvidenceExpired,
  summarizeVerification
} from "./claim-verdict";

const NOW = new Date("2026-01-15T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();

function evidence(overrides: Record<string, unknown> = {}): Evidence {
  return EvidenceSchema.parse({
    id: newId(),
    sessionId: newId(),
    claimIds: [CLAIM_A],
    kind: "external_reference",
    title: "Quarterly figures",
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

let CLAIM_A = newId();
const CLAIM_B = newId();

describe("isEvidenceExpired", () => {
  it("treats an open-ended validity window as current", () => {
    expect(
      isEvidenceExpired({ validityPeriod: { from: NOW_ISO } }, NOW)
    ).toBe(false);
  });

  it("excludes material whose validity window has closed", () => {
    const past = new Date("2024-01-01T00:00:00.000Z").toISOString();
    expect(isEvidenceExpired({ validityPeriod: { to: past } }, NOW)).toBe(true);
  });
});

describe("evidenceForClaim", () => {
  it("returns excerpts that bear on the claim through multi-linkage", () => {
    const shared = verified({ claimIds: [CLAIM_A, CLAIM_B] });
    const other = verified({ claimIds: [CLAIM_B] });

    expect(evidenceForClaim([shared, other], CLAIM_A)).toEqual([shared]);
    expect(evidenceForClaim([shared, other], CLAIM_B)).toHaveLength(2);
  });
});

describe("summarizeVerification", () => {
  it("counts each verification bucket separately", () => {
    const rejected = verified({ verificationStatus: "rejected" });
    const summary = summarizeVerification([verified(), evidence(), rejected]);

    expect(summary).toMatchObject({ verified: 1, unverified: 1, rejected: 1 });
    expect(summary.total).toBe(3);
  });
});

describe("deriveClaimVerdict", () => {
  it("reports unsupported when nothing is attached", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM_A }, [], { now: NOW });

    expect(verdict.status).toBe("unsupported");
    expect(verdict.confidence).toBe(0);
    expect(verdict.needsWork).toBe(true);
  });

  it("does not conclude anything from unverified material alone", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM_A }, [evidence()], {
      now: NOW
    });

    expect(verdict.status).toBe("insufficient_evidence");
    expect(verdict.confidence).toBe(0);
    expect(verdict.rationale).toMatch(/none is verified/i);
  });

  it("counts background material as context only, never as support", () => {
    const verdict = deriveClaimVerdict(
      { id: CLAIM_A },
      [verified({ direction: "context" })],
      { now: NOW }
    );

    expect(verdict.status).toBe("context_only");
    expect(verdict.confidence).toBeLessThan(0.2);
    expect(verdict.counts.verifiedContext).toBe(1);
    expect(verdict.counts.verifiedSupporting).toBe(0);
  });

  it("reports support when verified material supports and none opposes", () => {
    const verdict = deriveClaimVerdict(
      { id: CLAIM_A },
      [verified(), verified({ id: newId() })],
      { now: NOW }
    );

    expect(verdict.status).toBe("supported");
    expect(verdict.confidence).toBeGreaterThan(0);
    expect(verdict.confidence).toBeLessThanOrEqual(0.95);
    expect(verdict.needsWork).toBe(false);
  });

  it("never reaches certainty even with strong support", () => {
    const verdict = deriveClaimVerdict(
      { id: CLAIM_A },
      [verified({ reliability: 1 }), verified({ reliability: 1 })],
      { now: NOW }
    );

    expect(verdict.confidence).toBeLessThan(1);
  });

  it("reports refuted when verified material contradicts the claim", () => {
    const verdict = deriveClaimVerdict(
      { id: CLAIM_A },
      [verified({ direction: "opposes" })],
      { now: NOW }
    );

    expect(verdict.status).toBe("refuted");
    expect(verdict.counts.verifiedOpposing).toBe(1);
  });

  it("surfaces disagreement instead of collapsing it", () => {
    const verdict = deriveClaimVerdict(
      { id: CLAIM_A },
      [verified(), verified({ direction: "opposes" })],
      { now: NOW }
    );

    expect(verdict.status).toBe("mixed_evidence");
    expect(verdict.confidence).toBeLessThanOrEqual(0.6);
    expect(verdict.rationale).toMatch(/disagreement is unresolved/i);
  });

  it("ignores rejected material when weighing support", () => {
    const verdict = deriveClaimVerdict(
      { id: CLAIM_A },
      [verified({ verificationStatus: "rejected" })],
      { now: NOW }
    );

    expect(verdict.status).toBe("insufficient_evidence");
    expect(verdict.counts.rejected).toBe(1);
  });

  it("excludes material outside its validity window and says so", () => {
    const past = new Date("2024-01-01T00:00:00.000Z").toISOString();
    const verdict = deriveClaimVerdict(
      { id: CLAIM_A },
      [verified({ validityPeriod: { to: past } })],
      { now: NOW }
    );

    expect(verdict.status).toBe("insufficient_evidence");
    expect(verdict.counts.expired).toBe(1);
    expect(verdict.rationale).toMatch(/validity window/i);
  });

  it("keeps the claim open for work while anything is unverified", () => {
    const verdict = deriveClaimVerdict(
      { id: CLAIM_A },
      [verified(), evidence()],
      { now: NOW }
    );

    expect(verdict.status).toBe("supported");
    expect(verdict.needsWork).toBe(true);
    expect(verdict.rationale).toMatch(/still unverified/i);
  });

  it("does not read the absence of opposition as proof", () => {
    const verdict = deriveClaimVerdict({ id: CLAIM_A }, [verified()], {
      now: NOW
    });

    expect(verdict.status).toBe("supported");
    expect(verdict.rationale).toMatch(/none opposes/i);
    expect(verdict.confidence).toBeLessThanOrEqual(0.95);
  });
});

describe("deriveClaimVerdicts", () => {
  it("produces an independent verdict per claim", () => {
    const verdicts = deriveClaimVerdicts(
      [{ id: CLAIM_A }, { id: CLAIM_B }],
      [verified({ claimIds: [CLAIM_A] })],
      { now: NOW }
    );

    expect(verdicts).toHaveLength(2);
    expect(verdicts[0]!.status).toBe("supported");
    expect(verdicts[1]!.status).toBe("unsupported");
  });
});
