import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

/**
 * Cross-research library & evidence reuse.
 *
 * The domain rule this module exists to encode: material belongs to the
 * research session it was collected in. Reuse across sessions happens only
 * through an explicit copy that keeps its origin reference, or through a
 * named share grant — never by letting one session read another session's
 * rows as if they were its own. A copy never inherits the origin's human
 * verification: only material travels, and the target session re-decides
 * everything (including whether an excerpt is evidence at all).
 *
 * Nothing in here relaxes the existing per-session boundary. The library is
 * an additional, explicitly authorized surface; the session-scoped APIs keep
 * answering 404 for foreign ids exactly as before.
 */

/** Who a grant is given to: one named user, or everyone holding a role. */
export const ShareGrantSubjectTypeSchema = z.enum(["user", "role"]);

/**
 * What the grant permits. `read` and `copy` both allow browsing the shared
 * material; the distinction is recorded so a future tightening (browse-only
 * shares) does not need a data migration, and so audit can tell them apart.
 */
export const ShareGrantScopeSchema = z.enum(["read", "copy"]);

export const ShareGrantSchema = z.object({
  id: IdSchema,
  /** The session whose material is shared — the *source* side. */
  sessionId: IdSchema,
  subjectType: ShareGrantSubjectTypeSchema,
  subjectId: z.string().min(1).max(120),
  scope: ShareGrantScopeSchema,
  /** Who granted it, taken from the server-side identity. */
  grantedBy: z.string().min(1).max(120),
  grantedAt: TimestampSchema,
  /** Revocation keeps the row: an audit trail that forgets is not one. */
  revokedAt: TimestampSchema.optional(),
  revokedBy: z.string().min(1).max(120).optional(),
  revokeReason: z.string().max(1000).optional()
});

export const ShareGrantDraftSchema = z.object({
  sessionId: IdSchema,
  subjectType: ShareGrantSubjectTypeSchema,
  subjectId: z.string().min(1).max(120),
  scope: ShareGrantScopeSchema
});

export const ShareGrantRevokeSchema = z.object({
  reason: z.string().trim().max(1000).optional()
});

/**
 * Whether a copy has drifted from the version it was copied as.
 *
 * A *recorded* fact about the copy itself, maintained by writes inside the
 * target session. It deliberately does not try to describe the origin side:
 * that is derived live (see `CopyOriginStatusSchema`) and must never be
 * persisted as if it were history.
 */
export const SourceCopyForkStateSchema = z.enum(["synced", "forked"]);

/**
 * Live view of the copy's relationship to its origin. Computed on read from
 * the origin's current snapshot and the grant state — never stored, so it
 * cannot go stale in the database while claiming to be current.
 */
export const CopyOriginStatusSchema = z.enum([
  /** The origin's latest snapshot is still the one this copy was made from. */
  "current",
  /** The origin has moved to a newer snapshot; this copy has not followed. */
  "changed",
  /** The grant that made this copy possible is revoked or gone. */
  "revoked",
  /** The origin session or source no longer exists. */
  "unavailable"
]);

/** One row of the cross-research library listing. */
export const LibrarySourceSummarySchema = z.object({
  sourceId: IdSchema,
  sessionId: IdSchema,
  title: z.string().min(1).max(240),
  kind: z.string().min(1),
  url: z.string().url().optional(),
  canonicalUrl: z.string().url().optional(),
  publisher: z.string().max(240).optional(),
  author: z.string().max(240).optional(),
  publishedAt: TimestampSchema.optional(),
  /** Distinct languages seen across the source's snapshots. */
  languages: z.array(z.string().max(24)),
  /** How many immutable captures exist; 0 means nothing was ever read. */
  snapshotCount: z.number().int().min(0),
  latestSnapshotAt: TimestampSchema.optional(),
  contentHash: z.string().max(128).optional(),
  retrievalStatus: z.string().min(1),
  /** True when the calling research already holds a copy of this source. */
  alreadyCopied: z.boolean()
});

/** The original source as seen through the library: metadata + versions. */
export const LibrarySourceDetailSchema = LibrarySourceSummarySchema.extend({
  note: z.string().max(2000).optional(),
  versions: z.array(
    z.object({
      snapshotId: IdSchema,
      contentHash: z.string().min(1),
      title: z.string().max(240).optional(),
      author: z.string().max(240).optional(),
      publisher: z.string().max(240).optional(),
      publishedAt: TimestampSchema.optional(),
      contentType: z.string().min(1).max(240),
      contentBytes: z.number().int().min(0),
      charCount: z.number().int().min(0),
      sourceLanguage: z.string().max(24).optional(),
      retrievedAt: TimestampSchema
    })
  )
});

/** Lineage of one copied source, as shown in the target research. */
export const SourceCopyRecordSchema = z.object({
  sessionId: IdSchema,
  sourceId: IdSchema,
  originSessionId: IdSchema,
  originSourceId: IdSchema,
  /** Absent for a reference copy: metadata only, no captured text. */
  originSnapshotId: IdSchema.optional(),
  originSnapshotHash: z.string().min(1).max(128).optional(),
  copiedBy: z.string().min(1).max(120),
  copiedAt: TimestampSchema,
  forkState: SourceCopyForkStateSchema,
  forkedAt: TimestampSchema.optional(),
  /** Derived live; see `CopyOriginStatusSchema`. */
  originStatus: CopyOriginStatusSchema
});

export const LibraryCopyCommandSchema = z.object({
  sourceSessionId: IdSchema,
  sourceId: IdSchema
});

/** A source session the caller may browse, with why they may browse it. */
export const LibrarySessionSummarySchema = z.object({
  sessionId: IdSchema,
  researchQuestion: z.string().max(1000).optional(),
  /** `own` when the caller owns the session, `granted` otherwise. */
  access: z.enum(["own", "granted"]),
  grantId: IdSchema.optional(),
  grantScope: ShareGrantScopeSchema.optional(),
  sourceCount: z.number().int().min(0),
  updatedAt: TimestampSchema
});

export const LibrarySearchFiltersSchema = z.object({
  query: z.string().trim().max(200).optional(),
  publisher: z.string().trim().max(120).optional(),
  author: z.string().trim().max(120).optional(),
  /** Host of the canonical url, e.g. "stats.gov.cn". */
  domain: z.string().trim().max(240).optional(),
  publishedFrom: TimestampSchema.optional(),
  publishedTo: TimestampSchema.optional(),
  language: z.string().trim().max(24).optional(),
  sessionId: IdSchema.optional(),
  /**
   * The research the caller is copying *into*, when they have one in mind.
   * Only used to flag sources that research already holds; it never widens
   * what the caller may see.
   */
  targetSessionId: IdSchema.optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional()
});

export const LibrarySearchResultSchema = z.object({
  sources: z.array(LibrarySourceSummarySchema),
  total: z.number().int().min(0)
});

export type ShareGrant = z.infer<typeof ShareGrantSchema>;
export type ShareGrantDraft = z.infer<typeof ShareGrantDraftSchema>;
export type ShareGrantSubjectType = z.infer<
  typeof ShareGrantSubjectTypeSchema
>;
export type ShareGrantScope = z.infer<typeof ShareGrantScopeSchema>;
export type SourceCopyForkState = z.infer<typeof SourceCopyForkStateSchema>;
export type CopyOriginStatus = z.infer<typeof CopyOriginStatusSchema>;
export type LibrarySourceSummary = z.infer<typeof LibrarySourceSummarySchema>;
export type LibrarySourceDetail = z.infer<typeof LibrarySourceDetailSchema>;
export type SourceCopyRecord = z.infer<typeof SourceCopyRecordSchema>;
export type LibraryCopyCommand = z.infer<typeof LibraryCopyCommandSchema>;
export type LibrarySessionSummary = z.infer<
  typeof LibrarySessionSummarySchema
>;
export type LibrarySearchFilters = z.infer<typeof LibrarySearchFiltersSchema>;
export type LibrarySearchResult = z.infer<typeof LibrarySearchResultSchema>;
