import {
  type ArenaRepository,
  type EvidenceRepository,
  type ReviewRepository
} from "@nexus/db";
import {
  deriveClaimVerdicts,
  type AgentRun,
  type Challenge,
  type Claim,
  type ClaimReview,
  type ClaimVerdict,
  type Conflict,
  type Evidence,
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
        openVerdicts: verdicts.filter((verdict) => verdict.needsWork).length
      }
    };
  }
}
