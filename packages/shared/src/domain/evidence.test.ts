import { describe, expect, it } from "vitest";
import {
  EvidenceSchema,
  SourceSchema,
  evidenceCoversClaim,
  newId
} from "../index";

const NOW = new Date().toISOString();

function baseEvidence(overrides: Record<string, unknown> = {}) {
  return {
    id: newId(),
    sessionId: newId(),
    claimIds: [newId()],
    kind: "external_reference",
    title: "Quarterly shipment figures",
    content: "Shipments rose 12% year over year.",
    description: "Vendor-reported shipment growth for the last quarter.",
    sourceRef: "https://example.org/report",
    direction: "supports",
    reliability: 0.6,
    verificationStatus: "unverified",
    retrievedAt: NOW,
    createdBy: "human",
    ...overrides
  };
}

describe("SourceSchema", () => {
  it("accepts a manual source without a url", () => {
    const source = SourceSchema.parse({
      id: newId(),
      sessionId: newId(),
      title: "Interview notes",
      kind: "manual",
      publisher: "Internal research",
      createdBy: "human",
      createdAt: NOW,
      updatedAt: NOW
    });

    expect(source.kind).toBe("manual");
    expect(source.url).toBeUndefined();
  });

  it("requires a canonical url for url sources", () => {
    expect(() =>
      SourceSchema.parse({
        id: newId(),
        sessionId: newId(),
        title: "Broken link",
        kind: "url",
        createdBy: "human",
        createdAt: NOW,
        updatedAt: NOW
      })
    ).toThrow(/canonical url/i);
  });

  it("keeps publication metadata so an excerpt can be cited", () => {
    const publishedAt = "2025-03-04T00:00:00.000Z";
    const source = SourceSchema.parse({
      id: newId(),
      sessionId: newId(),
      title: "Statistical yearbook",
      kind: "document",
      url: "https://example.org/yearbook.pdf",
      publisher: "National Bureau of Statistics",
      author: "Editorial board",
      publishedAt,
      note: "Print edition, figures revised in the 2025 reprint.",
      createdBy: "human",
      createdAt: NOW,
      updatedAt: NOW
    });

    expect(source.publishedAt).toBe(publishedAt);
    expect(source.author).toBe("Editorial board");
  });
});

describe("EvidenceSchema multi-claim linkage", () => {
  it("accepts one excerpt bearing on several claims", () => {
    const claimIds = [newId(), newId()];
    const evidence = EvidenceSchema.parse(baseEvidence({ claimIds }));

    expect(evidence.claimIds).toHaveLength(2);
    expect(evidenceCoversClaim(evidence, claimIds[1]!)).toBe(true);
  });

  it("rejects evidence that is attached to no claim", () => {
    expect(() => EvidenceSchema.parse(baseEvidence({ claimIds: [] }))).toThrow();
  });

  it("supports background material as a distinct direction", () => {
    const evidence = EvidenceSchema.parse(
      baseEvidence({ direction: "context", description: "Market definition." })
    );

    expect(evidence.direction).toBe("context");
  });
});

describe("EvidenceSchema verification gate", () => {
  it("allows unverified evidence without a reviewer", () => {
    const evidence = EvidenceSchema.parse(baseEvidence());

    expect(evidence.verificationStatus).toBe("unverified");
    expect(evidence.verifiedBy).toBeUndefined();
  });

  it("refuses verified evidence that names no reviewer", () => {
    expect(() =>
      EvidenceSchema.parse(
        baseEvidence({
          verificationStatus: "verified",
          verificationNote: "Checked against the published table."
        })
      )
    ).toThrow(/named reviewer/i);
  });

  it("refuses verified evidence that records no reason", () => {
    expect(() =>
      EvidenceSchema.parse(
        baseEvidence({
          verificationStatus: "verified",
          verifiedBy: "researcher-1"
        })
      )
    ).toThrow(/recorded reason/i);
  });

  it("accepts verification only with a reviewer, a time and a reason", () => {
    const evidence = EvidenceSchema.parse(
      baseEvidence({
        verificationStatus: "verified",
        verifiedBy: "researcher-1",
        verifiedAt: NOW,
        verificationNote: "Excerpt matches page 14 of the published report."
      })
    );

    expect(evidence.verificationStatus).toBe("verified");
    expect(evidence.verifiedBy).toBe("researcher-1");
  });

  it("applies the same gate to rejection", () => {
    expect(() =>
      EvidenceSchema.parse(baseEvidence({ verificationStatus: "rejected" }))
    ).toThrow(/named reviewer/i);
  });

  it("never lets an assumption be marked verified", () => {
    expect(() =>
      EvidenceSchema.parse(
        baseEvidence({
          kind: "assumption",
          verificationStatus: "verified",
          verifiedBy: "researcher-1",
          verifiedAt: NOW,
          verificationNote: "Looks reasonable."
        })
      )
    ).toThrow(/Assumptions cannot be verified/i);
  });

  it("requires external references to be traceable", () => {
    expect(() =>
      EvidenceSchema.parse(baseEvidence({ sourceRef: undefined }))
    ).toThrow(/require a source record or a source url/i);
  });

  it("accepts an external reference backed by a source record", () => {
    const evidence = EvidenceSchema.parse(
      baseEvidence({ sourceRef: undefined, sourceId: newId() })
    );

    expect(evidence.sourceId).toBeDefined();
  });

  it("keeps a locator so an excerpt can be re-checked in place", () => {
    const evidence = EvidenceSchema.parse(
      baseEvidence({ locator: "p. 14, table 3" })
    );

    expect(evidence.locator).toBe("p. 14, table 3");
  });
});

describe("evidenceCoversClaim", () => {
  it("ignores claims the excerpt does not bear on", () => {
    const claimId = newId();
    const evidence = EvidenceSchema.parse(baseEvidence());

    expect(evidenceCoversClaim(evidence, claimId)).toBe(false);
    expect(evidenceCoversClaim(evidence, evidence.claimIds[0]!)).toBe(true);
  });
});
