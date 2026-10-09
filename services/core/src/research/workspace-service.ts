import {
  type EvidenceRepository,
  type ArenaRepository
} from "@nexus/db";
import {
  deriveClaimVerdicts,
  type Claim,
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
  /** One fact-check verdict per claim, computed from the evidence only. */
  verdicts: ClaimVerdict[];
  summary: {
    claims: number;
    evidence: number;
    sources: number;
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
 * currently verified, so they cannot drift from the evidence and cannot be
 * typed in by hand.
 */
export class ResearchWorkspaceService {
  constructor(
    private readonly dependencies: {
      evidence: EvidenceRepository;
      arena: Pick<ArenaRepository, "getSessionArtifacts">;
      getSession: (
        sessionId: string
      ) => Promise<WorkspacePhaseState | null>;
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

    const [artifacts, evidence, sources] = await Promise.all([
      this.dependencies.arena.getSessionArtifacts(sessionId),
      this.dependencies.evidence.listEvidence(sessionId),
      this.dependencies.evidence.listSources(sessionId)
    ]);

    // Agent-produced evidence and researcher-entered evidence live in the same
    // table, so the repository list is the single source of truth here.
    const claims = artifacts.claims;
    const verdicts = deriveClaimVerdicts(claims, evidence, {
      ...(options.now ? { now: options.now } : {})
    });
    const counts = summarizeVerification(evidence);

    return {
      session,
      claims,
      evidence,
      sources,
      conflicts: artifacts.conflicts,
      verdicts,
      summary: {
        claims: claims.length,
        evidence: evidence.length,
        sources: sources.length,
        verified: counts.verified,
        unverified: counts.unverified,
        rejected: counts.rejected,
        openVerdicts: verdicts.filter((verdict) => verdict.needsWork).length
      }
    };
  }
}
