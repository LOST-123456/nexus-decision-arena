import { z } from "zod";

/**
 * What the model is allowed to say about one excerpt versus one claim.
 *
 * Every field is a judgement about *text* and nothing else. There is no
 * verification status here, no confidence in the source, no instruction to
 * write anything, and no field that could promote an excerpt: the server
 * decides which claim and excerpt each row belongs to, and whether the cited
 * fragment actually exists in the stored page.
 */
export const ModelSupportAssessmentSchema = z.object({
  /** Must match one of the ids the server handed over; anything else is dropped. */
  evidenceId: z.string().min(1).max(64),
  status: z.enum([
    "support",
    "oppose",
    "context",
    "insufficient",
    "ambiguous"
  ]),
  confidence: z.number().min(0).max(1),
  /** Why. A reading without a reason cannot be reviewed by a person. */
  rationale: z.string().min(10).max(800),
  /** The fragment the reading rests on — checked against the source server-side. */
  matchedExcerpt: z.string().min(1).max(600),
  /**
   * Concrete mismatches: negation dropped, number or unit changed, comparison
   * target missing, correlation read as causation, qualifier lost, quote cut.
   */
  signals: z.array(z.string().min(1).max(120)).max(6).default([])
});

export const ModelSupportSchema = z.object({
  assessments: z.array(ModelSupportAssessmentSchema).max(40)
});

export type ModelSupportAssessment = z.infer<
  typeof ModelSupportAssessmentSchema
>;

export const CITATION_REVIEW_PROMPT_VERSION = "citation-review-v1";
