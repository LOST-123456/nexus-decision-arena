import type {
  EvidenceRepository,
  ResearchPlanRepository,
  ResearchSearchRepository,
  RevalidationTaskRepository
} from "@nexus/db";
import {
  type IndependenceSummary,
  type QualityFindingCategory,
  type QualitySeverity,
  type ResearchPlanItem,
  type ResearchQualityAssessment,
  type RevalidationTask,
  type SourceSnapshot
} from "@nexus/shared";
import { deriveRevalidationWarnings } from "./revalidation-warnings";
import { projectResearchQuality } from "./research-quality-projection";
import type { ResearchWorkspace } from "./workspace-service";
import type { SourceIndependenceService } from "./source-independence-service";

/**
 * Research quality assessment — the read-only orchestrator.
 *
 * The service assembles the inputs and the projection does the arithmetic; the
 * split is what keeps the scoring testable without a database. Every dependency
 * below is optional, and an absent one makes the corresponding dimension
 * answer `insufficient_data` instead of guessing:
 *
 *   - independence absent → the source-independence dimension is unknown;
 *   - monitoring absent → the freshness dimension is unknown;
 *   - plan absent → the completeness dimension loses its plan half;
 *   - search absent → search execution facts are not reported at all.
 *
 * There is no cache and no write path. A read never mutates a claim, a
 * verdict, a verification state, a ruling or a saved snapshot, and the same
 * rows always produce the same assessment. The narrow views
 * (`assessClaims` / `assessFindings`) are pure derivations of an assessment
 * that was computed exactly once — either one the caller already holds
 * (`existing`) or one this call computes itself.
 */
export type ResearchQualityDependencies = {
  /** The same workspace projection the research UI renders. */
  workspace: (sessionId: string) => Promise<ResearchWorkspace | null>;
  /** The computed independence reading. Absent when the analysis is off. */
  independence?: Pick<SourceIndependenceService, "analyze">;
  /** Monitoring rows, read directly so the freshness rule sees task status. */
  monitoring?: {
    tasks: Pick<RevalidationTaskRepository, "listTasks">;
    snapshots: Pick<EvidenceRepository, "listLatestSnapshots">;
  };
  /** Current research plan items. Absent when the plan is off. */
  planItems?: Pick<ResearchPlanRepository, "listCurrentPlanItems">;
  /** Controlled search tasks. Absent when search is off. */
  searchTasks?: Pick<ResearchSearchRepository, "listSearchTasksWithCounts">;
  now?: () => Date;
};

/** What a findings query may narrow by. */
export type ResearchQualityFindingFilter = {
  severity?: QualitySeverity | undefined;
  category?: QualityFindingCategory | undefined;
  /** Cap on returned rows; the total is reported alongside. */
  limit?: number | undefined;
};

/**
 * The claims view, derived from an assessment that has already been computed.
 *
 * Pure and synchronous: it reads `assessment.claimFindings` and nothing else,
 * so a caller that already holds an assessment gets this view without a
 * second projection. The `sessionId` guard keeps an assessment belonging to
 * another session from being served under this one's id — the narrow views
 * are session-scoped exactly like the full assessment is.
 */
export function deriveClaimsView(
  sessionId: string,
  assessment: ResearchQualityAssessment
): {
  sessionId: string;
  assessedAt: string;
  ruleVersion: string;
  claimFindings: ResearchQualityAssessment["claimFindings"];
} | null {
  if (assessment.sessionId !== sessionId) return null;
  return {
    sessionId: assessment.sessionId,
    assessedAt: assessment.assessedAt,
    ruleVersion: assessment.ruleVersion,
    claimFindings: assessment.claimFindings
  };
}

/**
 * The findings view, derived from an assessment that has already been
 * computed. The narrowing rules are the ones the endpoint always had —
 * severity and category filters, then the 500-row cap — applied to the
 * assessment's own findings, with the total counted before the cap.
 */
export function deriveFindingsView(
  sessionId: string,
  assessment: ResearchQualityAssessment,
  filter: ResearchQualityFindingFilter = {}
): {
  sessionId: string;
  assessedAt: string;
  ruleVersion: string;
  total: number;
  findings: ResearchQualityAssessment["findings"];
} | null {
  if (assessment.sessionId !== sessionId) return null;
  const narrowed = assessment.findings.filter((finding) => {
    if (filter.severity && finding.severity !== filter.severity) return false;
    if (filter.category && finding.category !== filter.category) return false;
    return true;
  });
  const limit =
    typeof filter.limit === "number" && filter.limit > 0
      ? Math.min(filter.limit, 500)
      : undefined;
  return {
    sessionId: assessment.sessionId,
    assessedAt: assessment.assessedAt,
    ruleVersion: assessment.ruleVersion,
    total: narrowed.length,
    findings: limit ? narrowed.slice(0, limit) : narrowed
  };
}

export class ResearchQualityService {
  constructor(private readonly dependencies: ResearchQualityDependencies) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  /**
   * The full assessment for a session, or null when the session does not
   * exist. An empty session is a valid assessment (every dimension answers
   * `insufficient_data`); only an unknown session is null.
   */
  async assess(
    sessionId: string
  ): Promise<ResearchQualityAssessment | null> {
    const workspace = await this.dependencies.workspace(sessionId);
    if (!workspace) {
      return null;
    }

    const [independence, monitoring, planItems, searchTasks] =
      await Promise.all([
        this.readIndependence(sessionId),
        this.readMonitoring(sessionId, workspace),
        this.readPlanItems(sessionId),
        this.readSearchTasks(sessionId)
      ]);

    return projectResearchQuality({
      sessionId,
      assessedAt: this.now().toISOString(),
      claims: workspace.claims,
      evidence: workspace.evidence,
      sources: workspace.sources,
      conflicts: workspace.conflicts,
      challenges: workspace.challenges,
      verdicts: workspace.verdicts.map((verdict) => ({
        claimId: verdict.claimId,
        status: verdict.status,
        counts: {
          total: verdict.counts.total,
          verified: verdict.counts.verified,
          unverified: verdict.counts.unverified,
          verifiedSupporting: verdict.counts.verifiedSupporting,
          verifiedOpposing: verdict.counts.verifiedOpposing
        },
        basis: {
          supportingEvidenceIds: verdict.basis.supportingEvidenceIds,
          opposingEvidenceIds: verdict.basis.opposingEvidenceIds
        }
      })),
      gaps: workspace.gaps,
      agentRuns: workspace.agentRuns,
      independence,
      monitoring,
      planItems,
      searchTasks
    });
  }

  /**
   * The claim-level diagnostics alone, for a claim-oriented view.
   *
   * `existing` lets a caller that has already computed an assessment reuse
   * it: the view is then a pure derivation with zero database reads and zero
   * projection work. Without it, one assessment is computed — never two.
   */
  async assessClaims(
    sessionId: string,
    existing?: ResearchQualityAssessment | null
  ): Promise<{
    sessionId: string;
    assessedAt: string;
    ruleVersion: string;
    claimFindings: ResearchQualityAssessment["claimFindings"];
  } | null> {
    const assessment = existing ?? (await this.assess(sessionId));
    if (!assessment) return null;
    return deriveClaimsView(sessionId, assessment);
  }

  /**
   * The findings alone, optionally narrowed. The total is the unfiltered
   * count, so a limited view still says how much there is.
   *
   * `existing` reuses an assessment this caller already holds, so picking a
   * severity never re-runs the projection; the same derivation is what the
   * full assessment's findings come from.
   */
  async assessFindings(
    sessionId: string,
    filter: ResearchQualityFindingFilter = {},
    existing?: ResearchQualityAssessment | null
  ): Promise<{
    sessionId: string;
    assessedAt: string;
    ruleVersion: string;
    total: number;
    findings: ResearchQualityAssessment["findings"];
  } | null> {
    const assessment = existing ?? (await this.assess(sessionId));
    if (!assessment) return null;
    return deriveFindingsView(sessionId, assessment, filter);
  }

  /* ---------------------------------------------------------------- *
   * Optional inputs
   * ---------------------------------------------------------------- */

  private async readIndependence(
    sessionId: string
  ): Promise<IndependenceSummary | null> {
    if (!this.dependencies.independence) return null;
    try {
      const analysis = await this.dependencies.independence.analyze(sessionId);
      return analysis.summary;
    } catch {
      // An analysis that cannot run is unknown, not zero: the dimension says
      // so rather than silently scoring the session as independent.
      return null;
    }
  }

  private async readMonitoring(
    sessionId: string,
    workspace: ResearchWorkspace
  ): Promise<{
    tasks: RevalidationTask[];
    warnings: ReturnType<typeof deriveRevalidationWarnings>;
  } | null> {
    const monitoring = this.dependencies.monitoring;
    if (!monitoring) return null;
    try {
      const [tasks, snapshots] = await Promise.all([
        monitoring.tasks.listTasks(sessionId),
        monitoring.snapshots.listLatestSnapshots(sessionId)
      ]);
      // Derived here from the same rows rather than read again through the
      // monitor service, so the freshness rule and the report cannot disagree
      // about what a change reaches.
      const warnings = deriveRevalidationWarnings({
        tasks,
        claims: workspace.claims,
        evidence: workspace.evidence,
        sources: workspace.sources,
        latestSnapshots: snapshots as SourceSnapshot[]
      });
      return { tasks, warnings };
    } catch {
      return null;
    }
  }

  private async readPlanItems(
    sessionId: string
  ): Promise<ResearchPlanItem[]> {
    if (!this.dependencies.planItems) return [];
    try {
      return await this.dependencies.planItems.listCurrentPlanItems(sessionId);
    } catch {
      return [];
    }
  }

  private async readSearchTasks(
    sessionId: string
  ): Promise<Array<{ id: string; status: string }> | null> {
    if (!this.dependencies.searchTasks) return null;
    try {
      const tasks = await this.dependencies.searchTasks.listSearchTasksWithCounts(
        sessionId
      );
      return tasks.map((task) => ({ id: task.id, status: task.status }));
    } catch {
      return null;
    }
  }
}
