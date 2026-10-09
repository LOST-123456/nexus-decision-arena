import { createHash } from "node:crypto";
import {
  type AgentRun,
  type Challenge,
  type Claim,
  type ClaimReview,
  type ClaimVerdict,
  type ClaimVerdictStatus,
  type Conflict,
  type Evidence,
  type EvidenceDirection,
  type Source,
  isConflictAwaitingHumanDecision
} from "@nexus/shared";

export type ReportSessionInput = {
  id: string;
  researchQuestion: string | null;
  phase: string;
  operationalStatus: string;
  currentConclusion: string | null;
};

export type EvidenceCitation = {
  evidenceId: string;
  title: string;
  excerpt: string;
  locator: string | null;
  direction: EvidenceDirection;
  verificationStatus: Evidence["verificationStatus"];
  reliability: number;
  verifiedBy: string | null;
  verificationNote: string | null;
  /** The registered provenance record, when one exists. */
  source: {
    id: string;
    title: string;
    kind: Source["kind"];
    publisher: string | null;
    url: string | null;
    publishedAt: string | null;
  } | null;
  /** A bare url is weaker provenance than a source record; it is said so. */
  sourceRef: string | null;
  citationStatus: "linked" | "url_only" | "unlinked";
};

export type ChallengeFinding = {
  challengeId: string;
  type: Challenge["type"];
  question: string;
  severity: number;
  status: Challenge["status"];
  resolutionStrategy: Challenge["resolutionStrategy"];
  /** Evidence the challenger asked for, as free text. */
  requiredEvidence: string[];
  /**
   * Entries of `requiredEvidence` that match no registered evidence for this
   * claim. They are the challenger's own words and must never be presented as
   * if a source had been recorded.
   */
  unverifiedReferences: string[];
  /** Evidence actually registered for the claim at report time. */
  registeredEvidenceIds: string[];
  responseClaimId: string | null;
  challengerRoleId: string;
  challengerRunId: string;
  unresolved: boolean;
  createdAt: string;
};

export type FactCheckFinding = {
  claimId: string;
  statement: string;
  type: Claim["type"];
  stance: Claim["stance"];
  importance: number;
  claimStatus: Claim["status"];
  verdict: ClaimVerdict;
  review: ClaimReview | null;
  reviewHistory: ClaimReview[];
  supporting: EvidenceCitation[];
  opposing: EvidenceCitation[];
  context: EvidenceCitation[];
  /** Material that exists but was excluded from the verdict, and why. */
  excluded: EvidenceCitation[];
  challenges: ChallengeFinding[];
  runs: AgentRun[];
};

export type FactCheckReport = {
  sessionId: string;
  researchQuestion: string | null;
  generatedAt: string;
  reportVersion: number;
  /** Deterministic fingerprint of the material this version was built from. */
  materialsFingerprint: string;
  workflow: {
    phase: string;
    operationalStatus: string;
    currentConclusion: string | null;
  };
  /** What was actually examined, so the report's reach is auditable. */
  scope: {
    claims: number;
    evidence: number;
    sources: number;
    challenges: number;
    reviews: number;
    agentRuns: number;
  };
  summary: {
    byStatus: Record<ClaimVerdictStatus, number>;
    openVerdicts: number;
    verified: number;
    unverified: number;
    rejected: number;
    inconclusive: number;
  };
  findings: FactCheckFinding[];
  crossExamination: {
    runs: AgentRun[];
    failedRuns: AgentRun[];
    challenges: ChallengeFinding[];
  };
  gaps: {
    insufficientEvidence: Array<{ claimId: string; statement: string }>;
    unresolvedConflicts: Array<{ conflictId: string; summary: string; severity: number }>;
    assumptions: Array<{ claimId: string; statement: string }>;
    unlinkedCitations: Array<{ evidenceId: string; title: string }>;
  };
  limits: string[];
  /** Links the report back to the exact rows it was generated from. */
  provenance: {
    evidenceIds: string[];
    sourceIds: string[];
    challengeIds: string[];
    agentRunIds: string[];
    reviewIds: string[];
    claimIds: string[];
    lastEventSequence: number;
  };
};

const VERDICT_STATUSES: ClaimVerdictStatus[] = [
  "unsupported",
  "insufficient_evidence",
  "context_only",
  "supported",
  "refuted",
  "mixed_evidence",
  "inconclusive"
];

function toCitation(
  item: Evidence,
  sourcesById: Map<string, Source>
): EvidenceCitation {
  const source = item.sourceId ? sourcesById.get(item.sourceId) : undefined;
  return {
    evidenceId: item.id,
    title: item.title,
    excerpt: item.content,
    locator: item.locator ?? null,
    direction: item.direction,
    verificationStatus: item.verificationStatus,
    reliability: item.reliability,
    verifiedBy: item.verifiedBy ?? null,
    verificationNote: item.verificationNote ?? null,
    source: source
      ? {
          id: source.id,
          title: source.title,
          kind: source.kind,
          publisher: source.publisher ?? null,
          url: source.url ?? null,
          publishedAt: source.publishedAt ?? null
        }
      : null,
    sourceRef: item.sourceRef ?? null,
    citationStatus: source
      ? "linked"
      : item.sourceRef
        ? "url_only"
        : "unlinked"
  };
}

/**
 * A challenge's `requiredEvidence` is free text written by an agent. It is
 * only reported as satisfied when a registered evidence record actually
 * matches it; otherwise it is listed as an unverified reference.
 */
function matchRequiredEvidence(
  required: readonly string[],
  registered: readonly Evidence[]
): { unverifiedReferences: string[] } {
  const haystack = registered
    .map((item) => `${item.title} ${item.content} ${item.description}`.toLowerCase())
    .join("\n");
  const unverifiedReferences = required.filter((entry) => {
    const needle = entry.trim().toLowerCase();
    return needle.length > 0 && !haystack.includes(needle);
  });
  return { unverifiedReferences };
}

function fingerprint(parts: {
  claims: readonly Claim[];
  evidence: readonly Evidence[];
  sources: readonly Source[];
  challenges: readonly Challenge[];
  reviews: readonly ClaimReview[];
  runs: readonly AgentRun[];
  lastEventSequence: number;
}): string {
  const payload = [
    parts.claims.map((item) => `${item.id}:${item.status}:${item.updatedAt}`).sort(),
    parts.evidence
      .map((item) => `${item.id}:${item.verificationStatus}:${item.reliability}`)
      .sort(),
    parts.sources.map((item) => `${item.id}:${item.updatedAt}`).sort(),
    parts.challenges.map((item) => `${item.id}:${item.status}`).sort(),
    parts.reviews.map((item) => `${item.id}:${item.outcome}`).sort(),
    parts.runs.map((item) => `${item.id}:${item.status}`).sort(),
    [`seq:${parts.lastEventSequence}`]
  ]
    .map((group) => group.join(","))
    .join("|");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export type BuildFactCheckReportInput = {
  session: ReportSessionInput;
  claims: readonly Claim[];
  evidence: readonly Evidence[];
  sources: readonly Source[];
  challenges: readonly Challenge[];
  conflicts: readonly Conflict[];
  verdicts: readonly ClaimVerdict[];
  reviews: readonly ClaimReview[];
  agentRuns: readonly AgentRun[];
  lastEventSequence: number;
  generatedAt: string;
};

/**
 * Builds the fact-check report from persisted research material only.
 *
 * Pure and deterministic: the same material always produces the same report,
 * and `materialsFingerprint` changes whenever any input changes, so a report
 * can always be traced back to the exact evidence, sources, challenges and
 * rulings it was generated from.
 */
export function buildFactCheckReport(
  input: BuildFactCheckReportInput
): FactCheckReport {
  const sourcesById = new Map(input.sources.map((item) => [item.id, item]));
  const verdictByClaimId = new Map(
    input.verdicts.map((verdict) => [verdict.claimId, verdict])
  );

  const byStatus = Object.fromEntries(
    VERDICT_STATUSES.map((status) => [status, 0])
  ) as Record<ClaimVerdictStatus, number>;

  const findings: FactCheckFinding[] = [...input.claims]
    .sort(
      (left, right) =>
        right.importance - left.importance || left.id.localeCompare(right.id)
    )
    .map((claim) => {
      const verdict = verdictByClaimId.get(claim.id);
      if (verdict) {
        byStatus[verdict.status] += 1;
      }

      const claimEvidence = input.evidence.filter((item) =>
        item.claimIds.includes(claim.id)
      );
      const live = (item: Evidence) => !isExcluded(item);

      const challenges = input.challenges
        .filter((challenge) => challenge.targetClaimId === claim.id)
        .map((challenge) =>
          toChallengeFinding(challenge, claimEvidence)
        );

      const reviews = input.reviews.filter((item) => item.claimId === claim.id);

      return {
        claimId: claim.id,
        statement: claim.statement,
        type: claim.type,
        stance: claim.stance,
        importance: claim.importance,
        claimStatus: claim.status,
        verdict:
          verdict ?? {
            claimId: claim.id,
            status: "unsupported" as const,
            confidence: 0,
            rationale: "No verdict was derived for this claim.",
            counts: {
              total: 0,
              verified: 0,
              unverified: 0,
              rejected: 0,
              expired: 0,
              notYetEffective: 0,
              verifiedSupporting: 0,
              verifiedOpposing: 0,
              verifiedContext: 0
            },
            needsWork: true,
            openQuestions: [],
            limits: [],
            crossReview: {
              challenges: 0,
              unresolved: 0,
              severeUnresolved: 0,
              lastReviewedAt: null
            },
            review: null,
            effectiveStatus: "unsupported" as const
          },
        review: reviews.length > 0 ? reviews[reviews.length - 1]! : null,
        reviewHistory: [...reviews].reverse(),
        supporting: claimEvidence
          .filter(
            (item) =>
              live(item) &&
              item.verificationStatus === "verified" &&
              item.direction === "supports"
          )
          .map((item) => toCitation(item, sourcesById)),
        opposing: claimEvidence
          .filter(
            (item) =>
              live(item) &&
              item.verificationStatus === "verified" &&
              item.direction === "opposes"
          )
          .map((item) => toCitation(item, sourcesById)),
        context: claimEvidence
          .filter(
            (item) =>
              live(item) &&
              item.verificationStatus === "verified" &&
              item.direction === "context"
          )
          .map((item) => toCitation(item, sourcesById)),
        excluded: claimEvidence
          .filter(
            (item) =>
              item.verificationStatus !== "verified" || isExcluded(item)
          )
          .map((item) => toCitation(item, sourcesById)),
        challenges,
        runs: input.agentRuns.filter(
          (run) =>
            run.purpose === "cross_review" && run.targetClaimId === claim.id
        )
      };
    });

  const allChallengeFindings = findings.flatMap((finding) => finding.challenges);
  const unlinkedCitations = findings
    .flatMap((finding) => [...finding.excluded, ...finding.supporting])
    .filter((citation) => citation.citationStatus === "unlinked")
    .map((citation) => ({
      evidenceId: citation.evidenceId,
      title: citation.title
    }));

  const limits = new Set<string>();
  for (const finding of findings) {
    for (const line of finding.verdict.limits) {
      limits.add(line);
    }
  }
  if (unlinkedCitations.length > 0) {
    limits.add(
      `${unlinkedCitations.length} 条材料没有来源记录，只能标注为无法追溯。`
    );
  }

  const counts = input.evidence.reduce(
    (accumulator, item) => {
      if (item.verificationStatus === "verified") accumulator.verified += 1;
      else if (item.verificationStatus === "rejected") accumulator.rejected += 1;
      else accumulator.unverified += 1;
      return accumulator;
    },
    { verified: 0, unverified: 0, rejected: 0 }
  );

  return {
    sessionId: input.session.id,
    researchQuestion: input.session.researchQuestion,
    generatedAt: input.generatedAt,
    reportVersion: 1,
    materialsFingerprint: fingerprint({
      claims: input.claims,
      evidence: input.evidence,
      sources: input.sources,
      challenges: input.challenges,
      reviews: input.reviews,
      runs: input.agentRuns,
      lastEventSequence: input.lastEventSequence
    }),
    workflow: {
      phase: input.session.phase,
      operationalStatus: input.session.operationalStatus,
      currentConclusion: input.session.currentConclusion
    },
    scope: {
      claims: input.claims.length,
      evidence: input.evidence.length,
      sources: input.sources.length,
      challenges: input.challenges.length,
      reviews: input.reviews.length,
      agentRuns: input.agentRuns.length
    },
    summary: {
      byStatus,
      openVerdicts: input.verdicts.filter((verdict) => verdict.needsWork).length,
      inconclusive: byStatus.inconclusive,
      ...counts
    },
    findings,
    crossExamination: {
      runs: input.agentRuns.filter((run) => run.purpose === "cross_review"),
      failedRuns: input.agentRuns.filter(
        (run) => run.purpose === "cross_review" && run.status === "failed"
      ),
      challenges: allChallengeFindings
    },
    gaps: {
      insufficientEvidence: findings
        .filter(
          (finding) =>
            finding.verdict.status === "insufficient_evidence" ||
            finding.verdict.status === "unsupported"
        )
        .map((finding) => ({
          claimId: finding.claimId,
          statement: finding.statement
        })),
      unresolvedConflicts: input.conflicts
        .filter((conflict) => isConflictAwaitingHumanDecision(conflict))
        .map((conflict) => ({
          conflictId: conflict.id,
          summary: conflict.summary,
          severity: conflict.severity
        })),
      assumptions: findings
        .filter((finding) => finding.type === "assumption")
        .map((finding) => ({
          claimId: finding.claimId,
          statement: finding.statement
        })),
      unlinkedCitations
    },
    limits: [...limits],
    provenance: {
      evidenceIds: input.evidence.map((item) => item.id).sort(),
      sourceIds: input.sources.map((item) => item.id).sort(),
      challengeIds: input.challenges.map((item) => item.id).sort(),
      agentRunIds: input.agentRuns.map((item) => item.id).sort(),
      reviewIds: input.reviews.map((item) => item.id).sort(),
      claimIds: input.claims.map((item) => item.id).sort(),
      lastEventSequence: input.lastEventSequence
    }
  };
}

function isExcluded(item: Evidence): boolean {
  const now = Date.now();
  const to = item.validityPeriod?.to;
  if (to) {
    const end = new Date(to).getTime();
    if (Number.isFinite(end) && end < now) return true;
  }
  const from = item.validityPeriod?.from;
  if (from) {
    const start = new Date(from).getTime();
    if (Number.isFinite(start) && start > now) return true;
  }
  return false;
}

function toChallengeFinding(
  challenge: Challenge,
  claimEvidence: readonly Evidence[]
): ChallengeFinding {
  const { unverifiedReferences } = matchRequiredEvidence(
    challenge.requiredEvidence,
    claimEvidence
  );
  return {
    challengeId: challenge.id,
    type: challenge.type,
    question: challenge.question,
    severity: challenge.severity,
    status: challenge.status,
    resolutionStrategy: challenge.resolutionStrategy,
    requiredEvidence: [...challenge.requiredEvidence],
    unverifiedReferences,
    registeredEvidenceIds: claimEvidence.map((item) => item.id),
    responseClaimId: challenge.responseClaimId ?? null,
    challengerRoleId: challenge.challengerRoleId,
    challengerRunId: challenge.challengerRunId,
    unresolved: challenge.status !== "resolved",
    createdAt: challenge.createdAt
  };
}
