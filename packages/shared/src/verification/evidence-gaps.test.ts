import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  EvidenceSchema,
  SourceSchema,
  newId,
  type Challenge,
  type Evidence,
  type Source
} from "../index";
import { deriveClaimVerdict } from "./claim-verdict";
import {
  diagnoseEvidenceGaps,
  matchRequiredEvidence,
  type EvidenceGapKind
} from "./evidence-gaps";

const NOW = new Date("2026-01-15T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const SESSION = newId();
const CLAIM_ID = newId();
const CLAIM = {
  id: CLAIM_ID,
  statement: "出货量同比增长 12%。",
  type: "fact" as const
};

function evidence(overrides: Record<string, unknown> = {}): Evidence {
  return EvidenceSchema.parse({
    id: newId(),
    sessionId: SESSION,
    claimIds: [CLAIM_ID],
    kind: "external_reference",
    title: "出货量统计",
    content: "2025 年出货量同比增长 12%。",
    description: "厂商公布的年报数据。",
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
    verificationNote: "与年报第 14 页逐字核对一致。",
    locator: "第 14 页",
    ...overrides
  });
}

function source(overrides: Record<string, unknown> = {}): Source {
  return SourceSchema.parse({
    id: newId(),
    sessionId: SESSION,
    title: "年度报告 2025",
    kind: "document",
    publisher: "国家统计局",
    publishedAt: "2025-12-01T00:00:00.000Z",
    createdBy: "human",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides
  });
}

function challenge(overrides: Record<string, unknown> = {}): Challenge {
  return ChallengeSchema.parse({
    id: newId(),
    sessionId: SESSION,
    targetClaimId: CLAIM_ID,
    challengerRunId: newId(),
    challengerRoleId: newId(),
    type: "evidence_gap",
    question: "支撑该数字的采购记录在哪里？",
    context: {
      triggerClaimIds: [CLAIM_ID],
      explanation: "假设厂商口径与统一口径一致。"
    },
    requiredEvidence: ["采购记录"],
    severity: 5,
    resolutionStrategy: "provide_evidence",
    status: "unresolved",
    correlationId: newId(),
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides
  });
}

function diagnose(
  items: Evidence[],
  options: {
    sources?: Source[];
    challenges?: Challenge[];
  } = {}
) {
  const verdict = deriveClaimVerdict(CLAIM, items, {
    now: NOW,
    challenges: options.challenges ?? []
  });
  return {
    verdict,
    gaps: diagnoseEvidenceGaps({
      claim: CLAIM,
      verdict,
      evidence: items,
      sources: options.sources ?? [],
      challenges: options.challenges ?? []
    })
  };
}

function kinds(ids: { kind: EvidenceGapKind }[]): EvidenceGapKind[] {
  return ids.map((gap) => gap.kind).sort();
}

describe("diagnoseEvidenceGaps", () => {
  it("flags no_verified_support when nothing verified supports the claim", () => {
    const { gaps } = diagnose([evidence()]);
    const gap = gaps.find((item) => item.kind === "no_verified_support");
    expect(gap).toBeDefined();
    expect(gap!.severity).toBe("blocking");
    expect(gap!.actions.length).toBeGreaterThan(0);
  });

  it("flags unverified_material and names the unverified rows", () => {
    const pending = evidence();
    const { gaps } = diagnose([pending]);
    const gap = gaps.find((item) => item.kind === "unverified_material");
    expect(gap).toBeDefined();
    expect(gap!.evidenceIds).toContain(pending.id);
  });

  it("flags no_counter_check when support exists without any counter-check", () => {
    const { gaps } = diagnose([verified()]);
    const gap = gaps.find((item) => item.kind === "no_counter_check");
    expect(gap).toBeDefined();
    expect(gap!.detail.join(" ")).toContain("没有发现反例不等于");
  });

  it("does not flag no_counter_check when a contradiction challenge exists", () => {
    const { gaps } = diagnose([verified()], {
      challenges: [challenge({ type: "contradiction", status: "resolved" })]
    });
    expect(gaps.some((item) => item.kind === "no_counter_check")).toBe(false);
  });

  it("flags missing_primary_source for verified support with no registered source", () => {
    const bare = verified(); // only a sourceRef, no sourceId
    const { gaps } = diagnose([bare]);
    const gap = gaps.find((item) => item.kind === "missing_primary_source");
    expect(gap).toBeDefined();
    expect(gap!.evidenceIds).toContain(bare.id);
  });

  it("does not flag missing_primary_source when the support has a registered source", () => {
    const src = source();
    const linked = verified({ sourceId: src.id });
    const { gaps } = diagnose([linked], { sources: [src] });
    expect(gaps.some((item) => item.kind === "missing_primary_source")).toBe(
      false
    );
  });

  it("flags source_expired for material outside its validity window", () => {
    const expired = verified({
      validityPeriod: { to: "2025-06-01T00:00:00.000Z" }
    });
    const { verdict, gaps } = diagnose([expired]);
    expect(verdict.excluded).toContainEqual({
      evidenceId: expired.id,
      reason: "expired"
    });
    const gap = gaps.find((item) => item.kind === "source_expired");
    expect(gap).toBeDefined();
    expect(gap!.evidenceIds).toContain(expired.id);
  });

  it("flags source_not_yet_effective for material whose window has not opened", () => {
    const future = verified({
      validityPeriod: { from: "2026-06-01T00:00:00.000Z" }
    });
    const { gaps } = diagnose([future]);
    const gap = gaps.find((item) => item.kind === "source_not_yet_effective");
    expect(gap).toBeDefined();
    expect(gap!.severity).toBe("advisory");
  });

  it("flags unknown_publication_date when a verified source omits publishedAt", () => {
    const src = source({ publishedAt: undefined });
    const linked = verified({ sourceId: src.id });
    const { gaps } = diagnose([linked], { sources: [src] });
    const gap = gaps.find((item) => item.kind === "unknown_publication_date");
    expect(gap).toBeDefined();
    expect(gap!.evidenceIds).toContain(linked.id);
  });

  it("flags source_independence_unverified when several verified rows share a publisher", () => {
    const src = source();
    const first = verified({ sourceId: src.id });
    const second = verified({ sourceId: src.id });
    const { gaps } = diagnose([first, second], { sources: [src] });
    const gap = gaps.find(
      (item) => item.kind === "source_independence_unverified"
    );
    expect(gap).toBeDefined();
    expect(gap!.evidenceIds).toEqual(
      expect.arrayContaining([first.id, second.id])
    );
  });

  it("flags excerpt_not_locatable when a verified row has no locator", () => {
    const noLocator = verified({ locator: undefined });
    const { gaps } = diagnose([noLocator]);
    const gap = gaps.find((item) => item.kind === "excerpt_not_locatable");
    expect(gap).toBeDefined();
    expect(gap!.evidenceIds).toContain(noLocator.id);
  });

  it("flags unresolved_dispute for a high-severity open challenge", () => {
    const open = challenge({ severity: 5, status: "unresolved" });
    const { gaps } = diagnose([verified()], { challenges: [open] });
    const gap = gaps.find((item) => item.kind === "unresolved_dispute");
    expect(gap).toBeDefined();
    expect(gap!.severity).toBe("blocking");
    expect(gap!.challengeIds).toContain(open.id);
  });

  it("does not flag unresolved_dispute for a resolved challenge", () => {
    const closed = challenge({ severity: 5, status: "resolved" });
    const { gaps } = diagnose([verified()], { challenges: [closed] });
    expect(gaps.some((item) => item.kind === "unresolved_dispute")).toBe(false);
  });

  it("flags unmapped_reference for challenger text that maps to no evidence", () => {
    const open = challenge({ requiredEvidence: ["采购记录"] });
    const { gaps } = diagnose([verified()], { challenges: [open] });
    const gap = gaps.find((item) => item.kind === "unmapped_reference");
    expect(gap).toBeDefined();
    expect(gap!.detail.join(" ")).toContain("未登记为证据：采购记录");
  });

  it("does not flag unmapped_reference when the required text is registered", () => {
    const match = evidence({ content: "包含采购记录编号 A-102 的表格。" });
    const open = challenge({ requiredEvidence: ["采购记录编号 A-102"] });
    const { gaps } = diagnose([match], { challenges: [open] });
    expect(gaps.some((item) => item.kind === "unmapped_reference")).toBe(false);
  });

  it("flags review_requires_more_evidence when a human ruling asked for more material", () => {
    const item = verified();
    const verdict = deriveClaimVerdict(CLAIM, [item], {
      now: NOW,
      reviews: [
        {
          claimId: CLAIM_ID,
          outcome: "needs_more_evidence",
          rationale: "需要补充原始采购记录。",
          reviewer: "Owner (owner)",
          evidenceIds: [item.id],
          sourceIds: [],
          verdictStatusAtReview: "supported",
          verdictConfidenceAtReview: 0.6,
          createdAt: NOW_ISO
        }
      ]
    });
    const gaps = diagnoseEvidenceGaps({
      claim: CLAIM,
      verdict,
      evidence: [item],
      sources: [],
      challenges: []
    });
    const gap = gaps.find(
      (item) => item.kind === "review_requires_more_evidence"
    );
    expect(gap).toBeDefined();
    expect(gap!.severity).toBe("blocking");
    expect(gap!.message).toContain("Owner (owner)");
  });

  it("produces one gap per rule so every kind is reachable", () => {
    const srcNoDate = source({ publishedAt: undefined });
    const shared = source();
    const unverifiedRow = evidence();
    const verifiedNoSource = verified({ locator: undefined });
    const linkedNoDate = verified({ sourceId: srcNoDate.id });
    const clusteredA = verified({ sourceId: shared.id });
    const clusteredB = verified({ sourceId: shared.id });
    const expired = verified({
      validityPeriod: { to: "2025-06-01T00:00:00.000Z" }
    });
    const future = verified({
      validityPeriod: { from: "2026-06-01T00:00:00.000Z" }
    });
    const open = challenge({ severity: 5, requiredEvidence: ["采购记录"] });

    const { gaps } = diagnose(
      [
        unverifiedRow,
        verifiedNoSource,
        linkedNoDate,
        clusteredA,
        clusteredB,
        expired,
        future
      ],
      { sources: [srcNoDate, shared], challenges: [open] }
    );
    const present = new Set(kinds(gaps));
    for (const kind of [
      "unverified_material",
      "missing_primary_source",
      "unknown_publication_date",
      "source_independence_unverified",
      "excerpt_not_locatable",
      "source_expired",
      "source_not_yet_effective",
      "unresolved_dispute",
      "unmapped_reference"
    ] as EvidenceGapKind[]) {
      expect(present.has(kind)).toBe(true);
    }
  });

  it("is deterministic: identical state yields identical gaps", () => {
    const items = [evidence(), verified()];
    const first = diagnose(items).gaps;
    const second = diagnose(items).gaps;
    expect(first).toEqual(second);
    expect(first.map((gap) => gap.id)).toEqual(second.map((gap) => gap.id));
  });

  it("gives every gap a stable id, an action and only 'suggested' proposals", () => {
    const { gaps } = diagnose([evidence()], {
      challenges: [challenge({ requiredEvidence: ["采购记录"] })]
    });
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap.id.startsWith(`${gap.kind}:${CLAIM_ID}`)).toBe(true);
      expect(gap.actions.length).toBeGreaterThan(0);
      for (const proposal of gap.suggestions) {
        // The literal type guarantees a suggestion never looks like a source.
        expect(proposal.status).toBe("suggested");
      }
    }
  });

  it("never claims a suggestion was searched", () => {
    const { gaps } = diagnose([verified()]);
    const labels = gaps
      .flatMap((gap) => gap.suggestions)
      .map((proposal) => proposal.label);
    for (const label of labels) {
      expect(label).toMatch(/建议|待验证|未执行检索|未登记为证据/);
    }
  });
});

describe("matchRequiredEvidence", () => {
  it("splits free-text requirements into matched and unverified", () => {
    const registered = [evidence({ content: "采购记录编号 A-102。" })];
    const result = matchRequiredEvidence(
      ["采购记录编号 A-102", "尚未登记的材料"],
      registered
    );
    expect(result.matched).toEqual(["采购记录编号 A-102"]);
    expect(result.unverifiedReferences).toEqual(["尚未登记的材料"]);
  });

  it("ignores blank entries", () => {
    const result = matchRequiredEvidence(["   "], []);
    expect(result.matched).toEqual([]);
    expect(result.unverifiedReferences).toEqual([]);
  });
});
