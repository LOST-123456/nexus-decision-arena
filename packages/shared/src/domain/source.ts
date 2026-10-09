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
  updatedAt: true
}).superRefine(sourceUrlRule);

export type Source = z.infer<typeof SourceSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
