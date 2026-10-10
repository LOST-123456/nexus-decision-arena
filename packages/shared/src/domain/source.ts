import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

/**
 * A citable provenance record.
 *
 * A Source is *where* something was found; Evidence is *what* was found there.
 * One source can back many excerpts, so publication metadata (author, publisher,
 * publication date) lives here instead of being duplicated on every quote.
 */
export const SourceKindSchema = z.enum([
  "url",
  "document",
  "dataset",
  "manual"
]);

/**
 * Whether the page itself could be read. Deliberately its own axis: a source
 * can be `fetched` while every excerpt from it is still unverified, and a
 * `failed` retrieval says nothing about the quality of a hand-typed excerpt.
 */
export const SourceRetrievalStatusSchema = z.enum([
  "not_requested",
  "pending",
  "fetched",
  "failed"
]);

export type SourceRetrievalStatus = z.infer<
  typeof SourceRetrievalStatusSchema
>;

function sourceUrlRule(
  value: { kind: SourceKind; url?: string | undefined },
  context: z.RefinementCtx
): void {
  if (value.kind === "url" && !value.url) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "A url source requires a canonical url"
    });
  }
}

/** Object schema without the cross-field rule, so callers can `.omit()` it. */
export const SourceObjectSchema = z
  .object({
    id: IdSchema,
    sessionId: IdSchema,
    title: z.string().min(1).max(240),
    kind: SourceKindSchema,
    /** Canonical locator. Required for `url` sources. */
    url: z.preprocess(
      (value) => (value === null ? undefined : value),
      z.string().url().optional()
    ),
    /** Publishing organisation, e.g. "National Bureau of Statistics". */
    publisher: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().max(240).optional()
    ),
    /** Named author(s) or responsible body, free text. */
    author: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().max(240).optional()
    ),
    /** Publication date as declared by the source. */
    publishedAt: z.preprocess(
      (value) => (value === null ? undefined : value),
      TimestampSchema.optional()
    ),
    /** Why this source is considered relevant / trustworthy, or its limits. */
    note: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().max(2000).optional()
    ),
    /**
     * Normalized form of `url`, used to recognize a re-import of the same page.
     * Manual sources have none, which is why it is not the same column.
     */
    canonicalUrl: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().url().optional()
    ),
    /**
     * Retrieval state. Optional in the type so persisted rows and hand-built
     * literals stay compatible; the database supplies the default and a CHECK
     * keeps the value set closed.
     */
    retrievalStatus: SourceRetrievalStatusSchema.optional(),
    retrievalAttempts: z.preprocess(
      (value) => (value === null ? undefined : value),
      z.number().int().min(0).optional()
    ),
    /** When the stored content was actually read off the page. */
    retrievedAt: z.preprocess(
      (value) => (value === null ? undefined : value),
      TimestampSchema.optional()
    ),
    /** Why the last attempt failed. User-facing, so it never carries a stack. */
    retrievalError: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().max(1000).optional()
    ),
    contentType: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().max(240).optional()
    ),
    /** Hash of the current snapshot, so drift is detectable without a join. */
    contentHash: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().max(128).optional()
    ),
    contentBytes: z.preprocess(
      (value) => (value === null ? undefined : value),
      z.number().int().min(0).optional()
    ),
    createdBy: z.enum(["system", "agent", "human"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema
  });

export const SourceSchema = SourceObjectSchema.superRefine(sourceUrlRule);

/** Shape accepted when a researcher registers a source. */
export const SourceDraftSchema = SourceObjectSchema.omit({
  id: true,
  sessionId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  // Retrieval facts are produced by the importer, never typed into a draft.
  canonicalUrl: true,
  retrievalStatus: true,
  retrievalAttempts: true,
  retrievedAt: true,
  retrievalError: true,
  contentType: true,
  contentHash: true,
  contentBytes: true
}).superRefine(sourceUrlRule);

/**
 * One immutable capture of a page.
 *
 * Snapshots are appended, never rewritten: when a page changes the new capture
 * is added, and the older row is kept so an excerpt confirmed against it can
 * still be re-checked and the drift attributed to the right version.
 */
export const SourceSnapshotSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  sourceId: IdSchema,
  canonicalUrl: z.string(),
  contentHash: z.string(),
  title: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().max(240).optional()
  ),
  author: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().max(240).optional()
  ),
  publisher: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().max(240).optional()
  ),
  publishedAt: z.preprocess(
    (value) => (value === null ? undefined : value),
    TimestampSchema.optional()
  ),
  contentType: z.string().max(240),
  /** Extracted plain text. Untrusted data: never executed, never interpreted. */
  content: z.string(),
  contentBytes: z.number().int().min(0),
  charCount: z.number().int().min(0),
  retrievedAt: TimestampSchema,
  createdAt: TimestampSchema
});

export type Source = z.infer<typeof SourceSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;
