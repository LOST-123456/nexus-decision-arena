import { z } from "zod";
import type { ClaimVerdictStatus } from "./claim-verdict";

/**
 * A human ruling on a fact-check conclusion.
 *
 * Lives in its own module because both the persisted review record and the
 * derived verdict rules need it, and neither should depend on the other.
 *
 * This is deliberately not the conflict-level `human_decisions` action: that
 * one resolves a dispute between competing claims, this one rules on what can
 * be concluded about a single claim.
 */
export const ClaimReviewOutcomeSchema = z.enum([
  /** The reviewer accepts the derived conclusion, as bounded by its limits. */
  "confirmed",
  /** The reviewer judges the claim itself not to hold. */
  "rejected",
  /** The reviewer cannot conclude yet and asks for more evidence. */
  "needs_more_evidence"
]);

export type ClaimReviewOutcome = z.infer<typeof ClaimReviewOutcomeSchema>;

/**
 * Applies a human ruling to a derived verdict status.
 *
 * A `confirmed` ruling never upgrades the conclusion — it only asserts that
 * the reviewer accepts what the evidence already supports, so the derived
 * status (including any `inconclusive` or `insufficient_evidence`) stands.
 */
export function applyReviewToStatus(
  derived: ClaimVerdictStatus,
  outcome: ClaimReviewOutcome | null
): ClaimVerdictStatus {
  if (outcome === "rejected") {
    return "refuted";
  }
  if (outcome === "needs_more_evidence") {
    return "insufficient_evidence";
  }
  return derived;
}

export function reviewOutcomeLabel(outcome: ClaimReviewOutcome): string {
  switch (outcome) {
    case "confirmed":
      return "人工确认结论";
    case "rejected":
      return "人工否证主张";
    case "needs_more_evidence":
      return "要求补充证据";
  }
}
