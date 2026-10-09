import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  ClaimSchema,
  ConflictSchema,
  EvidenceSchema,
  newId,
  SourceSchema,
  type AgentRun,
  type Challenge,
  type Claim,
  type ClaimReview,
  type ClaimVerdict,
  type Conflict,
  type Evidence,
  type Source
} from "@nexus/shared";
import { deriveClaimVerdicts } from "@nexus/shared";
import { buildFactCheckReport } from "./fact-check-report";
import { renderFactCheckReportMarkdown } from "./fact-check-report-markdown";

const SESSION_ID = newId();
const CLAIM_ID = newId();
const SECOND_CLAIM_ID = newId();
const EVIDENCE_ID = newId();
const SOURCE_ID = newId();
const RUN_ID = newId();
/** Stable ids so two builds over "the same material" really are identical. */
const CHALLENGE_ID = newId();
const CHALLENGER_ROLE_ID = newId();
const REVIEW_ID = newId();
const NOW = new Date("2026-02-01T00:00:00.000Z");
const NOW_ISO = NOW.toISOString();

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

function evidenceFixture(overrides: Partial<Evidence> = {}): Evidence {
  return EvidenceSchema.parse({
    id: EVIDENCE_ID,
    sessionId: SESSION_ID,
    claimIds: [CLAIM_ID],
    kind: "external_reference",
    title: "Quarterly figures",
    content: "Shipments rose 12%.",
    description: "Vendor-reported growth.",
    sourceId: SOURCE_ID,
    direction: "supports",
    reliability: 0.6,
    verificationStatus: "verified",
    verifiedBy: "Owner (owner)",
    verifiedAt: NOW_ISO,
    verificationNote: "Checked against page 14.",
    retrievedAt: NOW_ISO,
    createdBy: "human",
    ...overrides
  });
}

function sourceFixture(): Source {
  return SourceSchema.parse({
    id: SOURCE_ID,
    sessionId: SESSION_ID,
    title: "Q4 shipment statistics",
    kind: "document",
    url: "https://example.org/q4.pdf",
    publisher: "Example Bureau",
    createdBy: "human",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  });
}

function challengeFixture(overrides: Partial<Challenge> = {}): Challenge {
  return ChallengeSchema.parse({
    id: CHALLENGE_ID,
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
    requiredEvidence: ["采购记录", "Quarterly figures"],
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

function agentRunFixture(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: RUN_ID,
    sessionId: SESSION_ID,
    roleId: CHALLENGER_ROLE_ID,
    promptVersionId: RUN_ID,
    status: "completed",
    purpose: "cross_review",
    targetClaimId: CLAIM_ID,
    startedAt: NOW_ISO,
    completedAt: NOW_ISO,
    ...overrides
  };
}

function reviewFixture(overrides: Partial<ClaimReview> = {}): ClaimReview {
  return {
    id: REVIEW_ID,
    sessionId: SESSION_ID,
    claimId: CLAIM_ID,
    outcome: "confirmed",
    rationale: "原始报表与主张一致，确认结论。",
    reviewer: "Owner (owner)",
    evidenceIds: [EVIDENCE_ID],
    sourceIds: [SOURCE_ID],
    verdictStatusAtReview: "supported",
    verdictConfidenceAtReview: 0.6,
    createdAt: NOW_ISO,
    ...overrides
  };
}

function build(overrides: {
  claims?: Claim[];
  evidence?: Evidence[];
  sources?: Source[];
  challenges?: Challenge[];
  conflicts?: Conflict[];
  reviews?: ClaimReview[];
  agentRuns?: AgentRun[];
  lastEventSequence?: number;
} = {}) {
  const claims = overrides.claims ?? [claimFixture()];
  const evidence = overrides.evidence ?? [evidenceFixture()];
  const sources = overrides.sources ?? [sourceFixture()];
  const challenges = overrides.challenges ?? [challengeFixture()];
  const conflicts = overrides.conflicts ?? [];
  const reviews = overrides.reviews ?? [reviewFixture()];
  const agentRuns = overrides.agentRuns ?? [agentRunFixture()];

  const verdicts: ClaimVerdict[] = deriveClaimVerdicts(claims, evidence, {
    now: NOW,
    challenges,
    reviews
  });

  return buildFactCheckReport({
    session: {
      id: SESSION_ID,
      researchQuestion: "Did shipments grow last quarter?",
      phase: "ANALYZING",
      operationalStatus: "ACTIVE",
      currentConclusion: null
    },
    claims,
    evidence,
    sources,
    challenges,
    conflicts,
    verdicts,
    reviews,
    agentRuns,
    lastEventSequence: overrides.lastEventSequence ?? 12,
    generatedAt: NOW_ISO
  });
}

describe("fact-check report · content comes from persisted material", () => {
  it("links every citation back to its registered source", () => {
    const report = build();
    const finding = report.findings[0]!;

    expect(finding.supporting).toHaveLength(1);
    const citation = finding.supporting[0]!;
    expect(citation.citationStatus).toBe("linked");
    expect(citation.source?.title).toBe("Q4 shipment statistics");
    expect(citation.source?.publisher).toBe("Example Bureau");
    expect(citation.excerpt).toBe("Shipments rose 12%.");
    expect(citation.verifiedBy).toBe("Owner (owner)");
  });

  it("marks material with no provenance instead of inventing a citation", () => {
    const report = build({
      evidence: [
        evidenceFixture({
          kind: "project_input",
          sourceId: undefined,
          sourceRef: undefined
        })
      ],
      sources: []
    });

    expect(report.findings[0]!.supporting[0]!.citationStatus).toBe("unlinked");
    expect(report.gaps.unlinkedCitations).toHaveLength(1);
    expect(report.limits.join(" ")).toContain("没有来源记录");
  });

  it("distinguishes a bare url from a registered source", () => {
    const report = build({
      evidence: [
        evidenceFixture({
          sourceId: undefined,
          sourceRef: "https://example.org/raw"
        })
      ],
      sources: []
    });

    expect(report.findings[0]!.supporting[0]!.citationStatus).toBe("url_only");
    expect(report.gaps.unlinkedCitations).toHaveLength(0);
  });

  it("separates supporting, opposing, background and excluded material", () => {
    const report = build({
      evidence: [
        evidenceFixture(),
        evidenceFixture({
          id: newId(),
          direction: "opposes",
          title: "Contradicting audit"
        }),
        evidenceFixture({
          id: newId(),
          direction: "context",
          title: "Background note"
        }),
        evidenceFixture({
          id: newId(),
          verificationStatus: "unverified",
          title: "Unchecked claim"
        })
      ],
      challenges: [],
      reviews: []
    });

    const finding = report.findings[0]!;
    expect(finding.supporting).toHaveLength(1);
    expect(finding.opposing).toHaveLength(1);
    expect(finding.context).toHaveLength(1);
    expect(finding.excluded.map((item) => item.title)).toEqual([
      "Unchecked claim"
    ]);
    expect(finding.verdict.status).toBe("mixed_evidence");
  });

  it("excludes expired material from the conclusion and lists it as a limit", () => {
    const report = build({
      evidence: [
        evidenceFixture({
          validityPeriod: { to: "2020-01-01T00:00:00.000Z" }
        })
      ],
      challenges: [],
      reviews: []
    });

    const finding = report.findings[0]!;
    expect(finding.verdict.status).toBe("insufficient_evidence");
    expect(finding.excluded).toHaveLength(1);
    expect(finding.verdict.counts.expired).toBe(1);
  });
});

describe("fact-check report · agent claims are not citations", () => {
  it("marks a challenger's demand as an unverified reference when nothing matches", () => {
    const report = build();
    const challenge = report.findings[0]!.challenges[0]!;

    // "采购记录" matches no registered evidence; "Quarterly figures" does.
    expect(challenge.requiredEvidence).toEqual(["采购记录", "Quarterly figures"]);
    expect(challenge.unverifiedReferences).toEqual(["采购记录"]);
    expect(challenge.registeredEvidenceIds).toEqual([EVIDENCE_ID]);
  });

  it("reports unresolved challenges and open questions", () => {
    const report = build();
    const finding = report.findings[0]!;

    expect(finding.challenges[0]!.unresolved).toBe(true);
    expect(finding.verdict.openQuestions).toHaveLength(1);
    expect(finding.verdict.status).toBe("inconclusive");
    expect(report.crossExamination.challenges).toHaveLength(1);
  });

  it("records failed cross-review runs with their reason", () => {
    const report = build({
      challenges: [],
      agentRuns: [
        agentRunFixture({
          status: "failed",
          error: "Provider returned malformed JSON"
        })
      ]
    });

    expect(report.crossExamination.failedRuns).toHaveLength(1);
    expect(report.crossExamination.failedRuns[0]!.error).toContain("malformed");
  });

  it("collects the gaps a reader needs to judge the conclusion", () => {
    const secondary = claimFixture({
      id: SECOND_CLAIM_ID,
      statement: "The growth will continue next quarter.",
      type: "assumption",
      rootClaimId: SECOND_CLAIM_ID,
      importance: 3
    });
    const report = build({
      claims: [claimFixture(), secondary],
      conflicts: [conflictFixture()],
      reviews: []
    });

    expect(report.gaps.assumptions.map((item) => item.claimId)).toEqual([
      SECOND_CLAIM_ID
    ]);
    expect(report.gaps.insufficientEvidence.map((item) => item.claimId)).toEqual([
      SECOND_CLAIM_ID
    ]);
    expect(report.gaps.unresolvedConflicts).toHaveLength(1);
    expect(report.gaps.unresolvedConflicts[0]!.summary).toContain("Procurement");
  });
});

describe("fact-check report · traceability", () => {
  it("keeps the fingerprint stable for unchanged material", () => {
    expect(build().materialsFingerprint).toBe(build().materialsFingerprint);
  });

  it("changes the fingerprint when any material changes", () => {
    const base = build();
    const changed = build({
      evidence: [evidenceFixture({ reliability: 0.9 })]
    });

    expect(changed.materialsFingerprint).not.toBe(base.materialsFingerprint);
  });

  it("links the report to the exact rows it was built from", () => {
    const report = build({ lastEventSequence: 42 });

    expect(report.provenance.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(report.provenance.sourceIds).toEqual([SOURCE_ID]);
    expect(report.provenance.claimIds).toEqual([CLAIM_ID]);
    expect(report.provenance.agentRunIds).toEqual([RUN_ID]);
    expect(report.provenance.reviewIds).toHaveLength(1);
    expect(report.provenance.lastEventSequence).toBe(42);
    expect(report.scope.reviews).toBe(1);
  });

  it("keeps the derived status visible when a human ruled against it", () => {
    const report = build({
      challenges: [],
      reviews: [
        reviewFixture({
          outcome: "rejected",
          rationale: "原始报表口径与主张不一致，主张不成立。"
        })
      ]
    });
    const verdict = report.findings[0]!.verdict;

    expect(verdict.status).toBe("supported");
    expect(verdict.effectiveStatus).toBe("refuted");
    expect(report.findings[0]!.reviewHistory[0]!.rationale).toContain("不成立");
  });
});

describe("markdown rendering", () => {
  it("states the question, scope, verdicts and traceability", () => {
    const markdown = renderFactCheckReportMarkdown(build());

    expect(markdown).toContain("# 事实核查报告");
    expect(markdown).toContain("Did shipments grow last quarter?");
    expect(markdown).toContain("交叉审查后仍未确定");
    expect(markdown).toContain("材料指纹");
    expect(markdown).toContain("事件序号上界：12");
  });

  it("never presents an unregistered demand as evidence", () => {
    const markdown = renderFactCheckReportMarkdown(build());

    expect(markdown).toContain("没有登记为证据");
    expect(markdown).toContain("采购记录");
  });

  it("says a material is untraceable rather than omitting it", () => {
    const markdown = renderFactCheckReportMarkdown(
      build({
        evidence: [
          evidenceFixture({
            kind: "project_input",
            sourceId: undefined,
            sourceRef: undefined
          })
        ],
        sources: []
      })
    );

    expect(markdown).toContain("**未记录**");
    expect(markdown).toContain("不为其提供引用");
  });

  it("carries the human ruling and the verdict it was made against", () => {
    const markdown = renderFactCheckReportMarkdown(
      build({
        reviews: [
          reviewFixture({
            outcome: "rejected",
            rationale: "原始报表口径与主张不一致，主张不成立。"
          })
        ]
      })
    );

    expect(markdown).toContain("人工复核记录");
    expect(markdown).toContain("人工否证主张");
    expect(markdown).toContain("裁定时的推导结论");
  });

  it("reports failed runs instead of hiding them", () => {
    const markdown = renderFactCheckReportMarkdown(
      build({
        agentRuns: [
          agentRunFixture({ status: "failed", error: "Transport timeout" })
        ]
      })
    );

    expect(markdown).toContain("Transport timeout");
  });
});
