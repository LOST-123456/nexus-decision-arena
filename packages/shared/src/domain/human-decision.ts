import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const HumanDecisionSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  conflictId: IdSchema,
  action: z.enum([
    "accept_challenge",
    "uphold_claim",
    "request_more_analysis"
  ]),
  rationale: z.string().min(1),
  affectedClaimIds: z.array(IdSchema),
  affectedAgentRoleIds: z.array(IdSchema),
  previousConclusion: z.string().min(1),
  newConclusion: z.string().min(1),
  operatorId: z.string().min(1),
  createdAt: TimestampSchema
});

export type HumanDecision = z.infer<typeof HumanDecisionSchema>;
