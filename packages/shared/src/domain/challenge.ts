import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ChallengeSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  targetClaimId: IdSchema,
  challengerRunId: IdSchema,
  challengerRoleId: IdSchema,
  type: z.enum([
    "evidence_gap",
    "logic_flaw",
    "contradiction",
    "feasibility",
    "priority"
  ]),
  question: z.string().min(1),
  context: z.object({
    triggerClaimIds: z.array(IdSchema),
    explanation: z.string().min(1)
  }),
  requiredEvidence: z.array(z.string().min(1)).min(1),
  severity: z.number().int().min(1).max(5),
  resolutionStrategy: z.enum([
    "provide_evidence",
    "revise_claim",
    "withdraw_claim",
    "human_decision"
  ]),
  status: z.enum([
    "open",
    "answered",
    "validating",
    "resolved",
    "unresolved"
  ]),
  responseClaimId: z.preprocess(
    (value) => (value === null ? undefined : value),
    IdSchema.optional()
  ),
  correlationId: IdSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type Challenge = z.infer<typeof ChallengeSchema>;
