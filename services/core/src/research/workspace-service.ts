import {
  type ArenaRepository,
  type EvidenceRepository,
  type ReviewRepository
} from "@nexus/db";
import {
  deriveClaimVerdicts,
  diagnoseEvidenceGaps,
  type AgentRun,
  type Challenge,
  type Claim,
  type ClaimReview,
  type ClaimVerdict,
  type Conflict,
  type Evidence,
  type EvidenceGap,
  type Source,
  summarizeVerification
} from "@nexus/shared";

export type WorkspacePhaseState = {
  id: string;
  phase: string;
  operationalStatus: string;
  researchQuestion: string | null;
  currentConclusion: string | null;
};

export type ResearchWorkspace = {
  session: WorkspacePhaseState;
  claims: Claim[];
  evidence: Evidence[];
  sources: Source[];
  conflicts: Conflict[];
  /** Cross-examination challenges recorded for this session. */
  challenges: Challenge[];
  /** Agent runs (analysis and cross-review) with their real status. */
  agentRuns: AgentRun[];
  /** Human fact-check rulings, oldest first. */
  reviews: ClaimReview[];
  /**
   * One verdict per claim, computed from evidence, cross-examination and
   * human rulings.
   */
  verdicts: ClaimVerdict[];
  /**
   * Rule-based diagnoses of what each claim is still missing. Flattened with
   * `claimId` on every entry so the UI can attach them to the right claim.
   */
  gaps: EvidenceGap[];
  /**
   * Reviews whose outcome was `needs_more_evidence`, latest per claim. These
   * are the open requests a researcher still has to act on — a persisted,
   * traceable item rather than a passing notification.
   */
  openReviewRequests: ClaimReview[];
  summary: {
    claims: number;
    evidence: number;
    sources: number;
    challenges: number;
    unresolvedChallenges: number;
    reviews: number;
    failedRuns: number;
    verified: number;
    unverified: number;
    rejected: number;
    /** Claims that still have material which could change their verdict. */
    openVerdicts: number;
    /** Claims whose latest human ruling asked for more evidence. */
    needsMoreEvidence: number;
    /** Total blocking gaps across all claims. */
    blockingGaps: number;
  };
};

/**
 * Assembles the research workspace.
 *
 * The verdicts are derived, never stored: they are a projection of what is
 * currently verified plus the cross-examination and rulings that actually
 * happened, so they cannot drift from the material and cannot be typed in.
 */
export class ResearchWorkspaceService {
  constructor(
    private readonly dependencies: {
      evidence: EvidenceRepository;
      arena: Pick<ArenaRepository, "getSessionArtifacts">;
      reviews: Pick<ReviewRepository, "listReviews" | "listAgentRuns">;
      getSession: (sessionId: string) => Promise<WorkspacePhaseState | null>;
    }
  ) {}

  async getWorkspace(
    sessionId: string,
    options: { now?: Date } = {}
  ): Promise<ResearchWorkspace | null> {
    const session = await this.dependencies.getSession(sessionId);
    if (!session) {
      return null;
    }

    const [artifacts, evidence, sources, reviews, agentRuns] = await Promise.all([
      this.dependencies.arena.getSessionArtifacts(sessionId),
      this.dependencies.evidence.listEvidence(sessionId),
      this.dependencies.evidence.listSources(sessionId),
      this.dependencies.reviews.listReviews(sessionId),
      this.dependencies.reviews.listAgentRuns(sessionId)
    ]);

    // Agent-produced evidence and researcher-entered evidence live in the same
    // table, so the repository list is the single source of truth here.
    const claims = artifacts.claims;
    const challenges = artifacts.challenges;
    const verdicts = deriveClaimVerdicts(claims, evidence, {
      ...(options.now ? { now: options.now } : {}),
      challenges,
      reviews
    });
    const counts = summarizeVerification(evidence);

    // Gaps are derived from the same verdict projection the UI shows, so a
    // "what is missing" diagnosis can never contradict the stated conclusion.
    const verdictByClaimId = new Map(
      verdicts.map((verdict) => [verdict.claimId, verdict])
    );
    const gaps: EvidenceGap[] = claims.flatMap((claim) => {
      const verdict = verdictByClaimId.get(claim.id);
      if (!verdict) return [];
      return diagnoseEvidenceGaps({
        claim,
        verdict,
        evidence: evidence.filter((item) => item.claimIds.includes(claim.id)),
        sources,
        challenges: challenges.filter(
          (challenge) => challenge.targetClaimId === claim.id
        )
      });
    });

    // The latest ruling per claim, kept only when it explicitly asked for more
    // material: that is the open request a researcher has to close.
    const latestReviewByClaim = new Map<string, ClaimReview>();
    for (const review of reviews) {
      const current = latestReviewByClaim.get(review.claimId);
      if (!current || review.createdAt > current.createdAt) {
        latestReviewByClaim.set(review.claimId, review);
      }
    }
    const openReviewRequests = [...latestReviewByClaim.values()].filter(
      (review) => review.outcome === "needs_more_evidence"
    );

    return {
      session,
      claims,
      evidence,
      sources,
      conflicts: artifacts.conflicts,
      challenges,
      agentRuns,
      reviews,
      verdicts,
      gaps,
      openReviewRequests,
      summary: {
        claims: claims.length,
        evidence: evidence.length,
        sources: sources.length,
        challenges: challenges.length,
        unresolvedChallenges: challenges.filter(
          (challenge) => challenge.status !== "resolved"
        ).length,
        reviews: reviews.length,
        failedRuns: agentRuns.filter((run) => run.status === "failed").length,
        verified: counts.verified,
        unverified: counts.unverified,
        rejected: counts.rejected,
        openVerdicts: verdicts.filter((verdict) => verdict.needsWork).length,
        needsMoreEvidence: openReviewRequests.length,
        blockingGaps: gaps.filter((gap) => gap.severity === "blocking").length
      }
    };
  }
}
