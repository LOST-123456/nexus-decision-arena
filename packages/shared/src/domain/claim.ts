import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ClaimTypeSchema = z.enum([
  "fact",
  "assumption",
  "prediction",
  "recommendation"
]);
export const ClaimStanceSchema = z.enum(["support", "oppose", "neutral"]);
export const ClaimStatusSchema = z.enum([
  "proposed",
  "supported",
  "contested",
  "accepted",
  "rejected"
]);
export const ClaimRelationSchema = z.object({
  targetClaimId: IdSchema,
  type: z.enum(["supports", "contradicts", "qualifies", "depends_on"])
});

export const ClaimSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  agentRunId: IdSchema,
  roleId: IdSchema,
  lens: z.string().min(1),
  statement: z.string().min(1),
  type: ClaimTypeSchema,
  stance: ClaimStanceSchema,
  importance: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(IdSchema),
  status: ClaimStatusSchema,
  rootClaimId: IdSchema,
  revisionOfClaimId: IdSchema.optional(),
  revision: z.number().int().positive(),
  relations: z.array(ClaimRelationSchema),
  respondsToChallengeId: IdSchema.optional(),
  disposition: z
    .enum(["accept", "reject", "qualify", "insufficient_evidence"])
    .optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type Claim = z.infer<typeof ClaimSchema>;
export type ClaimType = z.infer<typeof ClaimTypeSchema>;
