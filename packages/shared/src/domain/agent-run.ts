import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

export const AgentRunStatusSchema = z.enum(["running", "completed", "failed"]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

/**
 * What an agent run was for. Both purposes are recorded in the same
 * `agent_runs` table; the purpose lives inside the run's `input` payload, so
 * no extra column is needed to tell a cross-review run from an analysis run.
 */
export const AgentRunPurposeSchema = z.enum(["analysis", "cross_review"]);
export type AgentRunPurpose = z.infer<typeof AgentRunPurposeSchema>;

/**
 * A run record as surfaced to clients: enough to show that work really
 * happened, who did it, whether it succeeded, and — when it did not — why.
 */
export const AgentRunSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  roleId: IdSchema,
  promptVersionId: IdSchema,
  status: AgentRunStatusSchema,
  purpose: AgentRunPurposeSchema,
  /** Set for cross-review runs: the claim this run was aimed at. */
  targetClaimId: z
    .preprocess((value) => (value === null ? undefined : value), IdSchema.optional()),
  /** Set when the run failed: the reason, as reported by the runner. */
  error: z
    .preprocess(
      (value) => (value === null || value === "" ? undefined : value),
      z.string().optional()
    ),
  startedAt: TimestampSchema,
  completedAt: z
    .preprocess(
      (value) => (value === null ? undefined : value),
      TimestampSchema.optional()
    )
});

export type AgentRun = z.infer<typeof AgentRunSchema>;

export function agentRunStatusLabel(status: AgentRunStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "已失败";
  }
}

/** Runs that never reached an outcome and can therefore be retried. */
export function isRetryableRun(status: AgentRunStatus): boolean {
  return status === "failed";
}
