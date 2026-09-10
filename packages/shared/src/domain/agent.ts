import { z } from "zod";
import { IdSchema } from "../ids";

export const AgentRoleKeySchema = z.enum([
  "market_analyst",
  "technical_expert",
  "finance_analyst",
  "risk_auditor",
  "review_moderator"
]);

export const AgentRoleSchema = z.object({
  id: IdSchema,
  key: AgentRoleKeySchema,
  name: z.string().min(1),
  goal: z.string().min(1),
  perspective: z.string().min(1),
  evaluationCriteria: z.array(z.string().min(1)).min(1),
  evidenceRequired: z.array(z.string().min(1)).min(1),
  conflictPreference: z.array(z.string().min(1)).min(1),
  lenses: z.array(z.string().min(1)).min(1),
  promptVersionId: IdSchema
});

export type AgentRoleKey = z.infer<typeof AgentRoleKeySchema>;
export type AgentRole = z.infer<typeof AgentRoleSchema>;
