import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ExecutionEventTypeSchema = z.enum([
  "SESSION_STATE_CHANGED",
  "AGENT_RUN_STARTED",
  "AGENT_RUN_COMPLETED",
  "CLAIM_CREATED",
  "CHALLENGE_CREATED",
  "CHALLENGE_RESOLVED",
  "CONFLICT_DETECTED",
  "HUMAN_REVIEW_REQUIRED",
  "AGENT_RUN_FAILED",
  "CHALLENGE_FAILED",
  "SESSION_COMPLETED"
]);

export const ExecutionEventSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  sequence: z.number().int().positive(),
  correlationId: IdSchema,
  traceId: z.string().min(1).optional(),
  type: ExecutionEventTypeSchema,
  payload: z.unknown(),
  occurredAt: TimestampSchema,
  promptVersionId: IdSchema.optional()
});

export type ExecutionEvent = z.infer<typeof ExecutionEventSchema>;
