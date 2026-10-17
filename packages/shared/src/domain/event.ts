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
  "SOURCE_CHECK_STARTED",
  "SOURCE_CHECK_COMPLETED",
  "SOURCE_CONTENT_CHANGED",
  "SOURCE_CHECK_FAILED",
  "REVALIDATION_TASK_CREATED",
  "REVALIDATION_TASK_RESOLVED",
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
  "SEARCH_TASK_CREATED",
  "SEARCH_COMPLETED",
  "SEARCH_FAILED",
  "SOURCE_CANDIDATE_FOUND",
  "REPORT_SNAPSHOT_CREATED",
  "TRANSLATION_RECORDED",
  "TRANSLATION_REVIEWED",
  "TERMINOLOGY_RECORDED",
  "SOURCE_LIBRARY_GRANTED",
  "SOURCE_LIBRARY_REVOKED",
  "SOURCE_COPIED_TO_RESEARCH",
  "HUMAN_REVIEW_REQUIRED",
  "AGENT_RUN_FAILED",
  "AGENT_RUN_CANCELLED",
  /**
   * Cancel was accepted, authenticated and written to `agent_runs`. It says
   * nothing about the executor: the run row can read `cancelled` while the
   * process that was doing the work has not stopped yet. `AGENT_RUN_CANCELLED`
   * is the durable verdict; this event is the request that produced it.
   */
  "AGENT_RUN_CANCEL_REQUESTED",
  /**
   * The executor itself reports that it stopped. Absent when the work was
   * running in another process (or the provider ignored the signal), which is
   * exactly the distinction a reader needs to judge the cancellation.
   */
  "AGENT_RUN_EXECUTION_STOPPED",
  "CHALLENGE_FAILED",
  "SESSION_COMPLETED",
  "MEMBER_INVITED",
  "MEMBER_JOINED",
  "MEMBER_DECLINED",
  "MEMBER_ROLE_CHANGED",
  "MEMBER_REMOVED",
  "WORK_ITEM_CREATED",
  "WORK_ITEM_UPDATED",
  "WORK_ITEM_COMPLETED",
  "COMMENT_CREATED",
  "COMMENT_DELETED",
  "REVIEW_REQUEST_CREATED",
  "REVIEW_REQUEST_ASSIGNED",
  "REVIEW_REQUEST_DECIDED",
  "REVIEW_REQUEST_CANCELLED"
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
