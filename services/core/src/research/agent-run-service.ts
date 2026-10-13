import {
  isRetryableRun,
  type AgentRunDetail,
  type AgentRunView
} from "@nexus/shared";
import type { ArenaRepository, EventRepository, ReviewRepository } from "@nexus/db";
import type { CrossReviewResult, CrossReviewService } from "./cross-review-service";

/** Hard ceiling on retry attempts per run. The run being retried has its own
 * `attempt`, and a retry opens `attempt + 1`; we stop once it would exceed this. */
export const MAX_AGENT_RUN_RETRIES = 3;

export class AgentRunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Agent run not found in this session: ${runId}`);
    this.name = "AgentRunNotFoundError";
  }
}

/** Cancel was asked of a run that has already ended (and is not cancelled). */
export class AgentRunTerminalError extends Error {
  constructor(readonly status: string) {
    super(`该运行已处于终态（${status}），无法取消。`);
    this.name = "AgentRunTerminalError";
  }
}

/** Retry was asked of a run that is not in a retryable state. */
export class AgentRunNotRetryableError extends Error {
  constructor(readonly status: string) {
    super(`该运行（${status}）不可重试。`);
    this.name = "AgentRunNotRetryableError";
  }
}

/** Retry is not wired for this run's purpose (only cross_review today). */
export class AgentRunRetryUnsupportedError extends Error {
  constructor(readonly purpose: string) {
    super(`暂不支持重试该类型（${purpose}）的运行。`);
    this.name = "AgentRunRetryUnsupportedError";
  }
}

/** The retry ceiling has been reached for this run. */
export class AgentRunRetryLimitError extends Error {
  constructor(readonly attempt: number, readonly limit: number) {
    super(`已达重试上限（最多 ${limit} 次尝试），无法再次重试。`);
    this.name = "AgentRunRetryLimitError";
  }
}

export type AgentRunServiceDependencies = {
  reviews: Pick<
    ReviewRepository,
    | "getAgentRunById"
    | "listAgentRunsDetailed"
    | "listAgentRunEvents"
    | "cancelAgentRun"
    | "setRunRetryMeta"
  >;
  arena: Pick<ArenaRepository, "getSessionArtifacts">;
  /** Append-only execution log; used to record who cancelled a run. */
  events: Pick<EventRepository, "append">;
  /** Only needed for retry; absent when cross-review is not configured. */
  crossReview?: Pick<CrossReviewService, "runForClaim">;
};

/**
 * Surfaces the single `agent_runs` table as an operations center: list, detail
 * (with the same execution-event timeline the rest of the app uses), safe
 * cancel, and safe retry of cross-review runs.
 *
 * This service owns no run system of its own. It reads and mutates rows in the
 * one `agent_runs` table; it never creates a parallel ledger, and it never
 * writes evidence or human rulings on a run's behalf (retry re-runs the same
 * agent work, which produces challenges and response claims — not citations or
 * verdicts).
 */
export class AgentRunService {
  constructor(private readonly dependencies: AgentRunServiceDependencies) {}

  async listRuns(sessionId: string): Promise<AgentRunView[]> {
    return this.dependencies.reviews.listAgentRunsDetailed(sessionId);
  }

  async getRunDetail(
    sessionId: string,
    runId: string
  ): Promise<AgentRunDetail> {
    const run = await this.dependencies.reviews.getAgentRunById(
      sessionId,
      runId
    );
    if (!run) {
      throw new AgentRunNotFoundError(runId);
    }
    const events = await this.dependencies.reviews.listAgentRunEvents(
      sessionId,
      runId
    );

    // Link the run to the work it produced. A cross-review run owns challenges
    // (by `challengerRunId`) and response claims (by `agentRunId`); conflicts
    // are reached through the challenges it created. Evidence and human rulings
    // are never produced by a run, so they are not linked here — linking them
    // would falsely imply a run can change a verdict.
    const artifacts = await this.dependencies.arena.getSessionArtifacts(
      sessionId
    );
    const challengeIds = (artifacts?.challenges ?? [])
      .filter((challenge) => challenge.challengerRunId === runId)
      .map((challenge) => challenge.id);
    const responseClaimIds = (artifacts?.claims ?? [])
      .filter((claim) => claim.agentRunId === runId)
      .map((claim) => claim.id);
    const conflictIds = (artifacts?.conflicts ?? [])
      .filter((conflict) =>
        conflict.challengeIds.some((id) => challengeIds.includes(id))
      )
      .map((conflict) => conflict.id);

    return {
      ...run,
      events,
      outcome: { challengeIds, conflictIds, responseClaimIds }
    };
  }

  /**
   * Safe cancel. Returns the resulting run; `alreadyCancelled` is true when the
   * run was already cancelled (idempotent — the same answer comes back). A run
   * in any other terminal state cannot be cancelled.
   *
   * The only failure category this writes is `cancelled_by_user`, and the
   * repository guard guarantees a cancelled run has no results committed: the
   * executor (cross-review) only writes output on completion or failure, never
   * after a cancel, so a cancelled run is provably result-free.
   */
  async cancelRun(
    sessionId: string,
    runId: string,
    actor: string | null
  ): Promise<{ run: AgentRunView; alreadyCancelled: boolean }> {
    const run = await this.dependencies.reviews.getAgentRunById(
      sessionId,
      runId
    );
    if (!run) {
      throw new AgentRunNotFoundError(runId);
    }
    const cancelled = await this.dependencies.reviews.cancelAgentRun(
      sessionId,
      runId
    );
    if (cancelled) {
      await this.dependencies.events.append({
        sessionId,
        correlationId: runId,
        type: "AGENT_RUN_CANCELLED",
        payload: { agentRunId: runId, requestedBy: actor ?? "unattributed" }
      });
      return { run: cancelled, alreadyCancelled: false };
    }
    const existing = await this.dependencies.reviews.getAgentRunById(
      sessionId,
      runId
    );
    if (!existing) {
      throw new AgentRunNotFoundError(runId);
    }
    if (existing.status === "cancelled") {
      return { run: existing, alreadyCancelled: true };
    }
    throw new AgentRunTerminalError(existing.status);
  }

  /**
   * Safe retry of a cross-review run. Opens a *new* run (new id, higher
   * attempt, `parentRunId` pointing back), re-using the same claim target and
   * the same cross-examination engine. The original run is left untouched; the
   * new attempt's parent is recorded so the timeline reads as a retry chain.
   *
   * Concurrency is guarded by `CrossReviewService` itself (it refuses to start a
   * second run for a claim that already has one in progress), and the route
   * wraps this in an idempotency lease so a double-submit replays one retry.
   */
  async retryRun(
    sessionId: string,
    runId: string,
    actor: string
  ): Promise<CrossReviewResult> {
    const run = await this.dependencies.reviews.getAgentRunById(
      sessionId,
      runId
    );
    if (!run) {
      throw new AgentRunNotFoundError(runId);
    }
    if (!isRetryableRun(run.status)) {
      throw new AgentRunNotRetryableError(run.status);
    }
    if (run.purpose !== "cross_review") {
      throw new AgentRunRetryUnsupportedError(run.purpose);
    }
    if (!run.targetClaimId) {
      throw new AgentRunNotRetryableError("missing target claim");
    }
    if (!this.dependencies.crossReview) {
      throw new AgentRunRetryUnsupportedError("crossReview unavailable");
    }
    if ((run.attempt ?? 1) >= MAX_AGENT_RUN_RETRIES) {
      throw new AgentRunRetryLimitError(run.attempt ?? 1, MAX_AGENT_RUN_RETRIES);
    }

    const result = await this.dependencies.crossReview.runForClaim({
      sessionId,
      claimId: run.targetClaimId,
      actor
    });

    const attempt = (run.attempt ?? 1) + 1;
    for (const outcome of result.runs) {
      await this.dependencies.reviews.setRunRetryMeta(outcome.run.id, {
        attempt,
        parentRunId: runId
      });
    }
    return result;
  }
}
