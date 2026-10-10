import { z } from "zod";

/**
 * The agreed shape of a model's answer when asked to break a page into claims.
 *
 * The schema itself is a control, not just a convenience: limiting array sizes
 * and string lengths caps how much unverified material one request can propose,
 * and requiring `rationale` on every item means nothing arrives without a
 * reason the researcher can read and argue with.
 *
 * Note what is *not* here — there is no field for a locator, a verification
 * status, an id or a permission. Those are decided by the server, so an answer
 * cannot grant itself anything by naming a value.
 */

const MAX_CLAIMS_PER_SEGMENT = 12;
const MAX_EXCERPTS_PER_CLAIM = 6;
const MAX_STATEMENT = 1200;
const MAX_EXCERPT = 1200;
const MAX_REASON = 800;
const MAX_LIST_ITEM = 400;

export const ModelClaimTypeSchema = z.enum([
  "fact",
  "causal",
  "prediction",
  "opinion"
]);

export const ModelDirectionSchema = z.enum(["supports", "opposes", "context"]);

export const ModelExcerptSchema = z.object({
  /**
   * Verbatim text from the document. It must be copied out of the page rather
   * than summarised, otherwise it could never be located again.
   */
  excerpt: z.string().min(1).max(MAX_EXCERPT),
  title: z.string().min(1).max(240),
  direction: ModelDirectionSchema,
  rationale: z.string().min(1).max(MAX_REASON),
  uncertainty: z.array(z.string().min(1).max(MAX_LIST_ITEM)).max(5).default([])
});

export const ModelClaimSchema = z.object({
  statement: z.string().min(1).max(MAX_STATEMENT),
  type: ModelClaimTypeSchema,
  /** Conditions and scope kept with the statement, so splitting does not widen it. */
  qualifiers: z.array(z.string().min(1).max(MAX_LIST_ITEM)).max(8).default([]),
  /** What the model could not determine from this text alone. */
  uncertainty: z.array(z.string().min(1).max(MAX_LIST_ITEM)).max(5).default([]),
  /** Why this reading was proposed. An unexplained suggestion is not reviewable. */
  rationale: z.string().min(1).max(MAX_REASON),
  importance: z.number().int().min(1).max(5).default(3),
  evidence: z.array(ModelExcerptSchema).max(MAX_EXCERPTS_PER_CLAIM).default([])
});

export const ModelExtractionSchema = z.object({
  claims: z.array(ModelClaimSchema).max(MAX_CLAIMS_PER_SEGMENT).default([]),
  /**
   * Notes the model wrote about the document as a whole, kept separate from
   * per-claim uncertainty so the workspace can show "this page was vague"
   * without attaching it to a specific claim.
   */
  documentNotes: z.array(z.string().min(1).max(MAX_LIST_ITEM)).max(8).default([])
});

export type ModelExtraction = z.infer<typeof ModelExtractionSchema>;
export type ModelClaim = z.infer<typeof ModelClaimSchema>;
export type ModelExcerpt = z.infer<typeof ModelExcerptSchema>;

export const MODEL_LIMITS = {
  maxClaimsPerSegment: MAX_CLAIMS_PER_SEGMENT,
  maxExcerptsPerClaim: MAX_EXCERPTS_PER_CLAIM,
  maxStatement: MAX_STATEMENT,
  maxExcerpt: MAX_EXCERPT
} as const;
