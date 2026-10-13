import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

/**
 * The Agent Operations Center reuses the single `agent_runs` table. The state
 * machine is wider than the two outcomes cross-review writes today, because the
 * center must also speak about runs that were queued, cancelled, or timed out.
 */
export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out"
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

/**
 * What an agent run was for. Both purposes are recorded in the same
 * `agent_runs` table; the purpose lives inside the run's `input` payload, so
 * no extra column is needed to tell a cross-review run from an analysis run.
 */
export const AgentRunPurposeSchema = z.enum(["analysis", "cross_review"]);
export type AgentRunPurpose = z.infer<typeof AgentRunPurposeSchema>;

/**
 * A closed set of *why this run did not finish successfully* codes. The center
 * never invents a category: when the executor did not record one, the code is
 * `undefined` and the UI shows the raw message rather than guessing.
 */
export const AgentRunFailureCodeSchema = z.enum([
  "provider_timeout",
  "provider_unavailable",
  "provider_rate_limited",
  "invalid_model_output",
  "schema_validation_failed",
  "persistence_failed",
  "cancelled_by_user",
  "internal_error"
]);
export type AgentRunFailureCode = z.infer<typeof AgentRunFailureCodeSchema>;

/**
 * Real token accounting, when the executor reported it. `null` means the
 * executor did not provide any usage, and the center shows "未提供" — it never
 * fabricates a number.
 */
export const AgentRunTokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative()
});
export type AgentRunTokenUsage = z.infer<typeof AgentRunTokenUsageSchema>;

/**
 * A run record as surfaced to clients: enough to show that work really
 * happened, who did it, whether it succeeded, and — when it did not — why.
 *
 * Every field beyond the original three (status / purpose / error) is optional
 * because older runs were written before these columns existed. The API never
 * assumes they are present.
 */
export const AgentRunSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  roleId: IdSchema,
  promptVersionId: IdSchema,
  status: AgentRunStatusSchema,
  purpose: AgentRunPurposeSchema,
  /** A free-form task type; `purpose` is the coarse bucket, this is the fine one. */
  taskType: z.string().optional(),
  /** Set for cross-review runs: the claim this run was aimed at. */
  targetClaimId: z.preprocess(
    (value) => (value === null ? undefined : value),
    IdSchema.optional()
  ),
  /** Set when the run failed: the raw reason, as reported by the runner. */
  error: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().optional()
  ),
  /** A closed category for `error`, when the executor recorded one. */
  errorCode: AgentRunFailureCodeSchema.optional(),
  /** Model provider, when the run recorded it (e.g. `openai-compatible`). */
  provider: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().optional()
  ),
  /** Model name, when the run recorded it. */
  model: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().optional()
  ),
  /** 1-based attempt index; retries open a new run with a higher attempt. */
  attempt: z.number().int().positive().optional(),
  /** For a retry: the run this one was re-attempted from. */
  parentRunId: z.preprocess(
    (value) => (value === null ? undefined : value),
    IdSchema.optional()
  ),
  /** Real token accounting, or `null` when the executor did not provide it. */
  tokenUsage: AgentRunTokenUsageSchema.nullable().optional(),
  createdAt: z.preprocess(
    (value) => (value === null ? undefined : value),
    TimestampSchema.optional()
  ),
  startedAt: TimestampSchema.optional(),
  completedAt: z.preprocess(
    (value) => (value === null ? undefined : value),
    TimestampSchema.optional()
  ),
  /** Wall-clock duration in milliseconds, when the run finished. */
  durationMs: z.preprocess(
    (value) => (value === null ? undefined : value),
    z.number().int().nonnegative().optional()
  )
});

export type AgentRun = z.infer<typeof AgentRunSchema>;

/** The operations-center view adds the role name so the UI need not join. */
export const AgentRunViewSchema = AgentRunSchema.extend({
  roleName: z.string()
});
export type AgentRunView = z.infer<typeof AgentRunViewSchema>;

/**
 * A single step in a run's life, read from the session's execution event log.
 * The center shows the same events the rest of the app records — it does not
 * mint a second timeline.
 */
export const AgentRunEventSchema = z.object({
  sequence: z.number().int(),
  type: z.string(),
  occurredAt: TimestampSchema,
  payload: z.unknown()
});
export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;

/** What a run produced, used to link a run to the claims/challenges it touched. */
export const AgentRunOutcomeSchema = z.object({
  challengeIds: z.array(IdSchema),
  conflictIds: z.array(IdSchema),
  responseClaimIds: z.array(IdSchema)
});
export type AgentRunOutcome = z.infer<typeof AgentRunOutcomeSchema>;

export const AgentRunDetailSchema = AgentRunViewSchema.extend({
  events: z.array(AgentRunEventSchema),
  outcome: AgentRunOutcomeSchema
});
export type AgentRunDetail = z.infer<typeof AgentRunDetailSchema>;

export function agentRunStatusLabel(status: AgentRunStatus): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "已失败";
    case "cancelled":
      return "已取消";
    case "timed_out":
      return "已超时";
  }
}

export function agentRunFailureCodeLabel(code: AgentRunFailureCode): string {
  switch (code) {
    case "provider_timeout":
      return "模型超时";
    case "provider_unavailable":
      return "模型服务不可用";
    case "provider_rate_limited":
      return "触发限流";
    case "invalid_model_output":
      return "模型输出不合法";
    case "schema_validation_failed":
      return "结果校验失败";
    case "persistence_failed":
      return "落库失败";
    case "cancelled_by_user":
      return "用户取消";
    case "internal_error":
      return "内部错误";
  }
}

/** Runs that never reached an outcome the user can act on by retrying. */
export function isRetryableRun(status: AgentRunStatus): boolean {
  return status === "failed" || status === "timed_out";
}

/** Runs that have reached a permanent end and cannot be cancelled. */
export function isTerminalRun(status: AgentRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timed_out"
  );
}

/** Runs that may still be stopped by a user. */
export function canCancelRun(status: AgentRunStatus): boolean {
  return status === "queued" || status === "running";
}
