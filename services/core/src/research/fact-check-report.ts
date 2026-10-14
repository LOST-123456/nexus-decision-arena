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
  type EvidenceGap,
  type EvidenceGapKind,
  type ResearchPlanItem,
  type ResearchPlanStatus,
  type ResearchQualityAssessment,
  type RevalidationReportWarnings,
  type Source,
  diagnoseEvidenceGaps,
  EvidenceGapKindSchema,
  detectConfirmedSourceLinks,
  independenceHeadline,
  isConflictAwaitingHumanDecision,
  matchRequiredEvidence,
  summarizeIndependence
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

/**
 * How the research plan answers one gap.
 *
 * `not_planned` is its own state, not an error: it says nobody has decided to
 * go after this gap yet. A plan status never changes the gap's severity —
 * planning is a decision about work, not material; until real evidence rows
 * exist the diagnosis keeps firing.
 */
export type GapPlanLink = {
  status: ResearchPlanStatus | "not_planned";
  /** The plan's own words: outcome summary, decision or failure reason. */
  note: string | null;
};

/** The plan fields the report reads. Deliberately narrow. */
export type FactCheckPlanItemRef = Pick<
  ResearchPlanItem,
  "gapId" | "status" | "decisionReason" | "failureReason" | "outcome"
>;

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
  /**
   * Rule-based diagnoses of what is still missing for this claim. Every entry
   * reads a persisted fact and names the rows it is about; none of it is a
   * guess and none of it claims a source was found. Each entry carries the
   * plan's answer to it, so a reader can tell which gaps have someone on them
   * and which nobody has picked up.
   */
  gaps: Array<EvidenceGap & { plan: GapPlanLink }>;
  /** Verdict projection of `gaps`: blocking gaps mean the conclusion is open. */
  blockingGapCount: number;
};

/**
 * The time window the material actually covers, so a reader can tell whether
 * the conclusion describes the present or an older period.
 */
export type MaterialsTimeRange = {
  /** Publication dates declared by the registered sources. */
  publishedAt: { earliest: string | null; latest: string | null };
  /** Declared evidence validity windows. */
  validity: {
    earliestFrom: string | null;
    latestTo: string | null;
  };
  /** When the excerpts were retrieved. */
  retrievedAt: { earliest: string | null; latest: string | null };
  /** True when no material declares any date at all. */
  empty: boolean;
};

export type FactCheckReport = {
  sessionId: string;
  researchQuestion: string | null;
  generatedAt: string;
  reportVersion: number;
  /**
   * The time range the examined material covers. Reported next to
   * `generatedAt` so a stale conclusion is never read as a current one.
   */
  materialsTimeRange: MaterialsTimeRange;
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
    /**
     * How many independent information sources the pages amount to. Five pages
     * reprinting one wire story are one source, not five pieces of
     * corroboration, so this is reported next to `sources` rather than
     * replacing it.
     */
    independentSources: number;
    challenges: number;
    reviews: number;
    agentRuns: number;
  };
  /**
   * The independence reading, informational only.
   *
   * It is derived from the source rows (normalized url and content version) and
   * never from text similarity, so nothing here is a suspicion presented as a
   * fact. Nothing in this block feeds a verdict: `deriveClaimVerdicts()` cannot
   * see it, and the verification gate is unchanged.
   */
  independence: {
    pages: number;
    independentSources: number;
    /** The sentence the workspace shows too, so the two can never disagree. */
    headline: string;
    /** How many sources sit in a group of more than one page. */
    groupedSources: number;
    note: string;
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
    /**
     * Aggregate of the claim-level diagnoses: how many gaps there are, how
     * serious, and of which kind. Derived from `findings[].gaps`, never typed
     * in by hand.
     */
    evidenceGaps: {
      total: number;
      bySeverity: Record<"blocking" | "important" | "advisory", number>;
      byKind: Record<EvidenceGapKind, number>;
      /** Gaps someone has added to the research plan. */
      planned: number;
      /** Gaps nobody has decided to pursue yet. */
      notPlanned: number;
    };
  };
  /**
   * What source monitoring has to say, reported alongside the conclusion and
   * never folded into it.
   *
   * Absent when monitoring is not configured or nothing is open; when present
   * it is a reason to re-read the report, not a reason to change a verdict —
   * the verdict pipeline cannot see this block.
   */
  revalidation?: RevalidationReportWarnings | undefined;
  /**
   * The research quality assessment frozen with this report.
   *
   * Read-only and never folded into a verdict: it describes how well the
   * material supports the conclusions, not whether the conclusions are true,
   * and `deriveClaimVerdicts()` cannot see it. Absent when the quality
   * assessment is not configured or the caller did not pass one.
   */
  researchQuality?: ResearchQualityAssessment | undefined;
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
 *
 * The matching rule itself lives in `@nexus/shared` so the gap diagnosis and
 * the report can never disagree about what counts as registered.
 */
function requiredEvidenceSplit(
  required: readonly string[],
  registered: readonly Evidence[]
): { unverifiedReferences: string[] } {
  return {
    unverifiedReferences: matchRequiredEvidence(required, registered)
      .unverifiedReferences
  };
}

function minMax(values: Array<string | undefined>): {
  min: string | null;
  max: string | null;
} {
  const present = values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort();
  return {
    min: present.length > 0 ? present[0]! : null,
    max: present.length > 0 ? present[present.length - 1]! : null
  };
}

/**
 * The window the examined material actually covers. Derived from persisted
 * dates only; a date that was never recorded stays null rather than being
 * guessed from the report's own generation time.
 */
function materialsTimeRange(
  evidence: readonly Evidence[],
  sources: readonly Source[]
): MaterialsTimeRange {
  const published = minMax(sources.map((source) => source.publishedAt));
  const retrieved = minMax(evidence.map((item) => item.retrievedAt));
  const from = minMax(evidence.map((item) => item.validityPeriod?.from));
  const to = minMax(evidence.map((item) => item.validityPeriod?.to));
  return {
    publishedAt: { earliest: published.min, latest: published.max },
    validity: { earliestFrom: from.min, latestTo: to.max },
    retrievedAt: { earliest: retrieved.min, latest: retrieved.max },
    empty:
      published.min === null &&
      retrieved.min === null &&
      from.min === null &&
      to.max === null
  };
}

/**
 * The fingerprint covers the material and nothing else.
 *
 * The ledger position is deliberately left out. It is carried separately in
 * `provenance.lastEventSequence`, because folding it in made the fingerprint
 * move every time anything at all was recorded — including the audit event a
 * version save writes. That turned "this version matches the current
 * material" into a sentence that was false the moment it was printed.
 */
function fingerprint(parts: {
  claims: readonly Claim[];
  evidence: readonly Evidence[];
  sources: readonly Source[];
  challenges: readonly Challenge[];
  reviews: readonly ClaimReview[];
  runs: readonly AgentRun[];
}): string {
  const payload = [
    parts.claims.map((item) => `${item.id}:${item.status}:${item.updatedAt}`).sort(),
    parts.evidence
      .map((item) => `${item.id}:${item.verificationStatus}:${item.reliability}`)
      .sort(),
    parts.sources.map((item) => `${item.id}:${item.updatedAt}`).sort(),
    parts.challenges.map((item) => `${item.id}:${item.status}`).sort(),
    parts.reviews.map((item) => `${item.id}:${item.outcome}`).sort(),
    parts.runs.map((item) => `${item.id}:${item.status}`).sort()
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
  /** Current research plan rows, when the plan is configured. */
  planItems?: readonly FactCheckPlanItemRef[];
  /**
   * Source-monitoring warnings, when monitoring is configured. Passed in
   * rather than derived here: the check trail is the monitor service's to
   * read, and the report stays a pure function of its inputs.
   */
  revalidation?: RevalidationReportWarnings | undefined;
  /**
   * The read-only research quality assessment to freeze with this report.
   *
   * Passed in rather than derived here for the same reason as `revalidation`:
   * the assessment is a projection over rows this function never sees (plan
   * items, monitoring tasks, human source relations), and the report stays a
   * pure function of its inputs. A saved version records the assessment that
   * was current when it was saved; a historical version renders the one it
   * froze, never a fresh one.
   */
  researchQuality?: ResearchQualityAssessment | undefined;
};

/** The plan's answer to one gap, from the plan row's own fields. */
function planLinkFor(
  gap: EvidenceGap,
  planByGapId: Map<string, FactCheckPlanItemRef>
): GapPlanLink {
  const item = planByGapId.get(gap.id);
  if (!item) {
    return { status: "not_planned", note: null };
  }
  const note =
    item.outcome?.summary ??
    item.decisionReason ??
    item.failureReason ??
    (item.status === "queued" ? "已加入研究计划，尚未执行任何检索。" : null);
  return { status: item.status, note };
}

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
  const planByGapId = new Map(
    (input.planItems ?? []).map((item) => [item.gapId, item])
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

      const claimChallenges = input.challenges.filter(
        (challenge) => challenge.targetClaimId === claim.id
      );
      const challenges = claimChallenges.map((challenge) =>
        toChallengeFinding(challenge, claimEvidence)
      );

      const reviews = input.reviews.filter((item) => item.claimId === claim.id);

      const resolvedVerdict: ClaimVerdict =
        verdict ?? {
          claimId: claim.id,
          status: "unsupported",
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
          basis: {
            supportingEvidenceIds: [],
            opposingEvidenceIds: [],
            contextEvidenceIds: []
          },
          excluded: [],
          ruleHits: ["no_evidence"],
          confidenceBasis: ["没有为该主张推导出核查结论。"],
          openQuestions: [],
          limits: [],
          crossReview: {
            challenges: 0,
            unresolved: 0,
            severeUnresolved: 0,
            unresolvedChallengeIds: [],
            severeUnresolvedChallengeIds: [],
            lastReviewedAt: null
          },
          review: null,
          effectiveStatus: "unsupported"
        };

      const gaps: Array<EvidenceGap & { plan: GapPlanLink }> = diagnoseEvidenceGaps({
        claim,
        verdict: resolvedVerdict,
        evidence: claimEvidence,
        sources: input.sources,
        challenges: claimChallenges
      }).map((gap) => ({ ...gap, plan: planLinkFor(gap, planByGapId) }));

      return {
        claimId: claim.id,
        statement: claim.statement,
        type: claim.type,
        stance: claim.stance,
        importance: claim.importance,
        claimStatus: claim.status,
        verdict: resolvedVerdict,
        review: reviews.length > 0 ? reviews[reviews.length - 1]! : null,
        reviewHistory: [...reviews].reverse(),
        gaps,
        blockingGapCount: gaps.filter((gap) => gap.severity === "blocking").length,
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
  const allGaps = findings.flatMap((finding) => finding.gaps);
  const gapByKind = Object.fromEntries(
    EvidenceGapKindSchema.options.map((kind) => [kind, 0])
  ) as Record<EvidenceGapKind, number>;
  for (const gap of allGaps) {
    gapByKind[gap.kind] += 1;
  }
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
  const blockingGaps = allGaps.filter((gap) => gap.severity === "blocking");
  if (blockingGaps.length > 0) {
    limits.add(
      `有 ${blockingGaps.length} 项阻断性证据缺口：在补齐之前，相关主张不能给出确定性结论。`
    );
  }
  if (allGaps.length > 0 && allGaps.length === blockingGaps.length) {
    limits.add("本报告中的核查结论均受证据缺口限制，不宜作为最终结论引用。");
  }
  const plannedNotExecuted = allGaps.filter(
    (gap) => gap.plan.status === "queued"
  ).length;
  if (plannedNotExecuted > 0) {
    limits.add(
      `有 ${plannedNotExecuted} 项缺口已加入研究计划但尚未执行任何检索；相关补证工作仍在进行中。`
    );
  }
  // An open re-check is a reason to re-read the report, never a reason to
  // change a verdict — and the verdict pipeline cannot see this block.
  const revalidation = input.revalidation;
  if (
    revalidation &&
    (revalidation.openTaskCount > 0 || revalidation.inReviewTaskCount > 0)
  ) {
    limits.add(
      `有 ${revalidation.openTaskCount} 项待处理、${revalidation.inReviewTaskCount} 项复核中的来源变化：相关结论所依据的材料版本可能已更新，结论本身未因此改变。`
    );
  }
  // Quality findings are reported, never acted on: a critical finding is a
  // reason for a person to go and look, not a reason to move a verdict.
  const criticalQualityFindings = (input.researchQuality?.findings ?? []).filter(
    (finding) => finding.severity === "critical"
  );
  if (criticalQualityFindings.length > 0) {
    limits.add(
      `质量评估发现 ${criticalQualityFindings.length} 项关键问题（详见「研究质量评估」）：这些问题说明材料仍有缺口，不改变本报告的任何结论。`
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

  /*
   * Independence, derived from the source rows only.
   *
   * Merging happens on facts the server can prove — the same normalized url, or
   * an identical content version — so this number never depends on a judgement
   * call. Near-duplicate text is deliberately NOT merged here: it is a suspicion
   * that only a person may confirm, and it is tracked in the workspace. The
   * verdict pipeline does not read any of this.
   */
  const independence = summarizeIndependence({
    sessionId: input.session.id,
    sources: input.sources,
    links: detectConfirmedSourceLinks(input.sources)
  });
  const groupedSources = independence.clusters
    .filter((cluster) => cluster.pageCount > 1)
    .reduce((total, cluster) => total + cluster.pageCount, 0);
  const independenceNote =
    groupedSources > 0
      ? `${groupedSources} 个来源经规范化地址或内容版本确认属于同一份独立信息源，未重复计票；文本近似的疑似重复需在工作台人工确认后才会计入合并。`
      : "未发现经确认的重复登记来源；文本近似的疑似重复仍可能存在于工作台，需人工确认。";

  if (groupedSources > 0) {
    limits.add(independenceNote);
  }

  return {
    sessionId: input.session.id,
    researchQuestion: input.session.researchQuestion,
    generatedAt: input.generatedAt,
    reportVersion: 1,
    materialsTimeRange: materialsTimeRange(input.evidence, input.sources),
    materialsFingerprint: fingerprint({
      claims: input.claims,
      evidence: input.evidence,
      sources: input.sources,
      challenges: input.challenges,
      reviews: input.reviews,
      runs: input.agentRuns
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
      independentSources: independence.confirmedIndependentSources,
      challenges: input.challenges.length,
      reviews: input.reviews.length,
      agentRuns: input.agentRuns.length
    },
    independence: {
      pages: independence.pages,
      independentSources: independence.confirmedIndependentSources,
      headline: independenceHeadline(independence),
      groupedSources,
      note: independenceNote
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
      unlinkedCitations,
      /** Aggregate of every claim-level diagnosis, so the report can be read top-down. */
      evidenceGaps: {
        total: allGaps.length,
        bySeverity: {
          blocking: blockingGaps.length,
          important: allGaps.filter((gap) => gap.severity === "important").length,
          advisory: allGaps.filter((gap) => gap.severity === "advisory").length
        },
        byKind: gapByKind,
        planned: allGaps.filter((gap) => gap.plan.status !== "not_planned")
          .length,
        notPlanned: allGaps.filter((gap) => gap.plan.status === "not_planned")
          .length
      }
    },
    // Reported only when monitoring is wired in and has something to say.
    ...(revalidation ? { revalidation } : {}),
    // The frozen quality assessment, when the caller supplied one. Rendered
    // by the export paths exactly as passed, so a historical version keeps
    // the assessment it was saved with.
    ...(input.researchQuality ? { researchQuality: input.researchQuality } : {}),
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
  const { unverifiedReferences } = requiredEvidenceSplit(
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
