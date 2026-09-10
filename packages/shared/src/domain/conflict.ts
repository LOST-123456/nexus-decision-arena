import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ConflictSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  claimIds: z.array(IdSchema).min(1),
  challengeIds: z.array(IdSchema),
  type: z.enum(["evidence", "logic", "assumption", "priority"]),
  summary: z.string().min(1),
  severity: z.number().int().min(1).max(5),
  status: z.enum(["detected", "human_review", "resolved"]),
  humanDecisionRequired: z.boolean(),
  resolutionSuggestion: z.string().min(1),
  impactScope: z.object({
    analysisAreas: z.array(
      z.enum(["market", "technology", "finance", "risk", "operations"])
    ),
    stakeholders: z.array(z.string())
  }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type Conflict = z.infer<typeof ConflictSchema>;
