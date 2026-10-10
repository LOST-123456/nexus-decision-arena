import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";
import { ClaimVerdictStatusSchema } from "./claim-verdict";
import {
  ClaimReviewOutcomeSchema,
  reviewOutcomeLabel,
  type ClaimReviewOutcome
} from "./review-outcome";

/**
 * A persisted human ruling on what can be concluded about ONE claim.
 *
 * Reviews are append-only: recording a new one never rewrites an earlier one,
 * so the audit trail of who concluded what, when, on which material, and
 * against which derived verdict, survives every later decision.
 */
export const ClaimReviewSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  claimId: IdSchema,
  outcome: ClaimReviewOutcomeSchema,
  /** Why the reviewer concluded this. An unexplained ruling is not auditable. */
  rationale: z.string().min(10).max(4000),
  /** Actor taken from the authenticated session, never from the request body. */
  reviewer: z.string().min(1).max(160),
  /** Evidence the reviewer says the ruling rests on. */
  evidenceIds: z.array(IdSchema).default([]),
  /** Sources the reviewer says the ruling rests on. */
  sourceIds: z.array(IdSchema).default([]),
  /**
   * The derived verdict as it stood when the ruling was made. Stored so a
   * later evidence change cannot silently make the ruling look like it was
   * made against material the reviewer never saw.
   */
  verdictStatusAtReview: ClaimVerdictStatusSchema,
  verdictConfidenceAtReview: z.number().min(0).max(1),
  createdAt: TimestampSchema
});

export type ClaimReview = z.infer<typeof ClaimReviewSchema>;

/** What a client may supply; identity, ids and time are server-derived. */
export const ClaimReviewDraftSchema = z.object({
  outcome: ClaimReviewOutcomeSchema,
  rationale: z.string().trim().min(10).max(4000),
  evidenceIds: z.array(z.string().uuid()).default([]),
  sourceIds: z.array(z.string().uuid()).default([]),
  /**
   * The derived verdict the reviewer was looking at. Required, and the server
   * refuses the ruling when it no longer matches: a stale page must not be able
   * to rule on a conclusion that has since changed.
   */
  expectedVerdictStatus: ClaimVerdictStatusSchema
});

export type ClaimReviewDraft = z.infer<typeof ClaimReviewDraftSchema>;

/** The most recent ruling wins; earlier ones stay in the history. */
export function latestReview<T extends { createdAt: string }>(
  reviews: readonly T[]
): T | null {
  let latest: T | null = null;
  for (const review of reviews) {
    if (!latest || review.createdAt > latest.createdAt) {
      latest = review;
    }
  }
  return latest;
}

export { reviewOutcomeLabel };
export type { ClaimReviewOutcome };
