import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

/**
 * Immutable snapshots of the fact-check report, one per saved version.
 *
 * The distinction this file exists to keep:
 *
 * - `materialsFingerprint` is a **fingerprint**: the same material always
 *   produces the same one, so two reports built from identical rows can be
 *   recognised as identical. It says nothing about history — anyone can
 *   rebuild it at any time.
 * - A **snapshot** is the report as it was when a person chose to save it:
 *   the payload, the exact source versions it cited, the verdicts, the
 *   rulings and the monitoring risks, all frozen together with a version
 *   number. Reading an old version re-reads the stored payload; it never
 *   re-derives conclusions from current rows.
 *
 * Saving a snapshot writes nothing else: no claim status, no verification
 * status, no review, no capture is created or edited by this feature.
 */

/** Bumped when the shape of `reportPayload` changes incompatibly. */
export const REPORT_SCHEMA_VERSION = 1;

/** What one saved version says about itself, without its payload. */
export const ReportSnapshotSummarySchema = z.object({
  snapshotId: IdSchema,
  sessionId: IdSchema,
  /** Stable per session, starting at 1 and never reused. */
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  /** Who asked for the version, from the server's own session. */
  createdBy: z.string().min(1),
  /** Why this version was saved, in the saver's words. */
  changeReason: z.string().nullable(),
  materialsFingerprint: z.string().length(16),
  claimCount: z.number().int().min(0),
  evidenceCount: z.number().int().min(0),
  sourceCount: z.number().int().min(0),
  unresolvedConflicts: z.number().int().min(0),
  openRevalidations: z.number().int().min(0),
  inReviewRevalidations: z.number().int().min(0)
});

export type ReportSnapshotSummary = z.infer<
  typeof ReportSnapshotSummarySchema
>;

/**
 * The exact capture of a source a version cited.
 *
 * `snapshotId` is the row the version was drawn from. It is a reference, not
 * a foreign key: a capture may legitimately be cleaned up later, and a
 * version must not pretend the capture is still there when it is gone —
 * readers see `present: false` instead.
 */
export const ReportSourceReferenceSchema = z.object({
  sourceId: IdSchema,
  snapshotId: IdSchema.nullable(),
  contentHash: z.string().nullable(),
  title: z.string(),
  retrievedAt: TimestampSchema.nullable(),
  /** False when the cited capture no longer exists. Never invented. */
  present: z.boolean()
});

export type ReportSourceReference = z.infer<
  typeof ReportSourceReferenceSchema
>;

/** One excerpt as the version saw it, for diffing without the payload. */
export const ReportEvidenceReferenceSchema = z.object({
  evidenceId: IdSchema,
  title: z.string(),
  sourceId: IdSchema.nullable(),
  verificationStatus: z.string(),
  /** Null when the row recorded none. Never filled in with a guess. */
  locatorStatus: z.string().nullable()
});

export type ReportEvidenceReference = z.infer<
  typeof ReportEvidenceReferenceSchema
>;

/** The conclusion each claim carried at save time. */
export const ReportClaimReferenceSchema = z.object({
  claimId: IdSchema,
  statement: z.string(),
  claimStatus: z.string(),
  verdictStatus: z.string(),
  verdictConfidence: z.number()
});

export type ReportClaimReference = z.infer<typeof ReportClaimReferenceSchema>;

/** A ruling as it stood at save time. */
export const ReportReviewReferenceSchema = z.object({
  reviewId: IdSchema,
  claimId: IdSchema,
  outcome: z.string(),
  reviewer: z.string(),
  createdAt: TimestampSchema
});

export type ReportReviewReference = z.infer<typeof ReportReviewReferenceSchema>;

/** The monitoring risk a version was saved under. */
export const ReportMonitoringReferenceSchema = z.object({
  taskId: IdSchema,
  sourceId: IdSchema,
  status: z.string()
});

export type ReportMonitoringReference = z.infer<
  typeof ReportMonitoringReferenceSchema
>;

/**
 * A saved version, payload included.
 *
 * `reportPayload` is the fact-check report object as built at save time; its
 * shape is defined by `reportSchemaVersion`. It is stored verbatim and never
 * regenerated on read, so an old version cannot silently absorb newer
 * material.
 */
export const ResearchReportSnapshotSchema = z.object({
  snapshotId: IdSchema,
  sessionId: IdSchema,
  version: z.number().int().positive(),
  createdAt: TimestampSchema,
  createdBy: z.string().min(1),
  researchQuestion: z.string().nullable(),
  reportSchemaVersion: z.number().int().positive(),
  materialsFingerprint: z.string().length(16),
  /** sha256 over the canonical form of `reportPayload`. */
  snapshotHash: z.string().length(64),
  reportPayload: z.unknown(),
  sourceReferences: z.array(ReportSourceReferenceSchema),
  evidenceReferences: z.array(ReportEvidenceReferenceSchema),
  claimReferences: z.array(ReportClaimReferenceSchema),
  reviewReferences: z.array(ReportReviewReferenceSchema),
  monitoringReferences: z.array(ReportMonitoringReferenceSchema),
  changeReason: z.string().nullable()
});

export type ResearchReportSnapshot = z.infer<
  typeof ResearchReportSnapshotSchema
>;

/*
 * Version comparison.
 *
 * Two rules the diff exists to enforce:
 *
 * 1. Entities are matched by id, never by text. Two claims are "the same
 *    claim" because they share an id; anything else is an addition or a
 *    removal and is labelled as such. Text similarity is not evidence.
 * 2. A source moving is not a conclusion falling over. Entries are
 *    categorised: `verdict` changes are about what the material supports,
 *    `risk` changes are about whether that material is still current. The
 *    two are reported side by side and never merged into one status.
 */

export const REPORT_DIFF_ENTITY_TYPES = [
  "claim",
  "evidence",
  "source",
  "review",
  "conflict",
  "revalidation"
] as const;

export const ReportDiffEntityTypeSchema = z.enum(REPORT_DIFF_ENTITY_TYPES);

export type ReportDiffEntityType = z.infer<typeof ReportDiffEntityTypeSchema>;

export const ReportDiffChangeKindSchema = z.enum(["added", "removed", "changed"]);

export type ReportDiffChangeKind = z.infer<typeof ReportDiffChangeKindSchema>;

/** `verdict`: what the material supports. `risk`: whether it is still current. */
export const ReportDiffCategorySchema = z.enum(["verdict", "risk"]);

export type ReportDiffCategory = z.infer<typeof ReportDiffCategorySchema>;

export const ReportDiffEntrySchema = z.object({
  entityType: ReportDiffEntityTypeSchema,
  entityId: IdSchema,
  kind: ReportDiffChangeKindSchema,
  category: ReportDiffCategorySchema,
  /** The field that moved, for `changed` entries. Null for add/remove. */
  field: z.string().nullable(),
  oldValue: z.unknown().nullable(),
  newValue: z.unknown().nullable(),
  /**
   * Why the value moved, only when the stored rows say so outright (a
   * ruling's own words, a verdict's own rationale). Never a guess.
   */
  reason: z.string().nullable(),
  relatedSourceIds: z.array(IdSchema),
  /** When the underlying row last moved, when it is known. */
  changedAt: TimestampSchema.nullable()
});

export type ReportDiffEntry = z.infer<typeof ReportDiffEntrySchema>;

export const ReportVersionDiffSchema = z.object({
  fromSnapshotId: IdSchema,
  toSnapshotId: IdSchema,
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  fromMaterialsFingerprint: z.string().length(16),
  toMaterialsFingerprint: z.string().length(16),
  entries: z.array(ReportDiffEntrySchema),
  counts: z.object({
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    changed: z.number().int().min(0),
    verdict: z.number().int().min(0),
    risk: z.number().int().min(0)
  })
});

export type ReportVersionDiff = z.infer<typeof ReportVersionDiffSchema>;
