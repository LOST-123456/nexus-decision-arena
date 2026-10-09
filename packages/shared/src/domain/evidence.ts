import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const EvidenceKindSchema = z.enum([
  "project_input",
  "calculation",
  "external_reference",
  "assumption"
]);

/**
 * Stance of the evidence towards the Claim(s) it is attached to.
 * `context` is background material: it neither supports nor opposes the claim
 * and must never be counted as support.
 */
export const EvidenceDirectionSchema = z.enum([
  "supports",
  "opposes",
  "context"
]);

export const EvidenceValidityPeriodSchema = z.object({
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional()
});

type EvidenceRules = {
  kind: EvidenceKind;
  sourceId?: string | undefined;
  sourceRef?: string | undefined;
  verificationStatus: "unverified" | "verified" | "rejected";
  verifiedBy?: string | undefined;
  verificationNote?: string | undefined;
};

/**
 * Cross-field rules. Kept as a named function so both the persisted schema and
 * the request schemas apply exactly the same gate.
 */
export function evidenceRules(value: EvidenceRules, context: z.RefinementCtx): void {
  // An external reference must be traceable to a source record or a url.
  if (value.kind === "external_reference" && !value.sourceId && !value.sourceRef) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceId"],
      message: "External references require a source record or a source url"
    });
  }

  if (value.kind === "assumption" && value.verificationStatus === "verified") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["verificationStatus"],
      message: "Assumptions cannot be verified"
    });
  }

  // A verdict on an excerpt is a human act: it needs a reviewer and a reason.
  // Model output must never land in a verified state on its own.
  if (value.verificationStatus !== "unverified") {
    if (!value.verifiedBy) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verifiedBy"],
        message: "Verification and rejection require a named reviewer"
      });
    }
    if (!value.verificationNote) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verificationNote"],
        message: "Verification and rejection require a recorded reason"
      });
    }
  }
}

/** Object schema without the cross-field rules, so callers can `.omit()` it. */
export const EvidenceObjectSchema = z
  .object({
    id: IdSchema,
    sessionId: IdSchema,
    /** Claims this evidence bears on. One excerpt can bear on several claims. */
    claimIds: z.array(IdSchema).min(1),
    kind: EvidenceKindSchema,
    title: z.string().min(1),
    /** Verbatim excerpt or the recorded content itself. */
    content: z.string().min(1),
    description: z.string().min(1),
    /** Provenance record this excerpt was taken from. */
    sourceId: z.preprocess(
      (value) => (value === null ? undefined : value),
      IdSchema.optional()
    ),
    sourceRef: z.preprocess(
      (value) => (value === null ? undefined : value),
      z.string().url().optional()
    ),
    /**
     * Where inside the source the excerpt sits (page, paragraph, timestamp,
     * sheet row ...). Without it a quote cannot be re-checked.
     */
    locator: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().max(240).optional()
    ),
    direction: EvidenceDirectionSchema,
    reliability: z.number().min(0).max(1),
    verificationStatus: z.enum(["unverified", "verified", "rejected"]),
    /** Who confirmed the excerpt matches the source, and when. */
    verifiedBy: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().max(120).optional()
    ),
    verifiedAt: z.preprocess(
      (value) => (value === null ? undefined : value),
      TimestampSchema.optional()
    ),
    /** Why it was accepted or rejected. Empty verification is not allowed. */
    verificationNote: z.preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().max(2000).optional()
    ),
    validityPeriod: z.preprocess(
      (value) => (value === null ? undefined : value),
      EvidenceValidityPeriodSchema.optional()
    ),
    retrievedAt: TimestampSchema,
    createdBy: z.enum(["system", "agent", "human"]),
    agentRunId: z.preprocess(
      (value) => (value === null ? undefined : value),
      IdSchema.optional()
    )
  });

export const EvidenceSchema = EvidenceObjectSchema.superRefine(evidenceRules);

export type Evidence = z.infer<typeof EvidenceSchema>;
export type EvidenceValidityPeriod = z.infer<
  typeof EvidenceValidityPeriodSchema
>;
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type EvidenceDirection = z.infer<typeof EvidenceDirectionSchema>;

export function evidenceCoversClaim(
  item: Pick<Evidence, "claimIds">,
  claimId: string
): boolean {
  return item.claimIds.includes(claimId);
}
