import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";
import { EvidenceDirectionSchema } from "../domain/evidence";

/**
 * Source monitoring and revalidation: knowing whether the pages a research
 * depended on have changed, without ever rewriting what a person decided.
 *
 * Three rules this module is built around:
 *
 *  1. **Monitoring state is its own axis.** It is not `retrievalStatus` (could
 *     the page be read) and not `verificationStatus` (did anyone stand behind
 *     an excerpt). A page can be perfectly readable and unchanged while every
 *     excerpt from it is still unverified.
 *  2. **A failed check is not a change.** A timeout, a 403 and a DNS failure
 *     say the page could not be read *now*; they say nothing about its
 *     content, and they never downgrade a historical verification.
 *  3. **A change produces work, not an edit.** The system records the drift,
 *     keeps both versions, derives what is affected and asks a person to
 *     re-check. It does not write `verified`, `rejected` or a verdict.
 */

/**
 * What the last check of a source established.
 *
 * `not_checked` and `checking` are distinct on purpose: "nobody looked" and
 * "somebody is looking right now" are different answers to the same question,
 * and collapsing them would let an in-flight check read as a completed one.
 */
export const SourceMonitorStatusSchema = z.enum([
  /** No check has ever completed for this source. */
  "not_checked",
  /** A check is running right now. */
  "checking",
  /** The page was read and its text is the version already stored. */
  "unchanged",
  /** The page was read and its text is a version that was not stored before. */
  "changed",
  /**
   * The source could not be read this time — network, timeout, a non-2xx
   * status, a blocked target. This is *not* a statement about content.
   */
  "unavailable",
  /** The check itself could not be carried out (bad input, exhausted budget). */
  "failed"
]);

export type SourceMonitorStatus = z.infer<typeof SourceMonitorStatusSchema>;

/**
 * What a source change does to one excerpt.
 *
 * Deliberately *not* a stored column: it is derived per check by comparing the
 * excerpt against both versions, so it can never drift from the material and
 * can never be typed in. `locatorStatus` stays what it is — a locator finding
 * — and `verificationStatus` stays what a person decided.
 */
export const EvidenceImpactStatusSchema = z.enum([
  /** Still locatable, and the version it was checked against is current. */
  "unaffected",
  /** Still locatable, but against a different position or a new version. */
  "anchor_moved",
  /** The surrounding text changed even though the quote is still there. */
  "content_changed",
  /** The quote is not in the current version of the source any more. */
  "anchor_missing",
  /** Nothing could be established: no anchor, or no capture to compare to. */
  "needs_review"
]);

export type EvidenceImpactStatus = z.infer<typeof EvidenceImpactStatusSchema>;

/** A source change's effect on one excerpt, derived and never persisted. */
export const EvidenceImpactSchema = z.object({
  evidenceId: IdSchema,
  title: z.string(),
  impact: EvidenceImpactStatusSchema,
  /** Why this outcome, in terms a researcher can act on. */
  reason: z.string(),
  /** The excerpt's own locator, unchanged by monitoring. */
  locator: z.string().nullable(),
  locatorStatus: z.enum(["unanchored", "anchored", "missing"]),
  /** The historical verification decision, carried through untouched. */
  verificationStatus: z.enum(["verified", "rejected", "unverified"]),
  direction: EvidenceDirectionSchema
});

export type EvidenceImpact = z.infer<typeof EvidenceImpactSchema>;

/**
 * A source change's effect on one claim, projected from the material.
 *
 * A projection, never a write: `claim.status` and the derived verdict are not
 * touched, and the wording is a request to re-check rather than a finding
 * that the conclusion is wrong.
 */
export const ClaimImpactSchema = z.object({
  claimId: IdSchema,
  statement: z.string(),
  /** The verdict as it stands now; reported, not rewritten. */
  verdictStatus: z.string(),
  affectedEvidenceIds: z.array(IdSchema),
  /** Which changed sources this claim's material came from. */
  sourceIds: z.array(IdSchema),
  reason: z.string()
});

export type ClaimImpact = z.infer<typeof ClaimImpactSchema>;

/** One segment of a text comparison. */
export const SnapshotDiffSegmentSchema = z.object({
  kind: z.enum(["same", "added", "removed"]),
  text: z.string()
});

export type SnapshotDiffSegment = z.infer<typeof SnapshotDiffSegmentSchema>;

/**
 * A change a person should look at first.
 *
 * Advisory only: a number, a date or a negation that moved is worth a second
 * look, and saying so is not the same as concluding that the fact changed.
 */
export const DiffHighlightSchema = z.object({
  kind: z.enum(["number", "date", "negation", "length"]),
  /** The text that moved, exactly as it appears. */
  text: z.string(),
  segment: z.enum(["added", "removed"])
});

export type DiffHighlight = z.infer<typeof DiffHighlightSchema>;

/** The comparison between two stored captures of one source. */
export const SnapshotDiffSchema = z.object({
  sourceId: IdSchema,
  sessionId: IdSchema,
  previousSnapshotId: IdSchema.nullable(),
  currentSnapshotId: IdSchema.nullable(),
  previousContentHash: z.string().nullable(),
  currentContentHash: z.string().nullable(),
  previousRetrievedAt: TimestampSchema.nullable(),
  currentRetrievedAt: TimestampSchema.nullable(),
  previousCharCount: z.number().int().min(0),
  currentCharCount: z.number().int().min(0),
  titleChanged: z.boolean(),
  previousTitle: z.string().nullable(),
  currentTitle: z.string().nullable(),
  /** Whole-paragraph level changes; identical text is collapsed. */
  segments: z.array(SnapshotDiffSegmentSchema),
  addedChars: z.number().int().min(0),
  removedChars: z.number().int().min(0),
  highlights: z.array(DiffHighlightSchema),
  /**
   * Excerpts that were anchored in the older version and are not present in
   * the newer one. Names the quotes, so a researcher does not have to find
   * them again.
   */
  missingExcerpts: z.array(
    z.object({
      evidenceId: IdSchema,
      title: z.string(),
      anchorText: z.string()
    })
  )
});

export type SnapshotDiff = z.infer<typeof SnapshotDiffSchema>;

/**
 * A re-check a person owes because a source moved underneath a conclusion.
 *
 * Persisted, scoped to a session, and attributed to whoever closed it. The
 * trigger fingerprint is what makes repeated checks idempotent: the same
 * version of the same source cannot open a second task. Status changes are
 * appended to `revalidation_task_events`, so the id stays addressable while
 * the history of who moved it, and why, survives.
 */
export const RevalidationTaskStatusSchema = z.enum([
  "open",
  "in_review",
  "resolved",
  "dismissed"
]);

export type RevalidationTaskStatus = z.infer<typeof RevalidationTaskStatusSchema>;

export const RevalidationTaskSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  sourceId: IdSchema,
  sourceTitle: z.string(),
  /**
   * Content hash of the version that triggered this task. Two checks of the
   * same new version resolve to the same task.
   */
  triggerContentHash: z.string(),
  /** The capture the drift was measured against, when there was one. */
  previousSnapshotId: IdSchema.nullable(),
  currentSnapshotId: IdSchema.nullable(),
  affectedEvidenceIds: z.array(IdSchema),
  affectedClaimIds: z.array(IdSchema),
  reason: z.string(),
  status: RevalidationTaskStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  resolvedAt: TimestampSchema.nullable(),
  resolvedBy: z.string().nullable(),
  resolutionNote: z.string().nullable()
});

export type RevalidationTask = z.infer<typeof RevalidationTaskSchema>;

/** What a check established, as reported to the workspace. */
export const SourceCheckOutcomeSchema = z.object({
  sourceId: IdSchema,
  sessionId: IdSchema,
  status: SourceMonitorStatusSchema,
  /** Machine-readable reason for a non-`unchanged` outcome. */
  reasonCode: z.string().nullable(),
  message: z.string(),
  checkedAt: TimestampSchema,
  checkedBy: z.string(),
  previousSnapshotId: IdSchema.nullable(),
  currentSnapshotId: IdSchema.nullable(),
  previousContentHash: z.string().nullable(),
  currentContentHash: z.string().nullable(),
  /** HTTP status the page answered with, when it answered at all. */
  httpStatus: z.number().int().nullable(),
  /** True when the check stored a capture that was not stored before. */
  newVersionStored: z.boolean(),
  evidenceImpacts: z.array(EvidenceImpactSchema),
  claimImpacts: z.array(ClaimImpactSchema),
  /** The re-check this change asks for, when one was opened. */
  revalidationTask: RevalidationTaskSchema.nullable(),
  /** How many checks this source has left before the budget is spent. */
  remainingChecks: z.number().int().min(0)
});

export type SourceCheckOutcome = z.infer<typeof SourceCheckOutcomeSchema>;

/** Monitoring status + the open work for one source, as the workspace reads it. */
export const SourceMonitoringSummarySchema = z.object({
  sourceId: IdSchema,
  sessionId: IdSchema,
  title: z.string(),
  kind: z.enum(["url", "document", "dataset", "manual"]),
  url: z.string().nullable(),
  monitorStatus: SourceMonitorStatusSchema,
  lastCheckedAt: TimestampSchema.nullable(),
  lastCheckedBy: z.string().nullable(),
  /** Number of stored captures; a source with one has never drifted. */
  snapshotCount: z.number().int().min(0),
  currentContentHash: z.string().nullable(),
  currentSnapshotId: IdSchema.nullable(),
  latestCheckStatus: SourceMonitorStatusSchema.nullable(),
  openTaskId: IdSchema.nullable()
});

export type SourceMonitoringSummary = z.infer<typeof SourceMonitoringSummarySchema>;

/**
 * What the report needs to say about monitoring.
 *
 * Reported alongside the conclusion and never folded into it: an open
 * re-check is a reason to re-read the report, not a reason to change the
 * verdict, and the verdict pipeline cannot see this block.
 */
export const RevalidationReportWarningsSchema = z.object({
  openTaskCount: z.number().int().min(0),
  inReviewTaskCount: z.number().int().min(0),
  changedSources: z.array(
    z.object({
      sourceId: IdSchema,
      title: z.string(),
      checkedAt: TimestampSchema,
      currentContentHash: z.string()
    })
  ),
  evidenceNeedingReconfirmation: z.array(
    z.object({
      evidenceId: IdSchema,
      title: z.string(),
      sourceId: IdSchema,
      reason: z.string()
    })
  ),
  affectedClaims: z.array(
    z.object({
      claimId: IdSchema,
      statement: z.string()
    })
  ),
  lastCheckedAt: TimestampSchema.nullable(),
  /** The exact version of each source the report was built from. */
  sourceVersions: z.array(
    z.object({
      sourceId: IdSchema,
      title: z.string(),
      contentHash: z.string().nullable(),
      retrievedAt: TimestampSchema.nullable()
    })
  )
});

export type RevalidationReportWarnings = z.infer<
  typeof RevalidationReportWarningsSchema
>;

export const SOURCE_MONITOR_STATUS_TEXT: Readonly<
  Record<SourceMonitorStatus, string>
> = {
  not_checked: "尚未检查",
  checking: "检查中",
  unchanged: "内容未变化",
  changed: "内容发生变化",
  unavailable: "来源暂时不可用",
  failed: "检查失败"
};

export const EVIDENCE_IMPACT_TEXT: Readonly<
  Record<EvidenceImpactStatus, string>
> = {
  unaffected: "不受影响",
  anchor_moved: "摘录位置移动",
  content_changed: "上下文已变化",
  anchor_missing: "原文摘录已消失",
  needs_review: "需要人工判断"
};

export const REVALIDATION_TASK_STATUS_TEXT: Readonly<
  Record<RevalidationTaskStatus, string>
> = {
  open: "待重新核查",
  in_review: "复核中",
  resolved: "已复核完成",
  dismissed: "已判定无需复核"
};

/**
 * Whether a check outcome is one a person has to act on.
 *
 * Used by the workspace badge and the report so the two can never disagree
 * about what "needs attention" means.
 */
export function sourceMonitorStatusNeedsAttention(
  status: SourceMonitorStatus
): boolean {
  return status === "changed";
}

/** A check that could not reach the source never counts as a change. */
export function isUnavailableOutcome(status: SourceMonitorStatus): boolean {
  return status === "unavailable" || status === "failed";
}
