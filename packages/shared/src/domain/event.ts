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
  "EVIDENCE_RECORDED",
  "EVIDENCE_VERIFICATION_CHANGED",
  "CLAIM_REVIEW_RECORDED",
  "SOURCE_REGISTERED",
  "SOURCE_RETRIEVED",
  "SOURCE_RETRIEVAL_FAILED",
  "SOURCE_EXCERPTS_RECHECKED",
  "CLAIM_EXTRACTION_STARTED",
  "CLAIM_EXTRACTION_COMPLETED",
  "CLAIM_EXTRACTION_FAILED",
  "CLAIM_CANDIDATES_DECIDED",
  "CITATION_INTEGRITY_CHECKED",
  "SUPPORT_ASSESSMENT_RECORDED",
  "CITATION_CORRECTION_RECORDED",
  "SOURCE_RELATION_RECORDED",
  "SOURCE_PROFILE_OVERRIDDEN",
  "RESEARCH_PLAN_ITEM_ADDED",
  "RESEARCH_PLAN_QUERY_EDITED",
  "RESEARCH_PLAN_SEARCH_STARTED",
  "RESEARCH_PLAN_SEARCH_FAILED",
  "RESEARCH_PLAN_OUTCOME_RECORDED",
  "RESEARCH_PLAN_ITEM_CLOSED",
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
