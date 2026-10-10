import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";
import { ClaimTypeSchema, type ClaimType } from "./claim";
import {
  EvidenceDirectionSchema,
  EvidenceLocatorKindSchema,
  EvidenceLocatorStatusSchema
} from "./evidence";

/**
 * Candidate Claim extraction — the model suggests, the researcher decides.
 *
 * Everything in this file is a **candidate**: a proposal that has not been
 * promoted into the domain yet. Candidates live in their own tables and are
 * therefore invisible to `deriveClaimVerdicts()`, `diagnoseEvidenceGaps()` and
 * the fact-check report. That separation is the point: a suggestion must never
 * move a verdict before a person has accepted it and then verified it through
 * the existing human workflow.
 *
 * The one thing a model may influence is the *text* of a suggestion. Identifiers,
 * locator states, permissions and every write are decided server-side.
 */

/** Status of one analysis task over one saved capture. */
export const ExtractionRunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed"
]);

/**
 * Why a run produced nothing.
 *
 * Every code here is something the UI has to be able to say out loud, because
 * "the analysis failed" without a reason would invite the researcher to assume
 * the model said "no claims found" — which is a completely different answer.
 */
export const ExtractionFailureCodeSchema = z.enum([
  /** No stored capture: nothing was ever saved to analyse. */
  "no_snapshot",
  /** A capture exists but holds no usable text. */
  "empty_content",
  /** The provider could not be reached, or has no credentials. */
  "provider_unavailable",
  /** The provider exceeded the generation budget. */
  "timeout",
  /** The client or the server cancelled the request. */
  "aborted",
  /** The provider declined to answer. */
  "refused",
  /** The provider answered with nothing usable in it. */
  "empty_output",
  /** The provider answered, but not with JSON this system can trust. */
  "invalid_json",
  /** The answer was JSON, but not shaped like the agreed schema. */
  "schema_rejected",
  /** The candidates could not be stored. */
  "storage_unavailable"
]);

/**
 * A candidate's own taxonomy. It is deliberately richer than `ClaimTypeSchema`
 * because splitting a compound sentence is the whole job: "we expect revenue to
 * double because demand recovered" is a prediction plus a causal claim, and
 * flattening either one loses the part a reviewer would want to attack.
 */
export const CandidateClaimTypeSchema = z.enum([
  "fact",
  "causal",
  "prediction",
  "opinion"
]);

export const CandidateStatusSchema = z.enum([
  "proposed",
  "accepted",
  "rejected"
]);

export const ClaimCandidateSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  sourceId: IdSchema,
  snapshotId: IdSchema,
  /** Which piece of the capture this came from, so every suggestion is traceable. */
  segmentIndex: z.number().int().nonnegative(),
  /** The atomic statement, kept with its qualifiers and negations intact. */
  statement: z.string().min(1).max(4000),
  type: CandidateClaimTypeSchema,
  /** Surrounding text kept for a static reason: a statement alone often misleads. */
  context: z.string().max(4000).optional(),
  /**
   * Conditions, scopes and exceptions attached to the statement ("in Europe",
   * "as of 2025", "except for hardware"). Splitting a claim without its
   * qualifiers turns a narrow truth into a false broad one.
   */
  qualifiers: z.array(z.string().min(1).max(600)),
  /** What the model could not tell, stated by the model rather than hidden. */
  uncertainty: z.array(z.string().min(1).max(600)),
  /** Why this reading was proposed. Required, so nothing arrives unexplained. */
  rationale: z.string().min(1).max(2000),
  suggestedImportance: z.number().int().min(1).max(5),
  status: CandidateStatusSchema,
  /** Set only after acceptance, pointing at the real claim it produced. */
  createdClaimId: IdSchema.optional(),
  rejectReason: z.string().max(600).optional(),
  decidedBy: z.string().max(160).optional(),
  decidedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export const EvidenceCandidateSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  sourceId: IdSchema,
  snapshotId: IdSchema,
  segmentIndex: z.number().int().nonnegative(),
  /** The candidate claim this excerpt was proposed against. */
  claimCandidateId: IdSchema,
  /** Verbatim excerpt taken from the capture. */
  excerpt: z.string().min(1).max(4000),
  title: z.string().min(1).max(240),
  direction: EvidenceDirectionSchema,
  locatorKind: EvidenceLocatorKindSchema,
  /**
   * Whether this excerpt was really found in the capture. Computed by the
   * server against the stored text — never taken from the model, so a made-up
   * quotation cannot arrive labelled as a match.
   */
  locatorStatus: EvidenceLocatorStatusSchema,
  locator: z.string().max(240).optional(),
  anchorText: z.string().max(4000).optional(),
  sourceContentHash: z.string().max(128).optional(),
  suggestedReliability: z.number().min(0).max(1),
  rationale: z.string().min(1).max(2000),
  uncertainty: z.array(z.string().min(1).max(600)),
  status: CandidateStatusSchema,
  /** Set only after acceptance, pointing at the real evidence row it produced. */
  createdEvidenceId: IdSchema.optional(),
  rejectReason: z.string().max(600).optional(),
  decidedBy: z.string().max(160).optional(),
  decidedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export const ClaimExtractionRunSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  sourceId: IdSchema,
  snapshotId: IdSchema,
  status: ExtractionRunStatusSchema,
  failureCode: ExtractionFailureCodeSchema.optional(),
  failureMessage: z.string().max(2000).optional(),
  /** Which model was actually asked, so a mock result can never be passed off as a real one. */
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(160),
  /**
   * Fingerprint of the analysis input (capture content + prompt + limits).
   * Two runs with the same hash are the same question, which is what makes a
   * repeated click return the previous answer instead of writing a second copy.
   */
  inputHash: z.string().min(1).max(128),
  promptVersion: z.string().min(1).max(40),
  segmentationVersion: z.string().min(1).max(40),
  charCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  candidateClaimCount: z.number().int().nonnegative(),
  candidateEvidenceCount: z.number().int().nonnegative(),
  /** How many proposed excerpts really resolved inside the capture. */
  anchorMatched: z.number().int().nonnegative(),
  /** How many did not, and are therefore shown as unlocatable. */
  anchorMissing: z.number().int().nonnegative(),
  /** How many model calls were needed; >1 means it had to be retried. */
  attempt: z.number().int().positive(),
  correlationId: IdSchema,
  createdBy: z.string().min(1).max(160),
  startedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

/** A researcher's ruling on one candidate. */
export const CandidateDecisionSchema = z
  .object({
    candidateId: IdSchema,
    kind: z.enum(["claim", "evidence"]),
    status: z.enum(["accepted", "rejected"]),
    /** Required for `claim` candidates: the row acceptance actually produced. */
    createdClaimId: IdSchema.optional(),
    /** Required for `evidence` candidates: the row acceptance actually produced. */
    createdEvidenceId: IdSchema.optional(),
    rejectReason: z.string().min(1).max(600).optional()
  })
  .superRefine((value, ctx) => {
    if (value.status === "accepted") {
      const produced =
        value.kind === "claim" ? value.createdClaimId : value.createdEvidenceId;
      if (!produced) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [value.kind === "claim" ? "createdClaimId" : "createdEvidenceId"],
          message:
            "Accepting a candidate requires the id of the record it produced"
        });
      }
    }
  });

export const ClaimExtractionResultSchema = z.object({
  run: ClaimExtractionRunSchema,
  claimCandidates: z.array(ClaimCandidateSchema),
  evidenceCandidates: z.array(EvidenceCandidateSchema),
  /** True when this request reused an earlier identical analysis. */
  reused: z.boolean()
});

export type ExtractionRunStatus = z.infer<typeof ExtractionRunStatusSchema>;
export type ExtractionFailureCode = z.infer<typeof ExtractionFailureCodeSchema>;
export type CandidateClaimType = z.infer<typeof CandidateClaimTypeSchema>;
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;
export type ClaimCandidate = z.infer<typeof ClaimCandidateSchema>;
export type EvidenceCandidate = z.infer<typeof EvidenceCandidateSchema>;
export type ClaimExtractionRun = z.infer<typeof ClaimExtractionRunSchema>;
export type CandidateDecision = z.infer<typeof CandidateDecisionSchema>;
export type ClaimExtractionResult = z.infer<typeof ClaimExtractionResultSchema>;

/**
 * Maps a candidate's taxonomy onto the formal claim type.
 *
 * A causal statement ("X caused Y") and an opinion ("we think X is best") are
 * kept apart while they are candidates, because they need different evidence;
 * once promoted they land on the claim types the rest of the system knows how
 * to score. An opinion becomes an assumption rather than a fact — narrowing the
 * taxonomy here must never inflate a suggestion into a stronger claim.
 */
export function candidateClaimTypeToClaimType(
  type: CandidateClaimType
): ClaimType {
  switch (type) {
    case "fact":
    case "causal":
      return "fact";
    case "prediction":
      return "prediction";
    case "opinion":
      return "assumption";
    default: {
      const exhaustive: never = type;
      throw new Error(`Unsupported candidate claim type: ${String(exhaustive)}`);
    }
  }
}

export const CANDIDATE_CLAIM_TYPE_LABELS: Record<CandidateClaimType, string> = {
  fact: "事实主张",
  causal: "因果关系",
  prediction: "预测",
  opinion: "观点/判断"
};
