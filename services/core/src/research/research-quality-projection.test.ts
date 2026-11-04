import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  ClaimSchema,
  ConflictSchema,
  deriveClaimVerdicts,
  diagnoseEvidenceGaps,
  EvidenceSchema,
  newId,
  RevalidationTaskSchema,
  ResearchPlanItemSchema,
  SourceSchema,
  SourceSnapshotSchema,
  summarizeIndependence,
  type Challenge,
  type Claim,
  type ClaimVerdict,
  type Conflict,
  type Evidence,
  type IndependenceSummary,
  type QualityDimension,
  type QualityDimensionId,
  type ResearchPlanItem,
  type ResearchQualityAssessment,
  type ResearchQualityInput,
  type RevalidationTask,
  type Source,
  type SourceLink,
  type SourceSnapshot
} from "@nexus/shared";
import { projectResearchQuality } from "./research-quality-projection";
import { deriveRevalidationWarnings } from "./revalidation-warnings";

/**
 * The scoring engine, tested on its own terms.
 *
 * Every assertion here is about honesty of the rules, not about a number
 * being large: a dimension that cannot be computed must say so, a suspected
 * duplicate must not quietly lower a score, more excerpts must not read as
 * more proof, and the same rows must always produce the same assessment.
 */

const SESSION_ID = newId();
const CLAIM_ID = newId();
const SECOND_CLAIM_ID = newId();
const SOURCE_A = newId();
const SOURCE_B = newId();
const SOURCE_C = newId();
const NOW = new Date("2026-02-01T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const CHALLENGER_ROLE_ID = newId();
const RUN_ID = newId();

function claimFixture(overrides: Partial<Claim> = {}): Claim {
  return ClaimSchema.parse({
    id: CLAIM_ID,
    sessionId: SESSION_ID,
    lens: "research",
    statement: "Shipments grew 12% last quarter.",
    type: "fact",
    stance: "support",
    importance: 5,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: CLAIM_ID,
    revision: 1,
    relations: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides
  });
}

function secondClaimFixture(overrides: Partial<Claim> = {}): Claim {
  return claimFixture({
    id: SECOND_CLAIM_ID,
    statement: "The vendor overstated the figure.",
    rootClaimId: SECOND_CLAIM_ID,
    importance: 2,
    ...overrides
  });
}

function evidenceFixture(overrides: Partial<Evidence> = {}): Evidence {
  return EvidenceSchema.parse({
    id: newId(),
    sessionId: SESSION_ID,
    claimIds: [CLAIM_ID],
    kind: "external_reference",
    title: "Quarterly figures",
    content: "Shipments rose 12%.",
    description: "Vendor-reported growth.",
    sourceId: SOURCE_A,
    direction: "supports",
    reliability: 0.6,
    verificationStatus: "verified",
    verifiedBy: "Owner (owner)",
    verifiedAt: NOW_ISO,
    verificationNote: "Checked against page 14.",
    locator: "page 14",
    locatorStatus: "anchored",
    retrievedAt: NOW_ISO,
    createdBy: "human",
    ...overrides
  });
}

function sourceFixture(id: string, overrides: Partial<Source> = {}): Source {
  return SourceSchema.parse({
    id,
    sessionId: SESSION_ID,
    title: `Source ${id.slice(0, 6)}`,
    kind: "url",
    url: `https://example.org/${id}`,
    publisher: "Example Bureau",
    createdBy: "human",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides
  });
}

function snapshotFixture(sourceId: string, contentHash: string): SourceSnapshot {
  return SourceSnapshotSchema.parse({
    id: newId(),
    sessionId: SESSION_ID,
    sourceId,
    canonicalUrl: `https://example.org/${sourceId}`,
    contentHash,
    contentType: "text/html",
    content: "Shipments rose 12%.",
    contentBytes: 19,
    charCount: 19,
    retrievedAt: NOW_ISO,
    createdAt: NOW_ISO
  });
}

function challengeFixture(overrides: Partial<Challenge> = {}): Challenge {
  return ChallengeSchema.parse({
    id: newId(),
    sessionId: SESSION_ID,
    targetClaimId: CLAIM_ID,
    challengerRunId: RUN_ID,
    challengerRoleId: CHALLENGER_ROLE_ID,
    type: "evidence_gap",
    question: "Where is the procurement record?",
    context: {
      triggerClaimIds: [CLAIM_ID],
      explanation: "The claim drives the conclusion."
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

function conflictFixture(overrides: Partial<Conflict> = {}): Conflict {
  return ConflictSchema.parse({
    id: newId(),
    sessionId: SESSION_ID,
    claimIds: [CLAIM_ID],
    challengeIds: [],
    type: "evidence",
    summary: "Procurement evidence is missing.",
    severity: 5,
    status: "human_review",
    humanDecisionRequired: true,
    resolutionSuggestion: "Adopt the challenge.",
    impactScope: { analysisAreas: [], stakeholders: [] },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...overrides
  });
}

function monitoringTaskFixture(
  overrides: Partial<RevalidationTask> = {}
): RevalidationTask {
  return RevalidationTaskSchema.parse({
    id: newId(),
    sessionId: SESSION_ID,
    sourceId: SOURCE_A,
    sourceTitle: "Source",
    triggerContentHash: "b".repeat(64),
    previousSnapshotId: null,
    currentSnapshotId: null,
    affectedEvidenceIds: [],
    affectedClaimIds: [],
    reason: "来源内容发生变化",
    status: "open",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    resolvedAt: null,
    resolvedBy: null,
    resolutionNote: null,
    ...overrides
  });
}

/** A link as the independence analysis would report it. */
function linkFixture(
  fromSourceId: string,
  toSourceId: string,
  overrides: Partial<SourceLink> = {}
): SourceLink {
  return {
    fromSourceId,
    toSourceId,
    kind: "duplicate",
    basis: "content_hash",
    confidence: "confirmed",
    similarity: null,
    reason: "同一内容哈希",
    origin: "system",
    ...overrides
  };
}

function independenceFixture(
  sources: readonly Source[],
  links: readonly SourceLink[]
): IndependenceSummary {
  return summarizeIndependence({ sessionId: SESSION_ID, sources, links });
}

function planItemFixture(overrides: {
  id?: string;
  gapId: string;
  status?: ResearchPlanItem["status"];
}): ResearchPlanItem {
  return ResearchPlanItemSchema.parse({
    id: overrides.id ?? newId(),
    sessionId: SESSION_ID,
    gapId: overrides.gapId,
    claimId: CLAIM_ID,
    gapKind: "no_verified_support",
    severity: "blocking",
    priority: 1,
    title: "Find the procurement record",
    question: "Where is the procurement record?",
    whyInsufficient: ["没有已核实支持证据"],
    query: {
      neededEvidenceKind: "primary_record",
      sourceTypes: ["official_notice"],
      terms: ["采购记录"],
      timeRange: null,
      notes: null
    },
    status: overrides.status ?? "queued",
    outcome: null,
    decisionReason: null,
    decidedBy: null,
    failureReason: null,
    supersedesId: null,
    isCurrent: true,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  });
}

/**
 * The base input: one claim with nothing behind it, two registered pages and
 * no optional analysis configured. Each test overrides only what it is about.
 */
function baseInput(
  overrides: Partial<ResearchQualityInput> = {}
): ResearchQualityInput {
  const claims = overrides.claims ?? [claimFixture()];
  const evidence = overrides.evidence ?? [];
  const sources = overrides.sources ?? [
    sourceFixture(SOURCE_A),
    sourceFixture(SOURCE_B)
  ];
  // The default verdicts are derived in full (ClaimVerdict) so the gap
  // derivation below can run on the verdict shape diagnoseEvidenceGaps reads.
  // The input only needs the narrow ClaimVerdictForQuality slice, which a full
  // verdict is always assignable to.
  const fullVerdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
  const verdicts = overrides.verdicts ?? fullVerdicts;
  const gaps =
    overrides.gaps ??
    claims.flatMap((claim) => {
      const verdict = fullVerdicts.find((item) => item.claimId === claim.id);
      if (!verdict) return [];
      return diagnoseEvidenceGaps({
        claim,
        verdict,
        evidence: evidence.filter((item) => item.claimIds.includes(claim.id)),
        sources,
        challenges: []
      });
    });

  return {
    sessionId: SESSION_ID,
    assessedAt: NOW_ISO,
    claims,
    evidence,
    sources,
    conflicts: [],
    challenges: [],
    verdicts,
    gaps,
    agentRuns: [],
    independence: null,
    monitoring: null,
    planItems: [],
    searchTasks: null,
    ...overrides
  };
}

function dimensionOf(
  assessment: ResearchQualityAssessment,
  id: QualityDimensionId
): QualityDimension {
  const found = assessment.dimensions.find((item) => item.id === id);
  if (!found) throw new Error(`missing dimension: ${id}`);
  return found;
}

describe("research quality · an empty session is not a good session", () => {
  it("gives no dimension a score and no overall score", () => {
    const assessment = projectResearchQuality(
      baseInput({ claims: [], evidence: [], sources: [] })
    );

    for (const dimension of assessment.dimensions) {
      expect(dimension.score).toBeNull();
      expect(dimension.status).toBe("insufficient_data");
    }
    expect(assessment.overall.score).toBeNull();
    expect(assessment.overall.status).toBe("insufficient_data");
    expect(assessment.overall.assessedDimensions).toBe(0);
    expect(assessment.overall.explanation).toContain("不给出综合分数");
  });

  it("keeps the read-only promise in the limitations", () => {
    const assessment = projectResearchQuality(
      baseInput({ claims: [], evidence: [], sources: [] })
    );

    expect(assessment.limitations.join(" ")).toContain("只读投影");
    expect(assessment.limitations.join(" ")).toContain("不是结论正确的概率");
  });
});

describe("research quality · coverage counts claims, not excerpts", () => {
  it("scores a claim with verified support at the top and says why", () => {
    const assessment = projectResearchQuality(
      baseInput({ evidence: [evidenceFixture()] })
    );

    const coverage = dimensionOf(assessment, "evidence_coverage");
    expect(coverage.score).toBe(100);
    expect(coverage.status).toBe("strong");
    expect(coverage.explanation).toContain("分子分母都只数主张");
  });

  it("does not reward more excerpts of the same claim", () => {
    const one = projectResearchQuality(
      baseInput({ evidence: [evidenceFixture()] })
    );
    const five = projectResearchQuality(
      baseInput({
        evidence: [
          evidenceFixture(),
          evidenceFixture({ id: newId() }),
          evidenceFixture({ id: newId() }),
          evidenceFixture({ id: newId() }),
          evidenceFixture({ id: newId() })
        ]
      })
    );

    expect(dimensionOf(five, "evidence_coverage").score).toBe(
      dimensionOf(one, "evidence_coverage").score
    );
    expect(five.inputFingerprint).not.toBe(one.inputFingerprint);
  });

  it("marks a claim with no material at all, critical only when it matters", () => {
    const important = projectResearchQuality(baseInput());
    const finding = important.findings.find(
      (item) => item.category === "missing_evidence"
    );
    expect(finding?.severity).toBe("critical");
    expect(finding?.recommendation).toBe("add_supporting_evidence");

    const minor = projectResearchQuality(
      baseInput({ claims: [claimFixture({ importance: 2 })] })
    );
    expect(
      minor.findings.find((item) => item.category === "missing_evidence")
        ?.severity
    ).toBe("warning");
  });

  it("treats unverified material as not covering the claim", () => {
    const assessment = projectResearchQuality(
      baseInput({
        evidence: [
          evidenceFixture({ verificationStatus: "unverified", verifiedBy: undefined })
        ]
      })
    );

    const coverage = dimensionOf(assessment, "evidence_coverage");
    expect(coverage.score).toBe(40);
    const verification = dimensionOf(assessment, "verification_quality");
    // Two axes: nobody stands behind the excerpt (0.7 × 0), but the quote can
    // still be re-found in its source (0.3 × 1). Unverified is a to-do, and
    // the score says exactly that much — not 0, not 100.
    expect(verification.score).toBe(30);
    expect(verification.status).toBe("weak");
    const finding = assessment.findings.find(
      (item) => item.category === "unverified_evidence"
    );
    expect(finding?.severity).toBe("warning");
    expect(finding?.recommendation).toBe("verify_evidence");
  });
});

describe("research quality · verification keeps the two axes apart", () => {
  it("counts a person's confirmation and a locatable quote separately", () => {
    const verified = projectResearchQuality(
      baseInput({ evidence: [evidenceFixture()] })
    );
    expect(dimensionOf(verified, "verification_quality").score).toBe(100);

    const verifiedButUnanchored = projectResearchQuality(
      baseInput({
        evidence: [evidenceFixture({ locatorStatus: "unanchored", locator: undefined })]
      })
    );
    // 0.7 × verified + 0.3 × locatable: a person stands behind it, the quote
    // cannot be re-found, and the score says exactly that.
    expect(dimensionOf(verifiedButUnanchored, "verification_quality").score).toBe(
      70
    );
  });

  it("reports a citation that can no longer be located without rewriting it", () => {
    const evidence = evidenceFixture({ locatorStatus: "missing" });
    const assessment = projectResearchQuality(baseInput({ evidence: [evidence] }));

    const finding = assessment.findings.find(
      (item) => item.category === "broken_citation"
    );
    expect(finding?.severity).toBe("warning");
    expect(finding?.reason).toContain("历史核实记录保持不变");
    // The verification itself is untouched: the engine never rewrites it.
    expect(assessment.evidenceFindings[0]?.verificationStatus).toBe("verified");
    expect(assessment.evidenceFindings[0]?.sourceUpdateRisk).toBe(false);
  });

  it("notes a verified excerpt with no locator as information, not a defect", () => {
    const assessment = projectResearchQuality(
      baseInput({
        evidence: [evidenceFixture({ locator: undefined, locatorStatus: "unanchored" })]
      })
    );

    const finding = assessment.findings.find(
      (item) => item.category === "broken_citation"
    );
    expect(finding?.severity).toBe("info");
  });

  it("flags material that has no provenance record at all", () => {
    const assessment = projectResearchQuality(
      baseInput({
        evidence: [
          evidenceFixture({
            sourceId: undefined,
            sourceRef: undefined,
            kind: "project_input"
          })
        ]
      })
    );

    const finding = assessment.findings.find(
      (item) => item.category === "missing_source_record"
    );
    expect(finding?.severity).toBe("warning");
    expect(assessment.evidenceFindings[0]?.hasSourceRecord).toBe(false);
  });
});

describe("research quality · independence is never inferred from different urls", () => {
  it("merges confirmed duplicates into one information source", () => {
    const sources = [
      sourceFixture(SOURCE_A),
      sourceFixture(SOURCE_B),
      sourceFixture(SOURCE_C)
    ];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, SOURCE_B, { kind: "same_page" })
        ])
      })
    );

    const independence = dimensionOf(assessment, "source_independence");
    // Three pages, two information sources: the ratio is honest about it.
    expect(independence.score).toBeCloseTo((2 / 3) * 100, 2);
    const duplicate = assessment.findings.find(
      (item) => item.category === "duplicate_source"
    );
    expect(duplicate?.severity).toBe("info");
    expect(duplicate?.recommendation).toBe("open_source_relations");
  });

  it("refuses to score when a near-duplicate is still unconfirmed", () => {
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, SOURCE_B, {
            kind: "near_duplicate",
            basis: "text_similarity",
            confidence: "suspected"
          })
        ])
      })
    );

    const independence = dimensionOf(assessment, "source_independence");
    expect(independence.score).toBeNull();
    expect(independence.status).toBe("insufficient_data");
    expect(independence.explanation).toContain("记为未知");
    expect(
      assessment.findings.find(
        (item) => item.category === "insufficient_independence"
      )?.recommendation
    ).toBe("open_source_relations");
  });

  it("says unknown when the analysis is not configured at all", () => {
    const assessment = projectResearchQuality(
      baseInput({
        sources: [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)],
        evidence: [evidenceFixture()],
        independence: null
      })
    );

    const independence = dimensionOf(assessment, "source_independence");
    expect(independence.score).toBeNull();
    expect(assessment.limitations.join(" ")).toContain("来源独立性分析不可用");
  });

  it("has nothing to assess with a single source", () => {
    const assessment = projectResearchQuality(
      baseInput({
        sources: [sourceFixture(SOURCE_A)],
        evidence: [evidenceFixture()],
        independence: independenceFixture([sourceFixture(SOURCE_A)], [])
      })
    );

    const independence = dimensionOf(assessment, "source_independence");
    expect(independence.score).toBeNull();
    expect(independence.explanation).toContain("只有 1 个已登记来源");
  });

  it("counts a person's unrelated declaration as the only proof of independence", () => {
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, SOURCE_B, {
            kind: "unrelated",
            basis: "human_assertion",
            origin: "human"
          })
        ])
      })
    );

    expect(dimensionOf(assessment, "source_independence").score).toBe(100);
    const source = assessment.sourceFindings.find(
      (item) => item.sourceId === SOURCE_A
    );
    expect(source?.relationStatus).toBe("independent");
    expect(source?.unrelatedSourceIds).toEqual([SOURCE_B]);
    // A different url with no declaration is not independence.
    const undetermined = assessment.sourceFindings.find(
      (item) => item.sourceId === SOURCE_B
    );
    expect(undetermined?.undeterminedSourceIds).toEqual([]);
  });

  it("warns about one publisher behind several pages without calling them copies", () => {
    const sources = [
      sourceFixture(SOURCE_A),
      sourceFixture(SOURCE_B),
      sourceFixture(SOURCE_C)
    ];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [])
      })
    );

    const finding = assessment.findings.find(
      (item) => item.category === "publisher_concentration"
    );
    expect(finding?.severity).toBe("warning");
    expect(finding?.reason).toContain("同一发布方不等于同源");
  });

  it("does not let five excerpts from one source read as five origins", () => {
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const supporting = [
      evidenceFixture({ id: newId() }),
      evidenceFixture({ id: newId() }),
      evidenceFixture({ id: newId() }),
      evidenceFixture({ id: newId() }),
      evidenceFixture({ id: newId() })
    ];
    const claims = [claimFixture()];
    const verdicts = deriveClaimVerdicts(claims, supporting, { now: NOW });
    const assessment = projectResearchQuality(
      baseInput({
        claims,
        evidence: supporting,
        sources,
        verdicts,
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, SOURCE_B, { kind: "same_origin" })
        ])
      })
    );

    const claim = assessment.claimFindings[0]!;
    expect(claim.evidenceSupporting).toBe(5);
    expect(claim.independentSourceCount).toBe(1);
    const finding = assessment.findings.find(
      (item) => item.category === "single_source_dependency"
    );
    expect(finding?.reason).toContain("只构成 1 份独立佐证");
  });

  it("refuses to count independent sources for a claim with no material at all", () => {
    // Zero would read as a measured "no independent sources". The honest
    // answer for a claim with nothing behind it is that independence could
    // not be established — null, which the panel shows as 无法判断.
    const claims = [claimFixture()];
    const verdicts = deriveClaimVerdicts(claims, [], { now: NOW });
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const assessment = projectResearchQuality(
      baseInput({
        claims,
        evidence: [],
        sources,
        verdicts,
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, SOURCE_B, { kind: "same_origin" })
        ])
      })
    );

    const claim = assessment.claimFindings[0]!;
    expect(claim.evidenceTotal).toBe(0);
    expect(claim.independentSourceCount).toBeNull();
  });
});

describe("research quality · disagreements are handled, not hidden", () => {
  it("scores how conflicts and challenges were dealt with", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const verdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
    const resolved = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        conflicts: [conflictFixture({ status: "resolved" })],
        challenges: [challengeFixture({ status: "resolved" })]
      })
    );
    expect(dimensionOf(resolved, "conflict_resolution").score).toBe(100);

    const open = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        conflicts: [conflictFixture()],
        challenges: [challengeFixture()]
      })
    );
    expect(dimensionOf(open, "conflict_resolution").score).toBe(0);
    const conflictFinding = open.findings.find(
      (item) => item.category === "unresolved_conflict"
    );
    expect(conflictFinding?.severity).toBe("critical");
    expect(conflictFinding?.recommendation).toBe("open_human_review");
    const challengeFinding = open.findings.find(
      (item) => item.category === "unanswered_challenge"
    );
    expect(challengeFinding?.severity).toBe("critical");
  });

  it("treats opposing evidence as a fact to handle, not a defect", () => {
    const claims = [claimFixture()];
    const evidence = [
      evidenceFixture({ direction: "supports" }),
      evidenceFixture({
        id: newId(),
        direction: "opposes",
        sourceId: SOURCE_B
      })
    ];
    const verdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
    const assessment = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        sources: [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)],
        independence: independenceFixture(
          [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)],
          []
        ),
        challenges: [challengeFixture({ status: "resolved" })]
      })
    );

    expect(assessment.claimFindings[0]?.evidenceOpposing).toBe(1);
    const conflict = dimensionOf(assessment, "conflict_resolution");
    expect(conflict.limitations.join(" ")).toContain("反对证据的存在本身不是质量缺陷");
  });

  it("has nothing to assess when nothing disagreed", () => {
    const assessment = projectResearchQuality(baseInput());

    const conflict = dimensionOf(assessment, "conflict_resolution");
    expect(conflict.score).toBeNull();
    expect(conflict.explanation).toContain("没有发现分歧不等于不存在分歧");
  });
});

describe("research quality · completeness is about work, not material", () => {
  it("counts planned gaps and settled plan items", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const verdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
    const gaps = diagnoseEvidenceGaps({
      claim: claims[0]!,
      verdict: verdicts[0]!,
      evidence,
      sources: [sourceFixture(SOURCE_A)],
      challenges: []
    });
    // Every diagnosed gap gets a plan item: planning one gap out of several
    // would flatter the ratio, and the dimension is about all the work.
    const queuedPlan = gaps.map((gap) =>
      planItemFixture({ gapId: gap.id, status: "queued" })
    );

    const queued = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        gaps,
        planItems: queuedPlan
      })
    );
    const completeness = dimensionOf(queued, "research_completeness");
    // The gaps are owned, but nothing has been worked yet: 0.4 × 1 + 0.6 × 0.
    expect(completeness.score).toBe(40);
    expect(completeness.inputMetrics.planItemsQueued).toBe(gaps.length);

    const settled = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        gaps,
        planItems: gaps.map((gap) =>
          planItemFixture({ gapId: gap.id, status: "completed" })
        )
      })
    );
    expect(dimensionOf(settled, "research_completeness").score).toBe(100);
    // A planned gap is not an open finding any more.
    expect(
      settled.findings.some((item) => item.category === "open_research_gap")
    ).toBe(false);
    expect(
      queued.findings.some((item) => item.category === "open_research_gap")
    ).toBe(false);
  });

  it("says a created-but-never-run search is not an executed one", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const verdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
    const gaps = diagnoseEvidenceGaps({
      claim: claims[0]!,
      verdict: verdicts[0]!,
      evidence,
      sources: [sourceFixture(SOURCE_A)],
      challenges: []
    });
    const assessment = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        gaps,
        planItems: [planItemFixture({ gapId: gaps[0]!.id, status: "queued" })],
        searchTasks: [{ id: newId(), status: "queued" }]
      })
    );

    const completeness = dimensionOf(assessment, "research_completeness");
    expect(completeness.inputMetrics.searchTasksCreated).toBe(1);
    expect(completeness.inputMetrics.searchTasksExecuted).toBe(0);
  });

  it("has nothing to assess with no gaps and no plan", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const verdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
    const assessment = projectResearchQuality(
      baseInput({ claims, evidence, verdicts, gaps: [] })
    );

    const completeness = dimensionOf(assessment, "research_completeness");
    expect(completeness.score).toBeNull();
    expect(completeness.explanation).toContain("这不代表研究已完整");
  });
});

describe("research quality · freshness is about checks that happened", () => {
  it("scores settled re-checks and reports the open ones as a reason to re-read", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const sources = [sourceFixture(SOURCE_A)];
    const snapshots = [snapshotFixture(SOURCE_A, "c".repeat(64))];
    const verdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
    const tasks = [
      monitoringTaskFixture({
        status: "resolved",
        affectedEvidenceIds: [evidence[0]!.id],
        affectedClaimIds: [CLAIM_ID]
      }),
      monitoringTaskFixture({
        id: newId(),
        status: "open",
        affectedEvidenceIds: [evidence[0]!.id],
        affectedClaimIds: [CLAIM_ID]
      })
    ];
    const assessment = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        sources,
        monitoring: {
          tasks,
          warnings: deriveRevalidationWarnings({
            tasks,
            claims,
            evidence,
            sources,
            latestSnapshots: snapshots
          })
        }
      })
    );

    const freshness = dimensionOf(assessment, "source_freshness");
    expect(freshness.score).toBe(50);
    expect(freshness.limitations.join(" ")).toContain("结论本身未因此改变");

    const stale = assessment.findings.find(
      (item) => item.category === "stale_source"
    );
    expect(stale?.reason).toContain("来源已发生变化");
    expect(assessment.claimFindings[0]?.sourceUpdateRiskCount).toBe(1);
    expect(assessment.evidenceFindings[0]?.sourceUpdateRisk).toBe(true);
  });

  it("says never-checked is not the same as unchanged", () => {
    const assessment = projectResearchQuality(
      baseInput({ evidence: [evidenceFixture()] })
    );

    const freshness = dimensionOf(assessment, "source_freshness");
    expect(freshness.score).toBeNull();
    expect(assessment.limitations.join(" ")).toContain("未配置来源监测");
  });
});

describe("research quality · the overall score is only shown when it can be", () => {
  it("weights the computable dimensions and states the formula", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const verdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
    const assessment = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        sources,
        independence: independenceFixture(sources, []),
        challenges: [challengeFixture({ status: "resolved" })]
      })
    );

    // coverage 100×25 + verification 100×20 + independence 100×20 +
    // conflicts 100×15 + completeness 0×10 + freshness excluded.
    const expected = (100 * 25 + 100 * 20 + 100 * 20 + 100 * 15 + 0 * 10) / 90;
    expect(assessment.overall.score).toBeCloseTo(expected, 2);
    expect(assessment.overall.coverage).toBeCloseTo(0.9, 2);
    expect(assessment.overall.assessedDimensions).toBe(5);
    expect(assessment.overall.explanation).toContain("按权重加权");
    expect(assessment.overall.explanation).toContain("不是结论正确的概率");
  });

  it("stays null when less than half the weight is computable", () => {
    // Only coverage and verification can be computed (one unverified excerpt
    // behind one claim, no gaps and no plan): 25 + 20 of 100.
    const assessment = projectResearchQuality(
      baseInput({
        evidence: [evidenceFixture({ verificationStatus: "unverified" })],
        gaps: []
      })
    );

    expect(assessment.overall.score).toBeNull();
    expect(assessment.overall.coverage).toBeCloseTo(0.45, 2);
    expect(assessment.overall.explanation).toContain("不足 50%");
  });

  it("is deterministic: the same rows always produce the same assessment", () => {
    const claims = [claimFixture(), secondClaimFixture()];
    const evidence = [
      evidenceFixture(),
      evidenceFixture({ id: newId(), claimIds: [SECOND_CLAIM_ID] })
    ];
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const build = () =>
      projectResearchQuality(
        baseInput({
          claims,
          evidence,
          sources,
          verdicts: deriveClaimVerdicts(claims, evidence, { now: NOW }),
          independence: independenceFixture(sources, [
            linkFixture(SOURCE_A, SOURCE_B, { kind: "same_page" })
          ])
        })
      );

    const first = build();
    const second = build();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.ruleVersion).toBe("research-quality-v1");
    expect(first.schemaVersion).toBe(1);
    expect(first.inputFingerprint).toHaveLength(16);
  });

  it("does not mutate the rows it reads", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const frozenClaims = JSON.stringify(claims);
    const frozenEvidence = JSON.stringify(evidence);
    const frozenSources = JSON.stringify(sources);

    projectResearchQuality(
      baseInput({
        claims,
        evidence,
        sources,
        verdicts: deriveClaimVerdicts(claims, evidence, { now: NOW }),
        independence: independenceFixture(sources, [])
      })
    );

    expect(JSON.stringify(claims)).toBe(frozenClaims);
    expect(JSON.stringify(evidence)).toBe(frozenEvidence);
    expect(JSON.stringify(sources)).toBe(frozenSources);
  });

  it("links a claim back to the cross-review runs that questioned it", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const assessment = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts: deriveClaimVerdicts(claims, evidence, { now: NOW }),
        agentRuns: [
          {
            id: RUN_ID,
            sessionId: SESSION_ID,
            roleId: CHALLENGER_ROLE_ID,
            promptVersionId: RUN_ID,
            status: "completed",
            purpose: "cross_review",
            targetClaimId: CLAIM_ID,
            startedAt: NOW_ISO,
            completedAt: NOW_ISO
          }
        ]
      })
    );

    expect(assessment.claimFindings[0]?.relatedRunIds).toEqual([RUN_ID]);
    // A run's duration or token usage is never read here.
    expect(
      JSON.stringify(assessment.claimFindings[0]).includes("token")
    ).toBe(false);
  });

  it("aggregates recommendations per subject with an existing action", () => {
    const assessment = projectResearchQuality(baseInput());

    const recommendation = assessment.recommendations.find(
      (item) => item.action === "add_supporting_evidence"
    );
    expect(recommendation?.title).toContain(claimFixture().statement);
    expect(recommendation?.findingIds.length).toBeGreaterThan(0);
  });
});

/**
 * A recommendation the reader answers by re-reading a source has to name that
 * source. Without it the card is inert: the UI has nothing to open, so the
 * button for "re-read this citation" disappears and the finding is a sentence
 * with no way to act on it.
 */
describe("research quality · source actions point at the source", () => {
  it("carries the source behind an excerpt whose citation no longer resolves", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture({ locatorStatus: "missing" })];
    const verdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
    const assessment = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        sources: [sourceFixture(SOURCE_A)]
      })
    );

    const recommendation = assessment.recommendations.find(
      (item) => item.action === "open_source_reader"
    );
    expect(recommendation?.sourceIds).toEqual([SOURCE_A]);
    expect(recommendation?.claimId).toBe(CLAIM_ID);
  });

  it("files one changed source once, not once per claim and per excerpt", () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const sources = [sourceFixture(SOURCE_A)];
    const snapshots = [snapshotFixture(SOURCE_A, "c".repeat(64))];
    const verdicts = deriveClaimVerdicts(claims, evidence, { now: NOW });
    const tasks = [
      monitoringTaskFixture({
        status: "open",
        affectedEvidenceIds: [evidence[0]!.id],
        affectedClaimIds: [CLAIM_ID]
      })
    ];
    const assessment = projectResearchQuality(
      baseInput({
        claims,
        evidence,
        verdicts,
        sources,
        monitoring: {
          tasks,
          warnings: deriveRevalidationWarnings({
            tasks,
            claims,
            evidence,
            sources,
            latestSnapshots: snapshots
          })
        }
      })
    );

    // The rule fires on the source, on the excerpt and on the claim; the reader
    // owes one re-read of one source, so the list says it once.
    expect(
      assessment.findings.filter((item) => item.category === "stale_source")
    ).toHaveLength(2);
    const reRead = assessment.recommendations.filter(
      (item) => item.action === "open_source_reader"
    );
    expect(reRead).toHaveLength(1);
    expect(reRead[0]?.sourceIds).toEqual([SOURCE_A]);
    expect(reRead[0]?.claimId).toBe(CLAIM_ID);
    expect(reRead[0]?.findingIds).toHaveLength(2);
  });
});

describe("research quality · the sources it lists stay inside the session", () => {
  it("keeps a relation that points outside the session out of the reading", () => {
    const outside = newId();
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, outside)
        ])
      })
    );

    const source = assessment.sourceFindings.find(
      (item) => item.sourceId === SOURCE_A
    );
    expect(source?.confirmedSameOriginSourceIds).toEqual([]);
    expect(source?.undeterminedSourceIds).toEqual([SOURCE_B]);
  });
});

/**
 * The relation vocabulary and its priority, tested as business outcomes: what
 * a source's relation state reads as, and what the independence dimension is
 * allowed to conclude from it.
 *
 * The two axes are deliberately separate and both are pinned here: the
 * per-source `relationStatus` follows a strict priority
 * (confirmed > suspected > unrelated > unknown), while the dimension score is
 * refused entirely while any suspected link is unconfirmed — a suspicion is
 * never promoted to a merge and never to independence either.
 */
describe("research quality · source relation states and their priority", () => {
  const other = () => newId();

  it("reads a content-hash duplicate as confirmed, whatever the titles say", () => {
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          // The default fixture: identical content hash, system-detected.
          linkFixture(SOURCE_A, SOURCE_B)
        ])
      })
    );

    const source = assessment.sourceFindings.find(
      (item) => item.sourceId === SOURCE_A
    );
    expect(source?.relationStatus).toBe("confirmed_same_origin");
    expect(source?.confirmedSameOriginSourceIds).toEqual([SOURCE_B]);
    // Two pages, one information source — the reprint guard holds.
    expect(dimensionOf(assessment, "source_independence").score).toBe(50);
    expect(
      assessment.findings.find((item) => item.category === "duplicate_source")
        ?.reason
    ).toContain("同一份独立信息源");
  });

  it("reads a reprint across two publishers as the same information", () => {
    const sources = [
      sourceFixture(SOURCE_A, { publisher: "Original Bureau" }),
      sourceFixture(SOURCE_B, { publisher: "Reprint Paper" })
    ];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, SOURCE_B, {
            kind: "reprint",
            basis: "content_hash"
          })
        ])
      })
    );

    const source = assessment.sourceFindings.find(
      (item) => item.sourceId === SOURCE_A
    );
    // Different publishers do not make two pages independent; the identical
    // content does make them one information source.
    expect(source?.relationStatus).toBe("confirmed_same_origin");
    expect(source?.confirmedSameOriginSourceIds).toEqual([SOURCE_B]);
    // And the publisher-concentration signal must not fire for this pair.
    expect(
      assessment.findings.find(
        (item) => item.category === "publisher_concentration"
      )
    ).toBeUndefined();
  });

  it("keeps a suspected link suspected no matter how often it appears", () => {
    const sources = [
      sourceFixture(SOURCE_A),
      sourceFixture(SOURCE_B),
      sourceFixture(SOURCE_C)
    ];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, SOURCE_B, {
            kind: "near_duplicate",
            basis: "text_similarity",
            confidence: "suspected"
          }),
          linkFixture(SOURCE_A, SOURCE_C, {
            kind: "near_duplicate",
            basis: "text_similarity",
            confidence: "suspected"
          })
        ])
      })
    );

    const source = assessment.sourceFindings.find(
      (item) => item.sourceId === SOURCE_A
    );
    // Repetition is not confirmation: the state stays suspected.
    expect(source?.relationStatus).toBe("suspected_same_origin");
    expect(source?.suspectedSameOriginSourceIds).toEqual([
      SOURCE_B,
      SOURCE_C
    ].sort());
    expect(source?.confirmedSameOriginSourceIds).toEqual([]);
    // And the dimension refuses to score while a suspicion is open.
    const independence = dimensionOf(assessment, "source_independence");
    expect(independence.score).toBeNull();
    expect(independence.status).toBe("insufficient_data");
  });

  it("prefers confirmed over suspected over unrelated on one source", () => {
    const sources = [
      sourceFixture(SOURCE_A),
      sourceFixture(SOURCE_B),
      sourceFixture(SOURCE_C),
      sourceFixture(other())
    ];
    const fourth = sources[3]!.id;
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, SOURCE_B),
          linkFixture(SOURCE_A, SOURCE_C, {
            kind: "near_duplicate",
            basis: "text_similarity",
            confidence: "suspected"
          }),
          linkFixture(SOURCE_A, fourth, {
            kind: "unrelated",
            basis: "human_assertion",
            origin: "human"
          })
        ])
      })
    );

    const source = assessment.sourceFindings.find(
      (item) => item.sourceId === SOURCE_A
    );
    // One row per relation kind, and the state names the strongest one.
    expect(source?.relationStatus).toBe("confirmed_same_origin");
    expect(source?.confirmedSameOriginSourceIds).toEqual([SOURCE_B]);
    expect(source?.suspectedSameOriginSourceIds).toEqual([SOURCE_C]);
    expect(source?.unrelatedSourceIds).toEqual([fourth]);
    expect(source?.undeterminedSourceIds).toEqual([]);
    // The unrelated statement never merges: A and the fourth page stay apart,
    // so three information sources remain out of four pages.
    expect(dimensionOf(assessment, "source_independence").inputMetrics.pages).toBe(
      4
    );
  });

  it("reads a relation the same way in either direction", () => {
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const forward = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_A, SOURCE_B)
        ])
      })
    );
    const reversed = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(SOURCE_B, SOURCE_A)
        ])
      })
    );

    const read = (assessment: typeof forward, sourceId: string) =>
      assessment.sourceFindings.find((item) => item.sourceId === sourceId);
    expect(read(forward, SOURCE_A)?.confirmedSameOriginSourceIds).toEqual([
      SOURCE_B
    ]);
    expect(read(reversed, SOURCE_A)?.confirmedSameOriginSourceIds).toEqual([
      SOURCE_B
    ]);
    expect(read(forward, SOURCE_B)?.confirmedSameOriginSourceIds).toEqual([
      SOURCE_A
    ]);
    expect(read(reversed, SOURCE_B)?.confirmedSameOriginSourceIds).toEqual([
      SOURCE_A
    ]);
    // The whole reading, not just one field, is direction-independent.
    expect(reversed.sourceFindings).toEqual(forward.sourceFindings);
    expect(dimensionOf(reversed, "source_independence").score).toBe(
      dimensionOf(forward, "source_independence").score
    );
  });

  it("leaves two unconnected sources as unknown, not as independent", () => {
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [])
      })
    );

    for (const sourceId of [SOURCE_A, SOURCE_B]) {
      const source = assessment.sourceFindings.find(
        (item) => item.sourceId === sourceId
      );
      // Nothing was declared and nothing was detected: unknown, and only
      // unknown. A different url is not evidence of independence.
      expect(source?.relationStatus).toBe("unknown");
      expect(source?.confirmedSameOriginSourceIds).toEqual([]);
      expect(source?.unrelatedSourceIds).toEqual([]);
      expect(source?.undeterminedSourceIds).toEqual(
        sourceId === SOURCE_A ? [SOURCE_B] : [SOURCE_A]
      );
    }
    // The dimension reports the merge ratio it can prove, with the standing
    // limitation that an absent duplicate is not a proven independent origin.
    const independence = dimensionOf(assessment, "source_independence");
    expect(independence.score).toBe(100);
    expect(independence.limitations.join(" ")).toContain(
      "未发现可疑重复不代表来源必然独立"
    );
  });

  it("keeps a relation between two outside sources out of the reading", () => {
    const first = other();
    const second = other();
    const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
    const assessment = projectResearchQuality(
      baseInput({
        sources,
        evidence: [evidenceFixture()],
        independence: independenceFixture(sources, [
          linkFixture(first, second),
          linkFixture(SOURCE_A, first)
        ])
      })
    );

    for (const source of assessment.sourceFindings) {
      expect(source.confirmedSameOriginSourceIds).toEqual([]);
      expect(source.suspectedSameOriginSourceIds).toEqual([]);
      expect(source.unrelatedSourceIds).toEqual([]);
    }
    expect(
      assessment.sourceFindings.find((item) => item.sourceId === SOURCE_A)
        ?.undeterminedSourceIds
    ).toEqual([SOURCE_B]);
  });
});
