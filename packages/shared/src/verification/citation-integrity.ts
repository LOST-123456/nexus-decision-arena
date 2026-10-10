import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

/*
 * Two independent answers about one citation, kept deliberately apart.
 *
 *   A. 引用完整性 (CitationIntegrity) — can this quote still be found, in the
 *      version it was taken from, exactly as recorded? This is a question about
 *      the stored text and is answered deterministically by the server. It is
 *      not a question about truth.
 *
 *   B. 语义支持度 (SupportAssessment) — does this quote actually bear on the
 *      claim it is attached to? This is an interpretive, model-assisted read of
 *      one excerpt against one claim. It is advice, never a verdict, and it
 *      must never move `evidence.verificationStatus` on its own.
 *
 * Finding the words on a page does not mean the words support the claim. These
 * two axes are stored in two tables, surfaced as two separate states, and are
 * never reduced to a single score.
 */

/* ------------------------------------------------------------------ *
 * A. Citation integrity
 * ------------------------------------------------------------------ */

export const CitationIntegrityStatusSchema = z.enum([
  /**
   * Found verbatim in the source's current capture, and the capture is the
   * same version the excerpt was anchored against (or the excerpt had no
   * recorded version yet, so this is its first confirmation).
   */
  "anchored",
  /**
   * The source changed. Either the quote is still present but the current
   * capture is a different version than the one it was anchored against, or
   * the quote can only be found in an older capture. Nothing here says the
   * quote is wrong — it says the version it was checked against has moved and
   * a human must re-confirm.
   */
  "stale",
  /**
   * Part of the quote was found and part of it was not: the citation is
   * elided (contains "…") and some fragment no longer resolves, so the reader
   * is looking at a truncated or spliced quote rather than the real sentence.
   */
  "partial",
  /** The quote is not in the current capture, and not in any older one. */
  "missing",
  /**
   * There is nothing to locate: no anchor text and no locator were recorded.
   * An unregistered citation cannot be checked at all.
   */
  "unmapped",
  /**
   * The excerpt wants to be located, but this source has no stored text to
   * search (a manual source, or a page that was never captured). Being unable
   * to check is not the same as failing the check — this is not `missing`.
   */
  "unanchored"
]);

export type CitationIntegrityStatus = z.infer<
  typeof CitationIntegrityStatusSchema
>;

/** How the quote was matched inside the capture. */
export const CitationMatchKindSchema = z.enum([
  "exact",
  /** Matched after collapsing whitespace: the page reflowed, the words did not. */
  "normalized",
  /** An elided quote whose fragments all resolved in order. */
  "elided"
]);

export type CitationMatchKind = z.infer<typeof CitationMatchKindSchema>;

export const CitationOriginSchema = z.enum(["system", "human"]);
export type CitationOrigin = z.infer<typeof CitationOriginSchema>;

export const CitationIntegrityCheckSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  evidenceId: IdSchema,
  sourceId: IdSchema.nullable(),
  /** The capture the check ran against, so a later reading can reopen it. */
  snapshotId: IdSchema.nullable(),
  status: CitationIntegrityStatusSchema,
  matchKind: CitationMatchKindSchema.nullable(),
  anchorText: z.string().max(4000).nullable(),
  /** Version the excerpt was anchored against, when one was recorded. */
  expectedContentHash: z.string().max(128).nullable(),
  /** Version of the capture that was actually searched. */
  snapshotContentHash: z.string().max(128).nullable(),
  /** The text that was matched, so the reader can see what resolved. */
  matchedText: z.string().max(4000).nullable(),
  /** Surrounding text, so a reader can judge whether the quote was cut short. */
  contextText: z.string().max(4000).nullable(),
  /** Why this state. An unexplained check is not auditable. */
  reason: z.string().min(1).max(2000),
  origin: CitationOriginSchema,
  /** Who ran or corrected the check. Never taken from untrusted content. */
  actor: z.string().min(1).max(160),
  /** The check this one replaces, when a human corrected an earlier result. */
  supersedesId: IdSchema.nullable(),
  /** Only the newest check per excerpt is current; older ones stay readable. */
  isCurrent: z.boolean(),
  createdAt: TimestampSchema
});

export type CitationIntegrityCheck = z.infer<
  typeof CitationIntegrityCheckSchema
>;

/* ------------------------------------------------------------------ *
 * B. Claim–evidence support assessment
 * ------------------------------------------------------------------ */

export const SupportAssessmentStatusSchema = z.enum([
  "support",
  "oppose",
  /** Real material that bears on the claim but takes no side. */
  "context",
  /** The excerpt is real, but it does not carry the claim that far. */
  "insufficient",
  /** Real material whose bearing on the claim cannot be settled from the text. */
  "ambiguous"
]);

export type SupportAssessmentStatus = z.infer<
  typeof SupportAssessmentStatusSchema
>;

export const SupportAssessmentOriginSchema = z.enum(["model", "human"]);
export type SupportAssessmentOrigin = z.infer<
  typeof SupportAssessmentOriginSchema
>;

export const ClaimSupportAssessmentSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  claimId: IdSchema,
  evidenceId: IdSchema,
  status: SupportAssessmentStatusSchema,
  /**
   * 0..1 self-reported by the model. It is NOT a calibrated probability and
   * is never used to upgrade anything: it only tells a reader how much the
   * model itself hesitated.
   */
  confidence: z.number().min(0).max(1).nullable(),
  /** Why the excerpt bears (or fails to bear) on the claim. */
  rationale: z.string().min(1).max(4000),
  /** The fragment the assessment says it relied on. */
  matchedExcerpt: z.string().max(2000).nullable(),
  /**
   * Whether the server could actually find `matchedExcerpt` in the stored
   * source text. A fragment the server cannot locate is reported as
   * unlocated rather than shown as if the source really said it.
   */
  matchedExcerptLocated: z.boolean(),
  /** Specific signals, e.g. negation mismatch, unit mismatch, scope overreach. */
  signals: z.array(z.string().min(1).max(240)).default([]),
  /** Which model produced it; null for human corrections. */
  provider: z.string().max(80).nullable(),
  model: z.string().max(120).nullable(),
  promptVersion: z.string().min(1).max(80),
  origin: SupportAssessmentOriginSchema,
  actor: z.string().min(1).max(160),
  supersedesId: IdSchema.nullable(),
  isCurrent: z.boolean(),
  createdAt: TimestampSchema
});

export type ClaimSupportAssessment = z.infer<
  typeof ClaimSupportAssessmentSchema
>;

/* ------------------------------------------------------------------ *
 * Claim-level roll-up
 * ------------------------------------------------------------------ */

export const ClaimSupportSummaryStatusSchema = z.enum([
  "support",
  "oppose",
  /**
   * Material points both ways. Deliberately NOT resolved by counting: a claim
   * with three supporters and one opponent is `mixed`, not `support`.
   */
  "mixed",
  "context",
  "insufficient",
  "ambiguous",
  /** Nothing has been assessed yet for this claim. */
  "unassessed",
  /** Assessment was attempted and failed; the failure is the state. */
  "unavailable"
]);

export type ClaimSupportSummaryStatus = z.infer<
  typeof ClaimSupportSummaryStatusSchema
>;

export type ClaimSupportSummary = {
  claimId: string;
  status: ClaimSupportSummaryStatus;
  /** Counts by assessment status, so the roll-up can be re-derived by a reader. */
  counts: Record<SupportAssessmentStatus, number>;
  /**
   * Assessments whose cited fragment could not be located in the source. They
   * are reported, and they never count as verified support.
   */
  unlocatedCount: number;
  /** The disagreement is named, not averaged away. */
  note: string;
  assessmentIds: string[];
};

/**
 * Rolls per-excerpt assessments up to one claim.
 *
 * The rule that matters: **support and opposition do not cancel out**. When
 * both are present the summary is `mixed` regardless of how many items sit on
 * each side — a majority is not a resolution. Likewise an assessment whose
 * cited fragment could not be found in the source text is surfaced and never
 * counted towards support.
 */
export function summarizeClaimSupport(
  claimId: string,
  assessments: readonly ClaimSupportAssessment[],
  options: { unavailable?: boolean } = {}
): ClaimSupportSummary {
  const counts: Record<SupportAssessmentStatus, number> = {
    support: 0,
    oppose: 0,
    context: 0,
    insufficient: 0,
    ambiguous: 0
  };
  let unlocatedCount = 0;
  for (const item of assessments) {
    counts[item.status] += 1;
    if (!item.matchedExcerptLocated) {
      unlocatedCount += 1;
    }
  }

  const assessmentIds = assessments.map((item) => item.id).sort();

  if (options.unavailable === true) {
    return {
      claimId,
      status: "unavailable",
      counts,
      unlocatedCount,
      note: "支持度评估未能完成（模型不可用、超时或返回结构不合法），未得出对照结论。",
      assessmentIds
    };
  }

  if (assessments.length === 0) {
    return {
      claimId,
      status: "unassessed",
      counts,
      unlocatedCount,
      note: "尚未对该主张做摘录对照。",
      assessmentIds
    };
  }

  const unlocatedNote =
    unlocatedCount > 0
      ? `其中 ${unlocatedCount} 条评估引用的原文片段未能在来源中找到，不计为支持证据。`
      : "";

  if (counts.support > 0 && counts.oppose > 0) {
    return {
      claimId,
      status: "mixed",
      counts,
      unlocatedCount,
      note:
        `支持 ${counts.support} 条与反对 ${counts.oppose} 条并存；` +
        "按规则判定为冲突/混合，不按条数多数裁决。" +
        unlocatedNote,
      assessmentIds
    };
  }

  if (counts.support > 0) {
    return {
      claimId,
      status: "support",
      counts,
      unlocatedCount,
      note: `${counts.support} 条摘录支撑该主张${counts.insufficient > 0 ? `，另有 ${counts.insufficient} 条支撑不足` : ""}。${unlocatedNote}`,
      assessmentIds
    };
  }

  if (counts.oppose > 0) {
    return {
      claimId,
      status: "oppose",
      counts,
      unlocatedCount,
      note: `${counts.oppose} 条摘录与该主张相反。${unlocatedNote}`,
      assessmentIds
    };
  }

  if (counts.ambiguous > 0) {
    return {
      claimId,
      status: "ambiguous",
      counts,
      unlocatedCount,
      note: `摘录与该主张的关系不明确（${counts.ambiguous} 条），需要人工判断。${unlocatedNote}`,
      assessmentIds
    };
  }

  if (counts.context > 0) {
    return {
      claimId,
      status: "context",
      counts,
      unlocatedCount,
      note: `只有背景材料（${counts.context} 条），不构成支持或反对。${unlocatedNote}`,
      assessmentIds
    };
  }

  return {
    claimId,
    status: "insufficient",
    counts,
    unlocatedCount,
    note: `${counts.insufficient} 条摘录虽真实存在，但不足以支撑该主张。${unlocatedNote}`,
    assessmentIds
  };
}

/* ------------------------------------------------------------------ *
 * Failure vocabulary
 * ------------------------------------------------------------------ */

/**
 * Why a citation review did not happen. Named so the UI can say what to do
 * next instead of showing a bare error, and so "the model was unavailable" is
 * never displayed as "everything is fine".
 */
export const CitationReviewFailureCodeSchema = z.enum([
  /** Nothing to check: the session has no excerpts (or the claim has none). */
  "no_evidence",
  /** The claim or check id does not belong to this session. */
  "claim_not_found",
  "provider_unavailable",
  "timeout",
  "aborted",
  "refused",
  "empty_output",
  "invalid_json",
  "schema_rejected",
  "storage_unavailable"
]);

export type CitationReviewFailureCode = z.infer<
  typeof CitationReviewFailureCodeSchema
>;

/* ------------------------------------------------------------------ *
 * Human correction
 * ------------------------------------------------------------------ */

export const CitationCorrectionKindSchema = z.enum(["integrity", "support"]);
export type CitationCorrectionKind = z.infer<
  typeof CitationCorrectionKindSchema
>;

/**
 * What a human may supply to correct a check.
 *
 * Identity is server-derived and the previous result is never edited — the
 * correction is stored as a new record that points back at what it replaced.
 */
export const CitationCorrectionDraftSchema = z.object({
  kind: CitationCorrectionKindSchema,
  targetId: IdSchema,
  status: z.string().min(1).max(40),
  rationale: z.string().trim().min(10).max(2000)
});

export type CitationCorrectionDraft = z.infer<
  typeof CitationCorrectionDraftSchema
>;

/** Statuses a human may pick when correcting an integrity check. */
export const CORRECTABLE_INTEGRITY_STATUSES: readonly CitationIntegrityStatus[] =
  ["anchored", "stale", "partial", "missing", "unmapped", "unanchored"];

/** Statuses a human may pick when correcting a support assessment. */
export const CORRECTABLE_SUPPORT_STATUSES: readonly SupportAssessmentStatus[] = [
  "support",
  "oppose",
  "context",
  "insufficient",
  "ambiguous"
];

export function isCorrectableIntegrityStatus(
  value: string
): value is CitationIntegrityStatus {
  return (CORRECTABLE_INTEGRITY_STATUSES as readonly string[]).includes(value);
}

export function isCorrectableSupportStatus(
  value: string
): value is SupportAssessmentStatus {
  return (CORRECTABLE_SUPPORT_STATUSES as readonly string[]).includes(value);
}

/** Picks the newest assessment per (claim, evidence) pair. */
export function currentAssessments(
  assessments: readonly ClaimSupportAssessment[]
): ClaimSupportAssessment[] {
  const byPair = new Map<string, ClaimSupportAssessment>();
  for (const item of assessments) {
    const key = `${item.claimId}::${item.evidenceId}`;
    const existing = byPair.get(key);
    if (!existing || item.createdAt > existing.createdAt) {
      byPair.set(key, item);
    }
  }
  return [...byPair.values()];
}
