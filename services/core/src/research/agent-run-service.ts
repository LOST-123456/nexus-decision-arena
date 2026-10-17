import {
  canCancelRun,
  isRetryableRun,
  type AgentRunDetail,
  type AgentRunView
} from "@nexus/shared";
import type { ArenaRepository, EventRepository, ReviewRepository } from "@nexus/db";
import type { CrossReviewResult, CrossReviewService } from "./cross-review-service";
import type { RunCancellationRegistry } from "./run-cancellation";

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

/**
 * What a cancel request actually achieved, which is deliberately not one fact
 * but three:
 *
 * - the `agent_runs` row moved to `cancelled` (`statusChanged`),
 * - the request is on the record with who asked, when, and why,
 * - and the executor was — or was not — told to stop (`execution`).
 *
 * `execution: "signal_delivered"` means a live executor *in this process* was
 * aborted. It does not mean the executor has stopped: that is
 * `AGENT_RUN_EXECUTION_STOPPED`, written by the executor itself. Nor does
 * `"not_running_here"` mean the run is dangerous — the write guard in the
 * arena repository refuses new results for a cancelled run regardless of which
 * process is holding the work.
 */
export type AgentRunCancellation = {
  run: AgentRunView;
  /** The run was already cancelled; this call changed nothing and logged nothing. */
  alreadyCancelled: boolean;
  /** The row moved from `queued`/`running` to `cancelled` because of this call. */
  statusChanged: boolean;
  /** What this process could do about the work in flight. */
  execution: "signal_delivered" | "not_running_here";
  /**
   * The status the row had when the cancel was accepted. `queued` means there
   * was never an executor to stop, which is a materially different story from
   * "a running executor we could not reach".
   */
  previousStatus: AgentRunView["status"];
  /** The operator's reason, echoed back — only ever as the caller recorded it. */
  reason: string | null;
};

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
  /**
   * Where the runs this process is executing register their abort signals.
   * Optional on purpose: with no registry every cancel still takes effect
   * durably, it just cannot interrupt a provider call early — the honest
   * answer in that case is `not_running_here`.
   */
  cancellations?: Pick<RunCancellationRegistry, "cancel">;
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
 *
 * Cancel writes one row, two events and, when the work happens to be running
 * here, one abort. It cannot promise the execution stopped, so it does not: see
 * `AgentRunCancellation`.
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
   * Safe cancel, in three verifiable steps: move the row, record who asked and
   * why, then try to interrupt the work.
   *
   * The order is not cosmetic. Moving the row first makes every later write by
   * that run fail its row-locked guard, so the outcome is already safe before
   * anything else happens. Recording the request second means the trail
   * explains the `cancelled` row even if this process dies before it reaches
   * the executor. The registry lookup comes last because it is the only
   * best-effort part: it knows about runs *this* process is executing, and a
   * second instance has an empty registry. That is why the answer says
   * `signal_delivered` or `not_running_here` rather than claiming the execution
   * stopped — the executor is the only party that can say that, and it says it
   * with `AGENT_RUN_EXECUTION_STOPPED`.
   *
   * Idempotent by state, not by luck: a run that is already cancelled is
   * answered again without logging a second request, so a double-click or a
   * retried POST cannot produce duplicate events. Any other terminal state is
   * refused — it can no longer be stopped.
   */
  async cancelRun(
    sessionId: string,
    runId: string,
    actor: string | null,
    options: { reason?: string | null } = {}
  ): Promise<AgentRunCancellation> {
    const run = await this.dependencies.reviews.getAgentRunById(
      sessionId,
      runId
    );
    if (!run) {
      throw new AgentRunNotFoundError(runId);
    }
    if (run.status === "cancelled") {
      // Repeat request for a run that is already cancelled: same answer, no
      // new event. The first request owns the trail.
      return {
        run,
        alreadyCancelled: true,
        statusChanged: false,
        execution: "not_running_here",
        previousStatus: "cancelled",
        reason: null
      };
    }
    if (!canCancelRun(run.status)) {
      throw new AgentRunTerminalError(run.status);
    }

    const cancelled = await this.dependencies.reviews.cancelAgentRun(
      sessionId,
      runId
    );
    if (!cancelled) {
      // Lost the race: a concurrent cancel, or a completion, committed first.
      const existing = await this.dependencies.reviews.getAgentRunById(
        sessionId,
        runId
      );
      if (!existing) {
        throw new AgentRunNotFoundError(runId);
      }
      if (existing.status === "cancelled") {
        // The other cancel won and logged the trail; this call adds nothing.
        return {
          run: existing,
          alreadyCancelled: true,
          statusChanged: false,
          execution: "not_running_here",
          previousStatus: "cancelled",
          reason: null
        };
      }
      throw new AgentRunTerminalError(existing.status);
    }

    const requestedBy = actor ?? "unattributed";
    const reason = normaliseReason(options.reason);
    const previousStatus = run.status;
    const requestedAt = new Date().toISOString();

    await this.dependencies.events.append({
      sessionId,
      correlationId: runId,
      type: "AGENT_RUN_CANCEL_REQUESTED",
      payload: {
        agentRunId: runId,
        requestedBy,
        reason,
        requestedAt,
        previousStatus
      }
    });

    // Best effort, and reported as such: `false` means the work is not being
    // executed by this process, which is a fact the operator needs, not an
    // error to hide.
    const signalled = this.dependencies.cancellations?.cancel(runId) ?? false;
    const execution = signalled ? "signal_delivered" : "not_running_here";

    await this.dependencies.events.append({
      sessionId,
      correlationId: runId,
      type: "AGENT_RUN_CANCELLED",
      payload: {
        agentRunId: runId,
        requestedBy,
        reason,
        requestedAt,
        previousStatus,
        /** What this process did — never "the executor has stopped". */
        execution
      }
    });

    return {
      run: cancelled,
      alreadyCancelled: false,
      statusChanged: true,
      execution,
      previousStatus,
      reason
    };
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

/** A reason is operator text: trimmed, non-empty, and bounded before storage. */
function normaliseReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 500);
}
