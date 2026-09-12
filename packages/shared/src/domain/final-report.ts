import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const FinalReportSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  projectName: z.string().min(1),
  executiveSummary: z.string().min(1),
  initialConclusion: z.string().min(1),
  postChallengeConclusion: z.string().min(1),
  humanAction: z.string().min(1),
  finalConclusion: z.string().min(1),
  decisionExplanation: z.string().min(1),
  requiredNextActions: z.array(z.string().min(1)),
  decisiveChallengeIds: z.array(IdSchema),
  evidenceIds: z.array(IdSchema),
  humanDecisionId: IdSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type FinalReport = z.infer<typeof FinalReportSchema>;
