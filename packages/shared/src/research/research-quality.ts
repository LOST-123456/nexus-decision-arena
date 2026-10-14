import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";
import type { Claim } from "../domain/claim";
import { ClaimVerdictStatusSchema } from "../verification/claim-verdict";
import type { ClaimVerdictStatus } from "../verification/claim-verdict";
import type { Evidence } from "../domain/evidence";
import type { Source } from "../domain/source";
import type { Conflict } from "../domain/conflict";
import type { Challenge } from "../domain/challenge";
import type { EvidenceGap } from "../verification/evidence-gaps";
import type { AgentRun } from "../domain/agent-run";
import type { IndependenceSummary } from "../verification/source-independence";
import type { RevalidationReportWarnings, RevalidationTask } from "../research/source-monitoring";
import type { ResearchPlanItem } from "../verification/research-plan";

/**
 * Research quality assessment — a read-only projection over material that
 * already exists.
 *
 * The one rule this module is built around:
 *
 *   **A quality score describes the research process, never the truth of the
 *   conclusion.** 85/100 does not mean "85% likely to be true". It means: of
 *   the things this build can actually check — coverage, verification,
 *   independence, conflict handling, completeness, currency — this is how the
 *   session currently stands, by rules that are written down and versioned.
 *
 * Three separations the schema exists to enforce:
 *
 *   1. This projection **writes nothing**. It cannot change `claim.status`, a
 *      `ClaimVerdict`, `evidence.verificationStatus`, a `ClaimReview` or a
 *      saved report snapshot. It reads them.
 *   2. A dimension that cannot be computed gets `score: null` and status
 *      `insufficient_data` — never a fabricated 0, and never a flattering 100.
 *      Missing weight is excluded from the overall score, not counted as zero.
 *   3. Nothing here is a model's opinion. Every score, finding and
 *      recommendation is a deterministic rule over persisted rows, carrying the
 *      `ruleVersion` it was computed under.
 */

/** Bumped whenever a scoring rule, weight or threshold changes. */
export const RESEARCH_QUALITY_RULE_VERSION = "research-quality-v1";

/** The version of this document shape, carried next to every assessment. */
export const RESEARCH_QUALITY_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ *
 * Vocabularies
 * ------------------------------------------------------------------ */

/** The six dimensions. Fixed set: the weights below must sum to 100. */
export const QualityDimensionIdSchema = z.enum([
  /** Are claims covered by material at all, and by verified support? */
  "evidence_coverage",
  /** Of the material that exists, how much was actually checked? */
  "verification_quality",
  /** Do the sources amount to independent information, or one story retold? */
  "source_independence",
  /** Are recorded disagreements being answered, or ignored? */
  "conflict_resolution",
  /** Are diagnosed gaps owned and worked, or just listed? */
  "research_completeness",
  /** Has the cited material moved since it was confirmed? */
  "source_freshness"
]);

export type QualityDimensionId = z.infer<typeof QualityDimensionIdSchema>;

/**
 * What a dimension (or the overall reading) currently says.
 *
 * `insufficient_data` is the honest answer to "we cannot tell": it is never
 * converted into a number, and it never silently becomes a good score.
 */
export const QualityStatusSchema = z.enum([
  "strong",
  "adequate",
  "weak",
  "at_risk",
  "insufficient_data"
]);

export type QualityStatus = z.infer<typeof QualityStatusSchema>;

/**
 * Weights of the six dimensions, in percent. The sum is asserted in tests:
 * if a weight changes, the overall formula changes with it, visibly.
 */
export const QUALITY_DIMENSION_WEIGHTS: Readonly<
  Record<QualityDimensionId, number>
> = {
  evidence_coverage: 25,
  verification_quality: 20,
  source_independence: 20,
  conflict_resolution: 15,
  research_completeness: 10,
  source_freshness: 10
};

/** Sum of all dimension weights. Verified to be 100 by the unit tests. */
export const QUALITY_TOTAL_WEIGHT: number = Object.values(
  QUALITY_DIMENSION_WEIGHTS
).reduce((total, weight) => total + weight, 0);

/**
 * The overall score is only reported when at least this share of the total
 * weight is computable. Below it, the six dimensions are shown and the overall
 * score stays null — a number built on a minority of the assessment would look
 * far more certain than it is.
 */
export const QUALITY_OVERALL_MIN_COVERAGE = 0.5;

/** Score bands for `strong` / `adequate` / `weak` / `at_risk`. */
export const QUALITY_STATUS_THRESHOLDS = {
  strong: 75,
  adequate: 50,
  weak: 25
} as const;

export function qualityStatusForScore(score: number): QualityStatus {
  if (score >= QUALITY_STATUS_THRESHOLDS.strong) return "strong";
  if (score >= QUALITY_STATUS_THRESHOLDS.adequate) return "adequate";
  if (score >= QUALITY_STATUS_THRESHOLDS.weak) return "weak";
  return "at_risk";
}

export const QualitySeveritySchema = z.enum(["info", "warning", "critical"]);

export type QualitySeverity = z.infer<typeof QualitySeveritySchema>;

/**
 * What a finding is about. The vocabulary from the brief, plus three that the
 * same rules needed to name what they actually saw:
 * `duplicate_source` (a confirmed same-origin pair), `missing_source_record`
 * (material nobody can trace) and `publisher_concentration` (many pages from
 * one publisher — a signal to check, never a verdict).
 */
export const QualityFindingCategorySchema = z.enum([
  "missing_evidence",
  "unverified_evidence",
  "single_source_dependency",
  "unresolved_conflict",
  "unanswered_challenge",
  "broken_citation",
  "stale_source",
  "open_research_gap",
  "insufficient_independence",
  "duplicate_source",
  "missing_source_record",
  "publisher_concentration"
]);

export type QualityFindingCategory = z.infer<
  typeof QualityFindingCategorySchema
>;

/** Which kind of record a finding is attached to. */
export const QualityFindingScopeSchema = z.enum([
  "session",
  "claim",
  "evidence",
  "source"
]);

export type QualityFindingScope = z.infer<typeof QualityFindingScopeSchema>;

/**
 * What a researcher can do about a finding. Every value maps to a surface that
 * already exists in this build; nothing here writes to the database by itself,
 * and creating a research task goes through the existing Research Plan API.
 */
export const QualityRecommendationActionSchema = z.enum([
  "open_claim_detail",
  "open_evidence_detail",
  "open_source_reader",
  "open_source_relations",
  "open_research_plan",
  "open_human_review",
  "record_source",
  "verify_evidence",
  "add_supporting_evidence",
  "add_opposing_evidence",
  "run_cross_review"
]);

export type QualityRecommendationAction = z.infer<
  typeof QualityRecommendationActionSchema
>;

/* ------------------------------------------------------------------ *
 * The assessment
 * ------------------------------------------------------------------ */

/** One metric value inside a dimension's `inputMetrics`. */
export const QualityMetricValueSchema = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.null()
]);

export type QualityMetricValue = z.infer<typeof QualityMetricValueSchema>;

export const QualityDimensionSchema = z.object({
  id: QualityDimensionIdSchema,
  /** 0..100, or null when the dimension could not be computed. */
  score: z.number().min(0).max(100).nullable(),
  /** This dimension's share of the overall weight, in percent. */
  weight: z.number().int().positive(),
  status: QualityStatusSchema,
  /** How the score was (or was not) produced, in one paragraph. */
  explanation: z.string().min(1),
  /** The raw counts the rule read, so the number can be re-derived by hand. */
  inputMetrics: z.record(QualityMetricValueSchema),
  /** What this dimension cannot tell you. Never omitted when there is a limit. */
  limitations: z.array(z.string()).default([]),
  /** The rule version this dimension was computed under. */
  ruleVersion: z.string().min(1)
});

export type QualityDimension = z.infer<typeof QualityDimensionSchema>;

export const QualityOverallSchema = z.object({
  /** Null when the session is empty or too little of the weight is computable. */
  score: z.number().min(0).max(100).nullable(),
  status: QualityStatusSchema,
  /** The formula, the weights and what was excluded — stated, not implied. */
  explanation: z.string().min(1),
  /** How many of the six dimensions produced a score. */
  assessedDimensions: z.number().int().min(0).max(6),
  /**
   * Share of the total weight that was actually computable, 0..1. An overall
   * score below 1.0 means some dimensions were excluded, not scored zero.
   */
  coverage: z.number().min(0).max(1),
  ruleVersion: z.string().min(1)
});

export type QualityOverall = z.infer<typeof QualityOverallSchema>;

export const QualityFindingSchema = z.object({
  /** Deterministic: the same state always yields the same id. */
  id: z.string().min(1),
  scope: QualityFindingScopeSchema,
  /** The row this finding is about. Always a real id of this session. */
  entityId: IdSchema,
  category: QualityFindingCategorySchema,
  severity: QualitySeveritySchema,
  /** The persisted facts that produced this finding. */
  reason: z.string().min(1),
  /** The rule that fired, so a reader can check it. */
  ruleId: z.string().min(1),
  /** Material this finding is about, when it is about material. */
  evidenceReferences: z.array(IdSchema).default([]),
  /** The claim a reader should look at, for evidence- and source-scope findings. */
  claimId: IdSchema.nullable().default(null),
  recommendation: QualityRecommendationActionSchema
});

export type QualityFinding = z.infer<typeof QualityFindingSchema>;

/**
 * Claim-level diagnostic: what this claim's material actually amounts to.
 *
 * `independentSourceCount` counts confirmed independent information sources
 * behind the claim's verified support — five excerpts reprinting one report
 * are one source here, not five pieces of proof.
 */
export const ClaimQualityFindingSchema = z.object({
  claimId: IdSchema,
  statement: z.string().min(1),
  claimStatus: z.string().min(1),
  importance: z.number().int().min(1).max(5),
  /** The derived verdict, reported as it stands. Never rewritten here. */
  verdictStatus: ClaimVerdictStatusSchema,
  evidenceTotal: z.number().int().min(0),
  evidenceVerified: z.number().int().min(0),
  evidenceUnverified: z.number().int().min(0),
  evidenceSupporting: z.number().int().min(0),
  evidenceOpposing: z.number().int().min(0),
  /**
   * Confirmed independent information sources behind the verified support.
   * Null when independence could not be established for the material at all.
   */
  independentSourceCount: z.number().int().min(0).nullable(),
  unresolvedConflictCount: z.number().int().min(0),
  unansweredChallengeCount: z.number().int().min(0),
  openGapCount: z.number().int().min(0),
  blockingGapCount: z.number().int().min(0),
  /** Material whose source moved after it was confirmed. */
  sourceUpdateRiskCount: z.number().int().min(0),
  /** Cross-examination runs that targeted this claim (prompt 10 linkage). */
  relatedRunIds: z.array(IdSchema).default([]),
  findingIds: z.array(z.string()).default([]),
  recommendations: z.array(z.string()).default([])
});

export type ClaimQualityFinding = z.infer<typeof ClaimQualityFindingSchema>;

/**
 * Evidence-level diagnostic: can this excerpt still be checked, and by whom.
 *
 * `sourceUpdateRisk` is the only thing monitoring contributes, and it is a
 * request to re-read — the historical verification decision is carried through
 * untouched, because a page moving is not a person withdrawing a confirmation.
 */
export const EvidenceQualityFindingSchema = z.object({
  evidenceId: IdSchema,
  claimIds: z.array(IdSchema).default([]),
  title: z.string().min(1),
  direction: z.enum(["supports", "opposes", "context"]),
  verificationStatus: z.enum(["unverified", "verified", "rejected"]),
  /** Null when the row recorded none. Never filled in with a guess. */
  locatorStatus: z.enum(["unanchored", "anchored", "missing"]).nullable(),
  hasSourceRecord: z.boolean(),
  hasExcerpt: z.boolean(),
  hasLocator: z.boolean(),
  /** A verification without a named reviewer and a reason is not allowed here. */
  hasVerificationRecord: z.boolean(),
  sourceUpdateRisk: z.boolean(),
  sourceUpdateRiskReason: z.string().nullable().default(null),
  findingIds: z.array(z.string()).default([])
});

export type EvidenceQualityFinding = z.infer<
  typeof EvidenceQualityFindingSchema
>;

/**
 * Source-level diagnostic: what is known about this source's relationship to
 * the others.
 *
 * `relationStatus` is the strongest relationship the records establish:
 *   - `confirmed_same_origin` — a rule proved it (same canonical url, same
 *     content hash) or a person asserted it;
 *   - `suspected_same_origin` — a screen flagged it, nobody confirmed;
 *   - `independent` — a person explicitly declared the pair unrelated;
 *   - `unknown` — nothing establishes either way. Two different urls are not
 *     proof of independence, so `unknown` is the default and it is honest.
 */
export const SourceQualityFindingSchema = z.object({
  sourceId: IdSchema,
  title: z.string().min(1),
  publisher: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  relationStatus: z.enum([
    "confirmed_same_origin",
    "suspected_same_origin",
    "independent",
    "unknown"
  ]),
  confirmedSameOriginSourceIds: z.array(IdSchema).default([]),
  suspectedSameOriginSourceIds: z.array(IdSchema).default([]),
  /** Sources a person explicitly declared unrelated to this one. */
  unrelatedSourceIds: z.array(IdSchema).default([]),
  /** Sources whose relationship to this one nothing establishes. */
  undeterminedSourceIds: z.array(IdSchema).default([]),
  findingIds: z.array(z.string()).default([])
});

export type SourceQualityFinding = z.infer<typeof SourceQualityFindingSchema>;

/**
 * One actionable suggestion, aggregated per claim and category so the list
 * stays readable. `action` names a surface that already exists; the UI is what
 * performs it, through the same endpoints the rest of the app uses.
 */
export const QualityRecommendationSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().min(1),
  action: QualityRecommendationActionSchema,
  claimId: IdSchema.nullable().default(null),
  evidenceIds: z.array(IdSchema).default([]),
  sourceIds: z.array(IdSchema).default([]),
  /** The findings this recommendation answers. */
  findingIds: z.array(z.string()).default([])
});

export type QualityRecommendation = z.infer<typeof QualityRecommendationSchema>;

export const ResearchQualityAssessmentSchema = z.object({
  sessionId: IdSchema,
  assessedAt: TimestampSchema,
  schemaVersion: z.number().int().positive(),
  ruleVersion: z.string().min(1),
  /**
   * Fingerprint of the input rows (ids plus the states the rules read). The
   * same state always produces the same one, so two assessments can be
   * recognised as having read the same material.
   */
  inputFingerprint: z.string().length(16),
  overall: QualityOverallSchema,
  dimensions: z.array(QualityDimensionSchema).length(6),
  claimFindings: z.array(ClaimQualityFindingSchema).default([]),
  evidenceFindings: z.array(EvidenceQualityFindingSchema).default([]),
  sourceFindings: z.array(SourceQualityFindingSchema).default([]),
  findings: z.array(QualityFindingSchema).default([]),
  recommendations: z.array(QualityRecommendationSchema).default([]),
  /** What this assessment cannot tell you, in plain sentences. */
  limitations: z.array(z.string()).default([])
});

export type ResearchQualityAssessment = z.infer<
  typeof ResearchQualityAssessmentSchema
>;

/* ------------------------------------------------------------------ *
 * Input to the projection
 * ------------------------------------------------------------------ */

/**
 * Everything the projection reads. Assembled by the service from the same
 * workspace projection the research UI renders, plus the optional analyses
 * (independence, monitoring, plan, search) when those are configured.
 *
 * `assessedAt` is injected rather than read from the clock inside the pure
 * function, so a test can pin it and assert determinism.
 */
export type ResearchQualityInput = {
  sessionId: string;
  assessedAt: string;
  claims: readonly Claim[];
  evidence: readonly Evidence[];
  sources: readonly Source[];
  conflicts: readonly Conflict[];
  challenges: readonly Challenge[];
  verdicts: readonly ClaimVerdictForQuality[];
  gaps: readonly EvidenceGap[];
  agentRuns: readonly AgentRun[];
  /** Null when the independence analysis is not configured. */
  independence: IndependenceSummary | null;
  /** Null when source monitoring is not configured. */
  monitoring: {
    tasks: readonly RevalidationTask[];
    warnings: RevalidationReportWarnings;
  } | null;
  /** Empty when the research plan is not configured. */
  planItems: readonly ResearchPlanItem[];
  /** Null when controlled search is not configured. */
  searchTasks: ReadonlyArray<{ id: string; status: string }> | null;
};

/**
 * The verdict fields the quality rules read. Deliberately narrower than
 * `ClaimVerdict` so the projection states exactly what it consumes: the
 * status, the counts, and the ids of the excerpts that actually took part —
 * which is how "five excerpts, one origin" is told apart from five origins.
 */
export type ClaimVerdictForQuality = {
  claimId: string;
  status: ClaimVerdictStatus;
  counts: {
    total: number;
    verified: number;
    unverified: number;
    verifiedSupporting: number;
    verifiedOpposing: number;
  };
  basis: {
    supportingEvidenceIds: readonly string[];
    opposingEvidenceIds: readonly string[];
  };
};

/* ------------------------------------------------------------------ *
 * Labels
 * ------------------------------------------------------------------ */

export const QUALITY_DIMENSION_LABELS: Readonly<
  Record<QualityDimensionId, string>
> = {
  evidence_coverage: "证据覆盖率",
  verification_quality: "证据核实程度",
  source_independence: "来源独立性",
  conflict_resolution: "冲突处理情况",
  research_completeness: "研究完整度",
  source_freshness: "来源变化与复核风险"
};

export const QUALITY_STATUS_LABELS: Readonly<Record<QualityStatus, string>> = {
  strong: "充分",
  adequate: "基本满足",
  weak: "偏弱",
  at_risk: "存在风险",
  insufficient_data: "数据不足，无法评估"
};

export const QUALITY_SEVERITY_LABELS: Readonly<
  Record<QualitySeverity, string>
> = {
  info: "提示",
  warning: "警告",
  critical: "严重"
};

export const QUALITY_FINDING_CATEGORY_LABELS: Readonly<
  Record<QualityFindingCategory, string>
> = {
  missing_evidence: "缺少证据",
  unverified_evidence: "证据未核实",
  single_source_dependency: "单一来源依赖",
  unresolved_conflict: "未解决冲突",
  unanswered_challenge: "质询未回应",
  broken_citation: "引用位置失效",
  stale_source: "来源发生变化",
  open_research_gap: "研究缺口未处理",
  insufficient_independence: "来源独立性无法判断",
  duplicate_source: "确认同源来源",
  missing_source_record: "材料无来源记录",
  publisher_concentration: "发布方集中"
};
