import { describe, expect, it } from "vitest";
import {
  ChallengeSchema,
  ClaimSchema,
  ConflictSchema,
  EvidenceSchema,
  newId,
  RevalidationTaskSchema,
  SourceSchema,
  SourceSnapshotSchema,
  type AgentRun,
  type Challenge,
  type Claim,
  type ClaimReview,
  type ClaimVerdict,
  type Conflict,
  type Evidence,
  type RevalidationReportWarnings,
  type RevalidationTask,
  type Source,
  type SourceSnapshot
} from "@nexus/shared";
import { deriveClaimVerdicts } from "@nexus/shared";
import {
  buildFactCheckReport,
  type FactCheckPlanItemRef
} from "./fact-check-report";
import { renderFactCheckReportMarkdown } from "./fact-check-report-markdown";
import { deriveRevalidationWarnings } from "./revalidation-warnings";

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
/** A second source in the same session, the one that drifted. */
const CHANGED_SOURCE_ID = newId();
const OLD_HASH = "a".repeat(64);
const NEW_HASH = "b".repeat(64);

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

function changedSourceFixture(): Source {
  return SourceSchema.parse({
    id: CHANGED_SOURCE_ID,
    sessionId: SESSION_ID,
    title: "Vendor blog",
    kind: "url",
    url: "https://example.org/vendor-blog",
    publisher: "Vendor",
    createdBy: "human",
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO
  });
}

function snapshotFixture(
  sourceId: string,
  contentHash: string,
  overrides: Partial<SourceSnapshot> = {}
): SourceSnapshot {
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
    createdAt: NOW_ISO,
    ...overrides
  });
}

function monitoringTaskFixture(
  overrides: Partial<RevalidationTask> = {}
): RevalidationTask {
  return RevalidationTaskSchema.parse({
    id: newId(),
    sessionId: SESSION_ID,
    sourceId: SOURCE_ID,
    sourceTitle: "Q4 shipment statistics",
    triggerContentHash: NEW_HASH,
    previousSnapshotId: null,
    currentSnapshotId: null,
    affectedEvidenceIds: [EVIDENCE_ID],
    affectedClaimIds: [CLAIM_ID],
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

/** One open task on the drifted source plus one in review on the second. */
function monitoringWarningsFixture(): RevalidationReportWarnings {
  return deriveRevalidationWarnings({
    tasks: [
      monitoringTaskFixture(),
      monitoringTaskFixture({
        id: newId(),
        sourceId: CHANGED_SOURCE_ID,
        sourceTitle: "Vendor blog",
        status: "in_review"
      })
    ],
    claims: [claimFixture()],
    evidence: [evidenceFixture()],
    sources: [sourceFixture(), changedSourceFixture()],
    latestSnapshots: [
      snapshotFixture(SOURCE_ID, NEW_HASH),
      snapshotFixture(CHANGED_SOURCE_ID, OLD_HASH)
    ]
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
  planItems?: FactCheckPlanItemRef[];
  revalidation?: RevalidationReportWarnings;
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
    generatedAt: NOW_ISO,
    ...(overrides.planItems ? { planItems: overrides.planItems } : {}),
    ...(overrides.revalidation
      ? { revalidation: overrides.revalidation }
      : {})
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

describe("fact-check report · source monitoring is reported, never folded in", () => {
  it("carries the monitoring warnings next to the conclusion", () => {
    const report = build({ revalidation: monitoringWarningsFixture() });

    expect(report.revalidation?.openTaskCount).toBe(1);
    expect(report.revalidation?.inReviewTaskCount).toBe(1);
    expect(
      report.revalidation?.changedSources.map((item) => item.title).sort()
    ).toEqual(["Q4 shipment statistics", "Vendor blog"]);
    expect(
      report.revalidation?.evidenceNeedingReconfirmation.map(
        (item) => item.title
      )
    ).toEqual(["Quarterly figures"]);
    expect(
      report.revalidation?.affectedClaims.map((item) => item.statement)
    ).toEqual(["Shipments grew 12% last quarter."]);
    expect(report.revalidation?.lastCheckedAt).toBe(NOW_ISO);
    // The exact version each conclusion was drawn from stays on the record.
    expect(
      report.revalidation?.sourceVersions.map((item) => item.contentHash).sort()
    ).toEqual([OLD_HASH, NEW_HASH]);
  });

  it("names the open re-checks as a limit without touching the verdict", () => {
    const before = build();
    const report = build({ revalidation: monitoringWarningsFixture() });

    expect(report.limits.join(" ")).toContain(
      "有 1 项待处理、1 项复核中的来源变化：相关结论所依据的材料版本可能已更新，结论本身未因此改变。"
    );
    // Monitoring cannot reach the verdict pipeline: same material, same verdict.
    expect(report.findings.map((finding) => finding.verdict)).toEqual(
      before.findings.map((finding) => finding.verdict)
    );
    expect(report.materialsFingerprint).toBe(before.materialsFingerprint);
  });

  it("omits the revalidation block entirely when monitoring never ran", () => {
    const report = build();

    expect(report.revalidation).toBeUndefined();
    expect(report.limits.join(" ")).not.toContain("来源变化");
  });

  it("stays silent in the limits when every task is already closed", () => {
    const closed = deriveRevalidationWarnings({
      tasks: [
        monitoringTaskFixture({ status: "resolved" }),
        monitoringTaskFixture({
          id: newId(),
          sourceId: CHANGED_SOURCE_ID,
          sourceTitle: "Vendor blog",
          status: "dismissed"
        })
      ],
      claims: [claimFixture()],
      evidence: [evidenceFixture()],
      sources: [sourceFixture(), changedSourceFixture()],
      latestSnapshots: [
        snapshotFixture(SOURCE_ID, NEW_HASH),
        snapshotFixture(CHANGED_SOURCE_ID, OLD_HASH)
      ]
    });
    const report = build({ revalidation: closed });

    expect(report.revalidation?.openTaskCount).toBe(0);
    expect(report.revalidation?.inReviewTaskCount).toBe(0);
    expect(report.limits.join(" ")).not.toContain("来源变化");
    // The versions the report was built from are still on the record.
    expect(
      report.revalidation?.sourceVersions.map((item) => item.contentHash).sort()
    ).toEqual([OLD_HASH, NEW_HASH]);
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

describe("fact-check report · explainability and gaps", () => {
  it("names the evidence that took part, split by direction", () => {
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
        })
      ],
      challenges: [],
      reviews: []
    });
    const basis = report.findings[0]!.verdict.basis;

    expect(basis.supportingEvidenceIds).toEqual([EVIDENCE_ID]);
    expect(basis.opposingEvidenceIds).toHaveLength(1);
    expect(basis.contextEvidenceIds).toHaveLength(1);
  });

  it("records every excluded row with the reason it was left out", () => {
    const unchecked = evidenceFixture({
      id: newId(),
      verificationStatus: "unverified",
      verifiedBy: undefined,
      verificationNote: undefined
    });
    const stale = evidenceFixture({
      id: newId(),
      validityPeriod: { to: "2020-01-01T00:00:00.000Z" }
    });
    const report = build({
      evidence: [evidenceFixture(), unchecked, stale],
      challenges: [],
      reviews: []
    });

    expect(report.findings[0]!.verdict.excluded).toEqual(
      expect.arrayContaining([
        { evidenceId: unchecked.id, reason: "unverified" },
        { evidenceId: stale.id, reason: "expired" }
      ])
    );
  });

  it("reports at least one rule hit and a stated confidence basis", () => {
    const report = build();
    const verdict = report.findings[0]!.verdict;

    expect(verdict.ruleHits.length).toBeGreaterThan(0);
    expect(verdict.confidenceBasis.join(" ")).toContain("不是模型自报的概率");
  });

  it("reports the time range the examined material actually covers", () => {
    const report = build();

    expect(report.materialsTimeRange.empty).toBe(false);
    expect(report.materialsTimeRange.retrievedAt.earliest).toBe(NOW_ISO);
    // No source declares a publication date, so none is invented.
    expect(report.materialsTimeRange.publishedAt.earliest).toBeNull();
  });

  it("marks the time range empty when no material declares any date", () => {
    const report = build({ evidence: [], sources: [], challenges: [], reviews: [] });

    expect(report.materialsTimeRange.empty).toBe(true);
  });

  it("gathers a rule-based gap list for each claim", () => {
    const report = build();
    const finding = report.findings[0]!;

    // A severe unresolved challenge and an unanswered demand are both present.
    expect(finding.gaps.map((gap) => gap.kind)).toEqual(
      expect.arrayContaining(["unresolved_dispute", "unmapped_reference"])
    );
    expect(finding.blockingGapCount).toBeGreaterThan(0);
    for (const gap of finding.gaps) {
      expect(gap.claimId).toBe(CLAIM_ID);
      expect(gap.actions.length).toBeGreaterThan(0);
      for (const proposal of gap.suggestions) {
        expect(proposal.status).toBe("suggested");
      }
    }
  });

  it("aggregates gaps by severity and kind", () => {
    const report = build();
    const summary = report.gaps.evidenceGaps;

    expect(summary.total).toBeGreaterThan(0);
    expect(summary.bySeverity.blocking).toBeGreaterThan(0);
    expect(summary.byKind.unresolved_dispute).toBe(1);
    expect(summary.total).toBe(
      summary.bySeverity.blocking +
        summary.bySeverity.important +
        summary.bySeverity.advisory
    );
  });

  it("says so in the limits when gaps block the conclusions", () => {
    const report = build();

    expect(report.limits.join(" ")).toContain("阻断性证据缺口");
  });
});

describe("fact-check report · research plan linkage", () => {
  it("marks every gap not planned when no plan is configured", () => {
    const report = build();
    const finding = report.findings[0]!;

    expect(finding.gaps.length).toBeGreaterThan(0);
    for (const gap of finding.gaps) {
      expect(gap.plan.status).toBe("not_planned");
      expect(gap.plan.note).toBeNull();
    }
    expect(report.gaps.evidenceGaps.planned).toBe(0);
    expect(report.gaps.evidenceGaps.notPlanned).toBe(
      report.gaps.evidenceGaps.total
    );
  });

  it("annotates a planned gap with the plan's status and its own words", () => {
    const unplanned = build();
    const gapId = unplanned.findings[0]!.gaps[0]!.id;

    const report = build({
      planItems: [
        {
          gapId,
          status: "queued",
          decisionReason: null,
          failureReason: null,
          outcome: null
        }
      ]
    });
    const finding = report.findings[0]!;
    const planned = finding.gaps.find((gap) => gap.id === gapId)!;

    expect(planned.plan.status).toBe("queued");
    expect(planned.plan.note).toContain("尚未执行任何检索");
    expect(report.gaps.evidenceGaps.planned).toBe(1);
    expect(report.limits.join(" ")).toContain("尚未执行任何检索");
  });

  it("quotes the recorded outcome as the note on a completed gap", () => {
    const unplanned = build();
    const gapId = unplanned.findings[0]!.gaps[0]!.id;

    const report = build({
      planItems: [
        {
          gapId,
          status: "completed",
          decisionReason: null,
          failureReason: null,
          outcome: {
            summary: "在行业年报中找到覆盖同一时期的原始统计表。",
            sourceIds: [],
            evidenceIds: [],
            recordedBy: "Owner (owner)",
            recordedAt: NOW_ISO
          }
        }
      ]
    });
    const planned = report.findings[0]!.gaps.find((gap) => gap.id === gapId)!;

    expect(planned.plan.status).toBe("completed");
    expect(planned.plan.note).toContain("行业年报");
  });

  it("renders the plan status line in markdown", () => {
    const unplanned = build();
    const gapId = unplanned.findings[0]!.gaps[0]!.id;
    const report = build({
      planItems: [
        {
          gapId,
          status: "queued",
          decisionReason: null,
          failureReason: null,
          outcome: null
        }
      ]
    });
    const markdown = renderFactCheckReportMarkdown(report);

    expect(markdown).toContain("研究计划：已加入研究计划，尚未执行");
    expect(markdown).toContain("研究计划：尚未加入研究计划");
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

  it("states the material time range and the per-claim gaps", () => {
    const markdown = renderFactCheckReportMarkdown(build());

    expect(markdown).toContain("所用资料时间范围");
    expect(markdown).toContain("资料有效期范围");
    expect(markdown).toContain("**证据缺口与建议补充材料**");
    expect(markdown).toContain("建议（待验证，未执行检索）");
    expect(markdown).toContain("命中规则");
  });

  it("renders the monitoring warnings exactly as the json reports them", () => {
    const report = build({ revalidation: monitoringWarningsFixture() });
    const markdown = renderFactCheckReportMarkdown(report);
    const warnings = report.revalidation!;

    expect(markdown).toContain("## 来源监测与重新核查");
    expect(markdown).toContain(
      `- 待处理复核任务：${warnings.openTaskCount} 项；复核中：${warnings.inReviewTaskCount} 项`
    );
    expect(markdown).toContain(`- 最近一次来源检查：${warnings.lastCheckedAt}`);
    for (const source of warnings.changedSources) {
      expect(markdown).toContain(
        `《${source.title}》（检查于 ${source.checkedAt}，当前版本 ${source.currentContentHash.slice(0, 12)}…）`
      );
    }
    // Each block lands under its own heading, so a reader can tell what kind
    // of statement they are looking at.
    const reconfirmAt = markdown.indexOf("需要再次确认的材料：");
    expect(reconfirmAt).toBeGreaterThan(-1);
    for (const item of warnings.evidenceNeedingReconfirmation) {
      expect(markdown.slice(reconfirmAt)).toContain(`${item.title}：${item.reason}`);
    }
    const claimsAt = markdown.indexOf("可能受影响、建议重新核查的主张：");
    expect(claimsAt).toBeGreaterThan(-1);
    for (const claim of warnings.affectedClaims) {
      expect(markdown.slice(claimsAt)).toContain(claim.statement);
    }
    const versionsAt = markdown.indexOf("报告所用来源版本：");
    expect(versionsAt).toBeGreaterThan(-1);
    for (const version of warnings.sourceVersions) {
      expect(markdown.slice(versionsAt)).toContain(
        `《${version.title}》：${version.contentHash ? `${version.contentHash.slice(0, 12)}…` : "无已保存版本"}`
      );
    }
    // The same sentence the json limits carry, and the standing disclaimer
    // that a drift is a reason to re-read, never a changed conclusion.
    expect(markdown).toContain(
      "有 1 项待处理、1 项复核中的来源变化：相关结论所依据的材料版本可能已更新，结论本身未因此改变。"
    );
    expect(markdown).toContain("以上变化不改变本报告任何结论");
  });

  it("omits the monitoring section when monitoring never ran", () => {
    const markdown = renderFactCheckReportMarkdown(build());

    expect(markdown).not.toContain("来源监测与重新核查");
  });
});
