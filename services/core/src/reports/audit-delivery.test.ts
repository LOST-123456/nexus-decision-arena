import { describe, expect, it } from "vitest";
import { newId, type Evidence } from "@nexus/shared";
import {
  AUDIT_SCOPE_VALUES,
  claimVerification,
  resolveAuditScope,
  scopeArenaMaterials,
  toAuditMaterial
} from "./audit-delivery";
import type {
  EvidenceCitation,
  FactCheckFinding
} from "../research/fact-check-report";

/**
 * The delivery policy, tested as a policy.
 *
 * The rule the product decided on: **unverified material is retained and
 * labelled, not quietly dropped.** What these tests pin is that the default
 * does that, that the optional `verified` scope pays for its filtering by
 * reporting the count it removed, and that neither scope invents a label.
 */

function evidence(overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: newId(),
    sessionId: newId(),
    claimIds: [newId()],
    kind: "external",
    title: "材料",
    content: "摘录正文",
    description: "说明",
    direction: "supports",
    reliability: 0.6,
    verificationStatus: "unverified",
    retrievedAt: "2026-10-01T00:00:00.000Z",
    createdBy: "human",
    ...overrides
  } as Evidence;
}

function citation(
  verificationStatus: EvidenceCitation["verificationStatus"]
): EvidenceCitation {
  return {
    evidenceId: newId(),
    title: "引用",
    excerpt: "摘录",
    locator: null,
    direction: "supports",
    verificationStatus,
    reliability: 0.5,
    verifiedBy: null,
    verificationNote: null,
    source: null,
    sourceRef: null,
    citationStatus: "unlinked"
  };
}

describe("resolveAuditScope", () => {
  it("defaults to keeping everything when nothing is asked for", () => {
    expect(resolveAuditScope(undefined)).toBe("all");
    expect(resolveAuditScope("")).toBe("all");
  });

  it("accepts the two scopes it declares", () => {
    for (const scope of AUDIT_SCOPE_VALUES) {
      expect(resolveAuditScope(scope)).toBe(scope);
    }
  });

  it("refuses an unknown scope instead of falling back to a default", () => {
    // A silent fallback would deliver the wrong subset to whoever asked.
    expect(resolveAuditScope("verified-only")).toBeNull();
    expect(resolveAuditScope("ALL")).toBeNull();
    expect(resolveAuditScope(1)).toBeNull();
  });
});

describe("toAuditMaterial", () => {
  it("carries the verification status and a label a reader can read", () => {
    expect(
      toAuditMaterial(evidence({ verificationStatus: "verified" }))
        .verificationLabel
    ).toBe("已核实");
    expect(
      toAuditMaterial(evidence({ verificationStatus: "unverified" }))
        .verificationLabel
    ).toBe("待核实");
    expect(
      toAuditMaterial(evidence({ verificationStatus: "rejected" }))
        .verificationLabel
    ).toBe("已驳回");
  });

  it("keeps every claim an excerpt bears on", () => {
    const claimIds = [newId(), newId()];
    expect(toAuditMaterial(evidence({ claimIds })).claimIds).toEqual(claimIds);
  });
});

describe("scopeArenaMaterials", () => {
  const material = [
    evidence({ verificationStatus: "verified" }),
    evidence({ verificationStatus: "unverified" }),
    evidence({ verificationStatus: "rejected" })
  ];

  it("keeps all three and labels them under the default scope", () => {
    const { materials, disclosure } = scopeArenaMaterials(material, "all");

    expect(materials).toHaveLength(3);
    expect(materials.map((item) => item.verificationLabel)).toEqual([
      "已核实",
      "待核实",
      "已驳回"
    ]);
    expect(disclosure.scope).toBe("all");
    expect(disclosure.withheld.materials).toBe(0);
    expect(disclosure.statement).toContain("保留在包内");
  });

  it("keeps only verified material under the verified scope, and says how much it dropped", () => {
    const { materials, disclosure } = scopeArenaMaterials(material, "verified");

    expect(materials).toHaveLength(1);
    expect(materials[0]?.verificationStatus).toBe("verified");
    expect(disclosure.withheld.materials).toBe(2);
    // The number is in the sentence, so a reader cannot miss it.
    expect(disclosure.statement).toContain("2 条");
  });

  it("never labels a decision policy without naming it", () => {
    expect(scopeArenaMaterials(material, "all").disclosure.policy).toBe(
      "retain-and-label"
    );
  });
});

describe("claimVerification", () => {
  function finding(citations: EvidenceCitation[]): FactCheckFinding {
    return {
      claimId: newId(),
      statement: "主张",
      type: "fact",
      stance: "affirm",
      importance: 3,
      claimStatus: "active",
      verdict: {
        claimId: "x",
        status: "unverified",
        effectiveStatus: "unverified",
        confidence: 0,
        rationale: "",
        ruleHits: [],
        basis: {
          supportingEvidenceIds: [],
          opposingEvidenceIds: [],
          contextEvidenceIds: []
        },
        excluded: [],
        confidenceBasis: [],
        openQuestions: [],
        limits: [],
        derivedAt: "2026-10-01T00:00:00.000Z"
      },
      review: null,
      reviewHistory: [],
      supporting: citations,
      opposing: [],
      context: [],
      excluded: [],
      challenges: [],
      runs: [],
      gaps: [],
      blockingGapCount: 0
    } as unknown as FactCheckFinding;
  }

  it("says a claim has no material rather than calling it unverified", () => {
    // "unverified" and "nothing here" are different facts; conflating them
    // would tell a reader the material was looked at and failed.
    expect(claimVerification(finding([])).verification).toBe("no_material");
  });

  it("calls a claim verified only when every citation is", () => {
    const all = finding([citation("verified"), citation("verified")]);
    expect(claimVerification(all).verification).toBe("verified");
    expect(claimVerification(all).verified).toBe(2);
  });

  it("distinguishes partially verified from wholly unverified", () => {
    const partial = claimVerification(
      finding([citation("verified"), citation("unverified")])
    );
    expect(partial.verification).toBe("partially_verified");
    expect(partial.verified).toBe(1);
    expect(partial.unverified).toBe(1);

    const none = claimVerification(
      finding([citation("unverified"), citation("rejected")])
    );
    expect(none.verification).toBe("unverified");
    expect(none.rejected).toBe(1);
  });
});
