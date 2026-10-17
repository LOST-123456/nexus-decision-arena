import {
  canCancelRun,
  isRetrySupportedPurpose,
  isRetryableRun,
  type AgentRunDetail,
  type AgentRunEvent,
  type AgentRunView
} from "@nexus/shared";
import type { ArenaRepository, EventRepository, ReviewRepository } from "@nexus/db";
import type { CrossReviewResult, CrossReviewService } from "./cross-review-service";
import { CrossReviewRetryRefusedError } from "./cross-review-service";
import type { RunCancellationRegistry } from "./run-cancellation";

/** Hard ceiling on retry attempts per run. The run being retried has its own
 * `attempt`, and a retry opens `attempt + 1`; we stop once it would exceed this. */
export const MAX_AGENT_RUN_RETRIES = 3;

/**
 * How long a `running` run may sit unsettled before a retry treats it as
 * abandoned.
 *
 * A run row is written before the executor starts, so a process that dies in
 * between leaves a row nobody will ever finish. That row cannot be retried
 * (retry needs a failed run) and cannot be completed (we do not know what ran),
 * so without a way out the whole retry chain is blocked for good.
 *
 * Deliberately generous: a cross-review with a real provider can legitimately
 * take minutes, and marking a live run failed would refuse the writes it is
 * still making. Half an hour is long enough that a live run is implausible and
 * short enough that an operator is not stuck for a day.
 */
export const RETRY_STALE_RUN_MS = 30 * 60_000;

/**
 * Pure companion to `RETRY_STALE_RUN_MS`: is this run old enough to be treated
 * as abandoned? Kept separate from the write so retry eligibility can be fully
 * decided — and refused — without settling anything first. A run whose start
 * time cannot be read is never stale: we cannot tell a dead run from a live
 * one, and refusing is the answer that cannot be wrong.
 */
export function isStaleRun(
  startedAt: string | undefined,
  now: number = Date.now()
): boolean {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return false;
  return now - started >= RETRY_STALE_RUN_MS;
}

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

/**
 * The chain already moved past this run: a sibling run of the same generation
 * opened the next attempt first.
 *
 * This is not a failure to retry *the work* — it is a refusal to branch the
 * chain. The child's id is carried so the operator can look at the retry that
 * actually happened instead of pressing a button that can never succeed.
 */
export class AgentRunAlreadyRetriedError extends Error {
  constructor(
    readonly childRunId: string | null,
    readonly deepestAttempt: number
  ) {
    super(
      childRunId
        ? `该运行所属的尝试（第 ${deepestAttempt} 次）已经产生过重试，请改从最新的重试运行发起。`
        : `该运行所属的尝试（第 ${deepestAttempt} 次）已经有过重试记录，不能重复开启。`
    );
    this.name = "AgentRunAlreadyRetriedError";
  }
}

/**
 * What a retry produced, in the terms the operator needs: the same
 * cross-review result the panel already renders, plus the lineage facts that
 * were written **before** execution started.
 */
export type AgentRunRetryResult = CrossReviewResult & {
  retry: {
    /** The run whose Retry button was pressed. */
    originalRunId: string;
    /** The attempt this generation carries (1-based). */
    attempt: number;
    /** The run ids created for it — known even when every one of them failed. */
    runIds: string[];
  };
};

export type AgentRunServiceDependencies = {
  reviews: Pick<
    ReviewRepository,
    | "getAgentRunById"
    | "listAgentRunsDetailed"
    | "listAgentRunEvents"
    | "cancelAgentRun"
    | "abandonStaleRun"
  >;
  arena: Pick<
    ArenaRepository,
    | "getSessionArtifacts"
    | "listChallengesByRun"
    | "listResponseClaimsByRun"
    | "listConflictsByChallengeIds"
  >;
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

    // Link the run to the work it produced, queried by the run's own id rather
    // than by loading the whole session and filtering in the app. A cross-review
    // run owns challenges (by `challengerRunId`) and response claims (by
    // `agentRunId`); conflicts are reached through the challenges it created,
    // via a jsonb overlap test on `conflict.challengeIds`. In a large session
    // this turns four full-table scans into four tiny index seeks.
    const challenges = await this.dependencies.arena.listChallengesByRun(
      sessionId,
      runId
    );
    const responseClaims = await this.dependencies.arena.listResponseClaimsByRun(
      sessionId,
      runId
    );
    const challengeIds = challenges.map((challenge) => challenge.id);
    const conflicts =
      await this.dependencies.arena.listConflictsByChallengeIds(
        sessionId,
        challengeIds
      );
    const conflictIds = conflicts
      .filter((conflict) =>
        conflict.challengeIds.some((id) => challengeIds.includes(id))
      )
      .map((conflict) => conflict.id);
    const responseClaimIds = responseClaims.map((claim) => claim.id);

    return {
      ...run,
      events,
      outcome: { challengeIds, conflictIds, responseClaimIds }
    };
  }

  /**
   * A run's event timeline alone — the same ledger `getRunDetail` reads, but
   * without the run-linked artifacts. The agent-runs events route used to call
   * `getRunDetail` (and thereby load the whole session) just to return
   * `detail.events`; this returns the same events straight from the execution
   * log, after confirming the run exists in this session.
   */
  async getRunEvents(
    sessionId: string,
    runId: string
  ): Promise<AgentRunEvent[]> {
    const run = await this.dependencies.reviews.getAgentRunById(
      sessionId,
      runId
    );
    if (!run) {
      throw new AgentRunNotFoundError(runId);
    }
    return this.dependencies.reviews.listAgentRunEvents(sessionId, runId);
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
   * Safe retry of a cross-review run. Opens a *new* generation (new ids, higher
   * attempt, `parentRunId` pointing back), re-using the same claim target and
   * the same cross-examination engine. The original run is left untouched.
   *
   * The lineage is written **before** anything executes. That ordering is the
   * whole repair: a retry used to run the examination first and patch
   * `attempt`/`parentRunId` onto the fresh rows afterwards, so a provider that
   * failed — or a process that died — left runs that were real, had produced
   * real artifacts, and claimed to be first attempts with no parent. The chain
   * could not be reconstructed from the database, and the retry budget could
   * not be trusted either.
   *
   * Now `startRetryGeneration` locks the chain root, reads the deepest attempt
   * under that lock, refuses a run the chain has already moved past, checks the
   * ceiling, and inserts the rows with their lineage already set — all in one
   * transaction that ends before the first provider call. The budget is
   * therefore the database's, not a number read from whichever row was on
   * screen.
   */
  async retryRun(
    sessionId: string,
    runId: string,
    actor: string
  ): Promise<AgentRunRetryResult> {
    const run = await this.dependencies.reviews.getAgentRunById(
      sessionId,
      runId
    );
    if (!run) {
      throw new AgentRunNotFoundError(runId);
    }
    if (!isRetrySupportedPurpose(run.purpose)) {
      throw new AgentRunRetryUnsupportedError(run.purpose);
    }
    if (!run.targetClaimId) {
      throw new AgentRunNotRetryableError("missing target claim");
    }

    // Eligibility is decided entirely before anything is written. The three
    // gates below are facts about *this run* — its state, whether it is old
    // enough to be given up on, and whether the chain root belongs to this
    // session — and they are answered without touching the row. Only a request
    // that will actually be served may settle a stale run: a refusal must not
    // leave a run failed on its way to saying no.
    const stale = run.status === "running" && isStaleRun(run.startedAt);
    if (run.status === "running" ? !stale : !isRetryableRun(run.status)) {
      throw new AgentRunNotRetryableError(run.status);
    }
    if (!this.dependencies.crossReview) {
      throw new AgentRunRetryUnsupportedError("crossReview unavailable");
    }
    if (stale) {
      await this.abandonIfStale(sessionId, run);
    }

    // Recorded before the attempt is opened: if creating the generation fails,
    // the operator still has evidence that a retry was asked for and produced
    // nothing. It never claims a run exists.
    await this.dependencies.events.append({
      sessionId,
      correlationId: runId,
      type: "AGENT_RUN_RETRY_REQUESTED",
      payload: {
        originalRunId: runId,
        requestedBy: actor,
        requestedAt: new Date().toISOString(),
        previousStatus: run.status
      }
    });

    let result: CrossReviewResult;
    try {
      result = await this.dependencies.crossReview.runForClaim({
        sessionId,
        claimId: run.targetClaimId,
        actor,
        retryOf: { runId, ceiling: MAX_AGENT_RUN_RETRIES }
      });
    } catch (error) {
      throw this.toRetryError(error, runId);
    }

    return {
      ...result,
      retry: {
        originalRunId: runId,
        attempt: result.runs[0]?.run.attempt ?? 1,
        runIds: result.runs.map((outcome) => outcome.run.id)
      }
    };
  }

  /**
   * Gives up on a run that was opened but never settled, so the chain can move
   * again. Only a run older than `RETRY_STALE_RUN_MS` is eligible, and the
   * transition is conditional on it still being `running` — a run that settled
   * while we looked is left exactly as its executor left it.
   */
  private async abandonIfStale(
    sessionId: string,
    run: AgentRunView
  ): Promise<void> {
    // Re-checked here rather than trusted from the caller: the write is the
    // point of no return, so it carries its own gate.
    if (!isStaleRun(run.startedAt)) {
      throw new AgentRunNotRetryableError(run.status);
    }

    const reason =
      "该运行在创建后长时间未推进，判定为已放弃（进程中断）；不代表已产生结果。";
    const abandoned = await this.dependencies.reviews.abandonStaleRun({
      sessionId,
      runId: run.id,
      startedBefore: new Date(Date.now() - RETRY_STALE_RUN_MS).toISOString(),
      error: reason,
      errorCode: "internal_error"
    });
    if (!abandoned) {
      throw new AgentRunNotRetryableError(run.status);
    }

    // The run now has a terminal state. Saying why is part of the record: this
    // was not a provider failure and not a user cancel.
    await this.dependencies.events.append({
      sessionId,
      correlationId: run.id,
      type: "AGENT_RUN_FAILED",
      payload: {
        agentRunId: run.id,
        roleId: run.roleId,
        purpose: run.purpose,
        ...(run.targetClaimId ? { targetClaimId: run.targetClaimId } : {}),
        message: reason,
        abandonedAfterMs: RETRY_STALE_RUN_MS
      }
    });
  }

  /** Translates the generation-opening refusals into this service's vocabulary. */
  private toRetryError(error: unknown, runId: string): unknown {
    if (error instanceof CrossReviewRetryRefusedError) {
      switch (error.reason) {
        case "not_found":
          return new AgentRunNotFoundError(runId);
        case "already_retried":
          return new AgentRunAlreadyRetriedError(
            error.detail.childRunId ?? null,
            error.detail.deepestAttempt ?? 1
          );
        case "limit_reached":
          return new AgentRunRetryLimitError(
            error.detail.attempt ?? MAX_AGENT_RUN_RETRIES,
            error.detail.ceiling ?? MAX_AGENT_RUN_RETRIES
          );
      }
    }
    return error;
  }
}

/** A reason is operator text: trimmed, non-empty, and bounded before storage. */
function normaliseReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, 500);
}
