import { describe, expect, it } from "vitest";
import {
  ClaimSchema,
  deriveClaimVerdicts,
  EvidenceSchema,
  newId,
  ResearchPlanItemSchema,
  ResearchSearchTaskSchema,
  SourceSchema,
  SourceSnapshotSchema,
  summarizeIndependence,
  type Claim,
  type ClaimVerdict,
  type Evidence,
  type IndependenceSummary,
  type ResearchPlanItem,
  type ResearchSearchTask,
  type RevalidationTask,
  type Source,
  type SourceLink,
  type SourceSnapshot
} from "@nexus/shared";
import { ResearchQualityService } from "./research-quality-service";
import type { ResearchWorkspace } from "./workspace-service";
import { deriveRevalidationWarnings } from "./revalidation-warnings";

/**
 * The read-only orchestrator, tested with every dependency faked.
 *
 * The boundary under test: the service assembles inputs and nothing else. It
 * never writes, an absent or failing optional dependency makes the matching
 * dimension answer `insufficient_data` instead of a guessed number, and only
 * an unknown session is null — an empty session is a real assessment.
 */

const SESSION_ID = newId();
const CLAIM_ID = newId();
const SOURCE_A = newId();
const SOURCE_B = newId();
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

function snapshotFixture(sourceId: string): SourceSnapshot {
  return SourceSnapshotSchema.parse({
    id: newId(),
    sessionId: SESSION_ID,
    sourceId,
    canonicalUrl: `https://example.org/${sourceId}`,
    contentHash: "a".repeat(64),
    contentType: "text/html",
    content: "Shipments rose 12%.",
    contentBytes: 19,
    charCount: 19,
    retrievedAt: NOW_ISO,
    createdAt: NOW_ISO
  });
}

function monitoringTaskFixture(
  overrides: Partial<RevalidationTask> = {}
): RevalidationTask {
  return {
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
  } as RevalidationTask;
}

function planItemFixture(gapId: string, status: ResearchPlanItem["status"]) {
  return ResearchPlanItemSchema.parse({
    id: newId(),
    sessionId: SESSION_ID,
    gapId,
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
    status,
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

function searchTaskFixture(status: ResearchSearchTask["status"]) {
  return ResearchSearchTaskSchema.parse({
    id: newId(),
    sessionId: SESSION_ID,
    planItemId: newId(),
    query: "采购记录",
    purpose: "补齐已核实支持证据",
    keywords: ["采购记录"],
    status,
    failureReason: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    finishedAt: null
  });
}

function workspaceFixture(input: {
  claims: Claim[];
  evidence: Evidence[];
  sources: Source[];
  verdicts: ClaimVerdict[];
  gaps: ResearchWorkspace["gaps"];
}): ResearchWorkspace {
  return {
    session: {
      id: SESSION_ID,
      phase: "EVIDENCE",
      operationalStatus: "running",
      researchQuestion: null,
      currentConclusion: null
    },
    claims: input.claims,
    evidence: input.evidence,
    sources: input.sources,
    conflicts: [],
    challenges: [],
    agentRuns: [],
    reviews: [],
    verdicts: input.verdicts,
    gaps: input.gaps,
    openReviewRequests: [],
    summary: {
      claims: input.claims.length,
      evidence: input.evidence.length,
      sources: input.sources.length,
      challenges: 0,
      unresolvedChallenges: 0,
      reviews: 0,
      failedRuns: 0,
      verified: input.evidence.filter((item) => item.verificationStatus === "verified")
        .length,
      unverified: 0,
      rejected: 0,
      openVerdicts: 0,
      needsMoreEvidence: 0,
      blockingGaps: input.gaps.filter((gap) => gap.severity === "blocking")
        .length
    }
  };
}

/** The workspace the assessment reads: one verified claim, two pages, no gaps. */
function populatedWorkspace(): ResearchWorkspace {
  const claims = [claimFixture()];
  const evidence = [evidenceFixture()];
  const sources = [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)];
  return workspaceFixture({
    claims,
    evidence,
    sources,
    verdicts: deriveClaimVerdicts(claims, evidence, { now: NOW }),
    gaps: []
  });
}

function independenceSummary(
  sources: Source[],
  links: SourceLink[]
): IndependenceSummary {
  return summarizeIndependence({ sessionId: SESSION_ID, sources, links });
}

describe("ResearchQualityService.assess", () => {
  it("answers null only for a session that does not exist", async () => {
    const service = new ResearchQualityService({
      workspace: async () => null
    });

    expect(await service.assess(SESSION_ID)).toBeNull();
    expect(await service.assessClaims(SESSION_ID)).toBeNull();
    expect(await service.assessFindings(SESSION_ID)).toBeNull();
  });

  it("treats an empty session as a real assessment, not an error", async () => {
    const service = new ResearchQualityService({
      workspace: async () =>
        workspaceFixture({ claims: [], evidence: [], sources: [], verdicts: [], gaps: [] }),
      now: () => NOW
    });

    const assessment = await service.assess(SESSION_ID);
    expect(assessment).not.toBeNull();
    expect(assessment!.dimensions.every((item) => item.score === null)).toBe(true);
    expect(assessment!.overall.score).toBeNull();
    expect(assessment!.assessedAt).toBe(NOW_ISO);
    expect(assessment!.ruleVersion).toBe("research-quality-v1");
    expect(assessment!.limitations.join(" ")).toContain("只读投影");
  });

  it("uses the injected clock so two reads of one row set agree", async () => {
    const workspace = populatedWorkspace();
    const service = new ResearchQualityService({
      workspace: async () => workspace,
      now: () => NOW
    });

    const first = await service.assess(SESSION_ID);
    const second = await service.assess(SESSION_ID);
    expect(first!.assessedAt).toBe(NOW_ISO);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("reads the optional analyses when they are wired", async () => {
    const workspace = populatedWorkspace();
    const tasks = [
      monitoringTaskFixture({ status: "resolved" }),
      monitoringTaskFixture({ id: newId(), status: "open" })
    ];
    const service = new ResearchQualityService({
      workspace: async () => workspace,
      independence: {
        analyze: async () => ({
          sessionId: SESSION_ID,
          algorithm: "source-independence-v1",
          generatedAt: NOW_ISO,
          summary: independenceSummary(workspace.sources, []),
          links: [],
          profiles: [],
          humanRelations: []
        })
      },
      monitoring: {
        tasks: { listTasks: async () => tasks },
        snapshots: {
          listLatestSnapshots: async () =>
            workspace.sources.map((source) => snapshotFixture(source.id))
        }
      },
      planItems: {
        listCurrentPlanItems: async () => [planItemFixture("gap-1", "completed")]
      },
      searchTasks: {
        listSearchTasksWithCounts: async () => [
          { ...searchTaskFixture("queued"), candidateCount: 3 }
        ]
      },
      now: () => NOW
    });

    const assessment = await service.assess(SESSION_ID);
    const freshness = assessment!.dimensions.find(
      (item) => item.id === "source_freshness"
    );
    const completeness = assessment!.dimensions.find(
      (item) => item.id === "research_completeness"
    );
    const independence = assessment!.dimensions.find(
      (item) => item.id === "source_independence"
    );

    // Two settled checks out of four rows: half handled, half still open.
    expect(freshness?.score).toBe(50);
    expect(completeness?.inputMetrics.searchTasksCreated).toBe(1);
    expect(completeness?.inputMetrics.searchTasksExecuted).toBe(0);
    expect(independence?.score).toBe(100);
  });

  it("answers unknown — never zero — when an optional analysis cannot run", async () => {
    const workspace = populatedWorkspace();
    const service = new ResearchQualityService({
      workspace: async () => workspace,
      independence: {
        analyze: async () => {
          throw new Error("analysis unavailable");
        }
      },
      monitoring: {
        tasks: {
          listTasks: async () => {
            throw new Error("monitoring unavailable");
          }
        },
        snapshots: {
          listLatestSnapshots: async () => {
            throw new Error("snapshots unavailable");
          }
        }
      },
      planItems: {
        listCurrentPlanItems: async () => {
          throw new Error("plan unavailable");
        }
      },
      searchTasks: {
        listSearchTasksWithCounts: async () => {
          throw new Error("search unavailable");
        }
      },
      now: () => NOW
    });

    const assessment = await service.assess(SESSION_ID);
    const byId = new Map(
      assessment!.dimensions.map((item) => [item.id, item])
    );
    expect(byId.get("source_independence")?.status).toBe("insufficient_data");
    expect(byId.get("source_independence")?.score).toBeNull();
    expect(byId.get("source_freshness")?.status).toBe("insufficient_data");
    // The plan half is simply absent, and the search facts are not invented.
    expect(byId.get("research_completeness")?.inputMetrics.planItems).toBe(0);
    expect(byId.get("research_completeness")?.inputMetrics.searchAvailable).toBe(
      false
    );
    expect(assessment!.limitations.join(" ")).toContain("来源独立性分析不可用");
  });

  it("never mutates the rows it was handed", async () => {
    const workspace = populatedWorkspace();
    const frozen = JSON.stringify(workspace);
    const service = new ResearchQualityService({
      workspace: async () => workspace,
      now: () => NOW
    });

    await service.assess(SESSION_ID);
    expect(JSON.stringify(workspace)).toBe(frozen);
  });
});

describe("ResearchQualityService.assessFindings", () => {
  function serviceWithFindings(): ResearchQualityService {
    // One important claim with no material behind it (critical) and two pages
    // from the same publisher (info): mixed severities to narrow by.
    const claims = [claimFixture()];
    const workspace = workspaceFixture({
      claims,
      evidence: [],
      sources: [sourceFixture(SOURCE_A), sourceFixture(SOURCE_B)],
      verdicts: deriveClaimVerdicts(claims, [], { now: NOW }),
      gaps: []
    });
    return new ResearchQualityService({
      workspace: async () => workspace,
      now: () => NOW
    });
  }

  it("narrows by severity and category and still reports the total", async () => {
    const service = serviceWithFindings();
    const all = await service.assessFindings(SESSION_ID);
    expect(all).not.toBeNull();
    expect(all!.total).toBe(all!.findings.length);

    const critical = await service.assessFindings(SESSION_ID, {
      severity: "critical"
    });
    expect(critical!.findings.every((item) => item.severity === "critical")).toBe(
      true
    );
    expect(critical!.total).toBeLessThan(all!.total);

    const missing = await service.assessFindings(SESSION_ID, {
      category: "missing_evidence"
    });
    expect(missing!.findings.length).toBeGreaterThan(0);
    expect(
      missing!.findings.every((item) => item.category === "missing_evidence")
    ).toBe(true);
  });

  it("caps what it returns without capping what it counted", async () => {
    const service = serviceWithFindings();
    const limited = await service.assessFindings(SESSION_ID, { limit: 1 });
    expect(limited!.findings).toHaveLength(1);
    expect(limited!.total).toBeGreaterThan(1);
  });
});

describe("ResearchQualityService.assessClaims", () => {
  it("returns the claim-level diagnostics for a real session", async () => {
    const claims = [claimFixture()];
    const evidence = [evidenceFixture()];
    const workspace = workspaceFixture({
      claims,
      evidence,
      sources: [sourceFixture(SOURCE_A)],
      verdicts: deriveClaimVerdicts(claims, evidence, { now: NOW }),
      gaps: []
    });
    const service = new ResearchQualityService({
      workspace: async () => workspace,
      now: () => NOW
    });

    const claims$ = await service.assessClaims(SESSION_ID);
    expect(claims$).not.toBeNull();
    expect(claims$!.claimFindings).toHaveLength(1);
    expect(claims$!.claimFindings[0]!.claimId).toBe(CLAIM_ID);
    expect(claims$!.ruleVersion).toBe("research-quality-v1");
  });
});

describe("ResearchQualityService · the warnings the report reads", () => {
  it("derives the same warnings the monitor service would", async () => {
    const workspace = populatedWorkspace();
    const evidence = workspace.evidence[0]!;
    const tasks = [
      monitoringTaskFixture({
        status: "open",
        affectedEvidenceIds: [evidence.id],
        affectedClaimIds: [CLAIM_ID]
      })
    ];
    const service = new ResearchQualityService({
      workspace: async () => workspace,
      monitoring: {
        tasks: { listTasks: async () => tasks },
        snapshots: {
          listLatestSnapshots: async () =>
            workspace.sources.map((source) => snapshotFixture(source.id))
        }
      },
      now: () => NOW
    });

    const assessment = await service.assess(SESSION_ID);
    const warnings = deriveRevalidationWarnings({
      tasks,
      claims: workspace.claims,
      evidence: workspace.evidence,
      sources: workspace.sources,
      latestSnapshots: workspace.sources.map((source) => snapshotFixture(source.id))
    });
    // The freshness rule and the re-read warning see the same affected claim.
    expect(
      assessment!.claimFindings[0]!.sourceUpdateRiskCount
    ).toBe(warnings.evidenceNeedingReconfirmation.length);
  });
});
