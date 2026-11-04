import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const ExecutionEventTypeSchema = z.enum([
  "SESSION_STATE_CHANGED",
  "AGENT_RUN_STARTED",
  "AGENT_RUN_COMPLETED",
  "CLAIM_CREATED",
  "CHALLENGE_CREATED",
  "CHALLENGE_RESOLVED",
  /**
   * 一轮质询开始了，附上这一轮要做多少条。
   *
   * 为什么要单独一条事件：质询是整轮里唯一按"主张 × 质询者"逐条跑模型的
   * 环节，条数越多越久。页面拿不到总数就只能显示一个越走越大的计时器，
   * 分不清"在推进"和"卡住了"。有这条之后，`CHALLENGE_CREATED` 的累计数
   * 除以 total 就是进度，不需要再猜。
   */
  "CHALLENGE_BATCH_STARTED",
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
  /**
   * A retry was asked for on this run. Filed under the run being retried, so
   * the request is visible even when creating the replacement run fails —
   * a request that produced nothing is still a fact worth keeping.
   */
  "AGENT_RUN_RETRY_REQUESTED",
  /**
   * The replacement run(s) exist in `agent_runs`, with their `attempt` and
   * `parent_run_id` already written. This says the lineage is durable; it does
   * not say the executor has started, which is `AGENT_RUN_STARTED`.
   */
  "AGENT_RUN_RETRY_CREATED",
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
  /**
   * 人工补充的一份材料（访谈记录、报价单、试点数据）。
   *
   * 为什么是事件而不是新表：材料必须和时间线、裁决、质询落在同一条不可变
   * 序列上。一条材料在"第几轮之前交的"决定它能不能回答那一轮的质询，把这种
   * 先后关系存在事件流里，重放时天然成立；存成可更新的行则要在每次重放时
   * 重建先后关系，迟早会错。
   */
  "MATERIAL_ADDED",
  /**
   * 一次外部检索查到的候选来源。
   *
   * 它必须落库，而不是只活在这一次提示词里：审计包要能回答"当时到底是看了
   * 哪几条才问出这个问题"，否则检索就是一段无法追溯的暗箱。注意它是**候选**，
   * 不是证据——`verificationStatus` 仍然是 unverified。
   */
  "WEB_SOURCES_FOUND",
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
