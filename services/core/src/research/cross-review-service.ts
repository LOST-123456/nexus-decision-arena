import {
  assertClaimInvariants,
  evidenceCoversClaim,
  newId,
  type AgentRole,
  type AgentRun,
  type Challenge,
  type Claim,
  type Conflict,
  type ExecutionEvent
} from "@nexus/shared";
import type { ArenaRepository, ReviewRepository } from "@nexus/db";
import type { EventBus } from "../execution/event-bus";
import {
  CrossExaminationService,
  type CrossExaminationPlan
} from "../arena/cross-examination";
import { assignChallengers } from "../workflow/challenger-assigner";
import type { SessionArtifacts } from "../arena/run-session";
import type { RunCancellationRegistry } from "./run-cancellation";

export class CrossReviewClaimNotFoundError extends Error {
  constructor(claimId: string) {
    super(`Claim not found in this session: ${claimId}`);
    this.name = "CrossReviewClaimNotFoundError";
  }
}

/** Two reviewers must not be able to run the same examination at once. */
export class CrossReviewInProgressError extends Error {
  constructor(readonly runId: string) {
    super("A cross-examination is already running for this claim");
    this.name = "CrossReviewInProgressError";
  }
}

export class CrossReviewNoChallengerError extends Error {
  constructor() {
    super(
      "No agent role other than the claim's author can act as a challenger"
    );
    this.name = "CrossReviewNoChallengerError";
  }
}

export type CrossReviewRunOutcome = {
  run: AgentRun;
  challenges: Challenge[];
  /**
   * `cancelled` means the run was stopped on purpose before it finished. It is
   * neither success nor failure, and it is never counted as a completed run.
   */
  status: "completed" | "failed" | "cancelled";
  failure: string | null;
};

export type CrossReviewResult = {
  sessionId: string;
  claimId: string;
  /** `cancelled` means every challenger run was stopped before finishing. */
  status: "completed" | "partial" | "failed" | "cancelled";
  runs: CrossReviewRunOutcome[];
  challenges: Challenge[];
  responseClaims: Claim[];
  conflicts: Conflict[];
  failures: Array<{ runId: string; roleId: string; reason: string }>;
};

export type CrossReviewDependencies = {
  /** Reads the durable artifacts of the session being examined. */
  readArtifacts(sessionId: string): Promise<SessionArtifacts | null>;
  readRoles(sessionId: string): Promise<AgentRole[]>;
  runs: Pick<
    ReviewRepository,
    | "startCrossReviewRun"
    | "completeCrossReviewRun"
    | "failCrossReviewRun"
    | "findRunningCrossReview"
    | "getRunStatus"
  >;
  /**
   * Every artifact write goes through a `…WhileRunActive` method: the write and
   * the "is this run still running?" answer are one transaction with a row lock
   * on `agent_runs`, so a cancel cannot slip between them.
   */
  arena: Pick<
    ArenaRepository,
    | "saveChallengeWhileRunActive"
    | "updateChallengeWhileRunActive"
    | "saveClaimWhileRunActive"
    | "saveConflictWhileRunActive"
  >;
  /** Owns the AbortSignals for runs this process is executing. */
  cancellations: Pick<RunCancellationRegistry, "begin" | "signal" | "end">;
  getClaimValidationContext: ArenaRepository["getClaimValidationContext"];
  /**
   * The arena's own cross-examination engine. Only `run` is needed, so this is
   * structural rather than the concrete class — the reuse is of behaviour, not
   * of construction.
   */
  crossExamination: () => Pick<CrossExaminationService, "run">;
  appendEvent(input: {
    sessionId: string;
    correlationId: string;
    type: ExecutionEvent["type"];
    payload: unknown;
  }): Promise<ExecutionEvent>;
  eventBus: EventBus;
  /** Max challengers per claim; mirrors the arena's own configured limit. */
  maxChallengers?: number;
};

/**
 * Runs cross-examination against ONE claim and records it as real work.
 *
 * This deliberately reuses `CrossExaminationService` and `assignChallengers`
 * rather than re-implementing a debate: the same challenger selection, the
 * same challenge persistence, the same invariant checks, and the same
 * `CHALLENGE_*` events as a full arena run.
 *
 * What it adds is attribution: each challenger gets its own `agent_runs` row
 * before it runs, so the workspace can show who examined what, whether it
 * succeeded, and — when it did not — why. A run that produces no challenge is
 * recorded as failed with the owner's reason; it is never reported as success.
 */
export class CrossReviewService {
  constructor(private readonly dependencies: CrossReviewDependencies) {}

  async runForClaim(input: {
    sessionId: string;
    claimId: string;
    actor: string;
  }): Promise<CrossReviewResult> {
    const artifacts = await this.dependencies.readArtifacts(input.sessionId);
    if (!artifacts) {
      throw new CrossReviewClaimNotFoundError(input.claimId);
    }
    const claim = artifacts.claims.find((item) => item.id === input.claimId);
    if (!claim) {
      throw new CrossReviewClaimNotFoundError(input.claimId);
    }

    const alreadyRunning = await this.dependencies.runs.findRunningCrossReview(
      input.sessionId,
      input.claimId
    );
    if (alreadyRunning) {
      throw new CrossReviewInProgressError(alreadyRunning.id);
    }

    const roles = await this.dependencies.readRoles(input.sessionId);
    const challengers = assignChallengers(
      claim,
      roles,
      this.dependencies.maxChallengers ?? 2
    );
    if (challengers.length === 0) {
      throw new CrossReviewNoChallengerError();
    }

    // A real run row per challenger, before any model work happens. Each run
    // also gets a signal here, so a cancel that arrives during the very first
    // provider call still has something to abort.
    const claims: Array<{ run: AgentRun; challenger: AgentRole }> = [];
    const signals = new Map<string, AbortSignal>();
    for (const challenger of challengers) {
      const runId = newId();
      const run = await this.dependencies.runs.startCrossReviewRun({
        id: runId,
        sessionId: input.sessionId,
        roleId: challenger.id,
        promptVersionId: challenger.promptVersionId,
        targetClaimId: input.claimId,
        requestedBy: input.actor,
        // The run id is its own correlation anchor. Every event in this run's
        // life is filed under it — which is what makes the run detail timeline
        // show the whole story instead of starting at the outcome. (It used to
        // be a second, unrelated id, so `AGENT_RUN_STARTED` was filed where no
        // run-scoped reader could ever find it.)
        correlationId: runId
      });
      signals.set(runId, this.dependencies.cancellations.begin(runId));
      await this.emit(input.sessionId, runId, "AGENT_RUN_STARTED", {
        roleId: challenger.id,
        agentRunId: runId,
        purpose: "cross_review",
        targetClaimId: input.claimId
      });
      claims.push({ run, challenger });
    }

    const challengeById = new Map<string, Challenge>();
    const responseClaims: Claim[] = [];
    const conflicts: Conflict[] = [];
    const failuresByRoleId = new Map<string, string>();
    /** Which run produced which challenge — needed to guard downstream writes. */
    const runIdByChallengeId = new Map<string, string>();
    const fallbackRunId = claims[0]?.run.id ?? null;

    const plans: CrossExaminationPlan[] = claims.map(({ run, challenger }) => ({
      targetClaimId: input.claimId,
      challengerRoleId: challenger.id,
      challengerRunId: run.id
    }));

    const service = this.dependencies.crossExamination();
    await service
      .run({
      sessionId: input.sessionId,
      // The whole claim set is passed so challenge context stays consistent,
      // but `plans` restricts the work to the claim under examination.
      claims: artifacts.claims,
      roles,
      plans,
      signalFor: (challengerRunId) => signals.get(challengerRunId),
      persistChallenge: async (challenge) => {
        const target = await this.dependencies.getClaimValidationContext(
          challenge.targetClaimId
        );
        if (target) {
          assertClaimInvariants(target.claim, target.evidence, [
            ...target.challenges,
            challenge
          ]);
        }
        const stored = await this.dependencies.arena.saveChallengeWhileRunActive(
          challenge.challengerRunId,
          challenge
        );
        if (stored) {
          runIdByChallengeId.set(challenge.id, challenge.challengerRunId);
        }
        return stored;
      },
      persistResponseClaim: async (responseClaim) => {
        const context = await this.dependencies.getClaimValidationContext(
          responseClaim.revisionOfClaimId ?? responseClaim.id
        );
        assertClaimInvariants(responseClaim, context?.evidence ?? []);
        // The run that owns this write is the one that raised the challenge it
        // answers — not whatever `agentRunId` the target claim happened to
        // carry. Attributing it correctly also makes the run detail page list
        // the response under the run that actually produced it.
        const runId = responseClaim.respondsToChallengeId
          ? runIdByChallengeId.get(responseClaim.respondsToChallengeId)
          : undefined;
        if (!runId) {
          // No owning run on this path means there is nothing to guard against;
          // writing unguarded would defeat the guard entirely.
          return false;
        }
        return this.dependencies.arena.saveClaimWhileRunActive(runId, {
          ...responseClaim,
          agentRunId: runId
        });
      },
      persistChallengeUpdate: (challenge) => {
        const runId =
          runIdByChallengeId.get(challenge.id) ??
          challenge.challengerRunId ??
          fallbackRunId;
        if (!runId) return Promise.resolve(false);
        return this.dependencies.arena.updateChallengeWhileRunActive(
          runId,
          challenge
        );
      },
      persistConflict: (conflict) => {
        // A conflict names challenges, not a run. Attribute it to the run that
        // raised one of them; when none is left (every challenger cancelled),
        // refuse the write rather than persist an ownerless result.
        const runId =
          conflict.challengeIds
            .map((id) => runIdByChallengeId.get(id))
            .find((id): id is string => typeof id === "string") ?? fallbackRunId;
        if (!runId) return Promise.resolve(false);
        return this.dependencies.arena.saveConflictWhileRunActive(runId, conflict);
      },
      emit: async (event) => {
        // The challenger's own failure is the only signal the service gives us
        // for why nothing came back, so it has to be captured here.
        if (
          event.type === "CHALLENGE_FAILED" &&
          isChallengeFailure(event.payload)
        ) {
          failuresByRoleId.set(
            event.payload.challengerRoleId,
            event.payload.message
          );
        }
        // `CHALLENGE_CREATED` carries the challenge before a response exists;
        // `CHALLENGE_RESOLVED` carries the same challenge with its final
        // status and response link, so it wins for any given id.
        if (event.type === "CHALLENGE_CREATED" && isChallenge(event.payload)) {
          challengeById.set(event.payload.id, event.payload);
        }
        if (event.type === "CHALLENGE_RESOLVED" && isChallenge(event.payload)) {
          challengeById.set(event.payload.id, event.payload);
        }
        if (event.type === "CONFLICT_DETECTED" && isConflict(event.payload)) {
          conflicts.push(event.payload);
        }
        await this.emit(
          input.sessionId,
          event.correlationId ?? newId(),
          event.type,
          event.payload
        );
      }
      })
      .catch((error: unknown) => {
        // The engine only throws for reasons that stopped the whole
        // examination; the signals must not outlive the call either way.
        this.releaseSignals(claims);
        throw error;
      });

    // `responseClaims` is not emitted by the service, so read what landed.
    const collected = [...challengeById.values()];
    const after = await this.dependencies.readArtifacts(input.sessionId);
    const persistedResponseClaimIds = new Set(
      collected
        .map((challenge) => challenge.responseClaimId)
        .filter((id): id is string => typeof id === "string")
    );
    responseClaims.push(
      ...(after?.claims ?? []).filter((item) =>
        persistedResponseClaimIds.has(item.id)
      )
    );

    const runs: CrossReviewRunOutcome[] = [];
    const failures: CrossReviewResult["failures"] = [];

    for (const { run, challenger } of claims) {
      const produced = collected.filter(
        (challenge) => challenge.challengerRoleId === challenger.id
      );
      const mapped = produced.filter(
        (challenge) => challenge.challengerRunId === run.id
      );
      const failure = failuresByRoleId.get(challenger.id);

      // The database is the authority on whether this run still existed when
      // the work came back. Reading it before deciding keeps a cancel that
      // landed mid-flight from being reported as a completion or a failure.
      const settled = await this.dependencies.runs.getRunStatus(run.id);
      if (settled === "cancelled") {
        // This process can add one fact the cancelling side could not: whether
        // the work here actually stopped. A fired signal on a run we owned is
        // that fact. When the cancel came from another instance there is no
        // local signal, and inventing this event would be a lie about work we
        // never touched — so it is simply absent.
        if (signals.get(run.id)?.aborted === true) {
          await this.emit(
            input.sessionId,
            run.id,
            "AGENT_RUN_EXECUTION_STOPPED",
            {
              agentRunId: run.id,
              roleId: challenger.id,
              purpose: "cross_review",
              stoppedAt: new Date().toISOString(),
              reason: "cancel_signal"
            }
          );
        }
        // Anything this run wrote before the cancel is real history and stays
        // attached; what it did not write is simply absent.
        runs.push({
          run: { ...run, status: "cancelled" },
          challenges: mapped,
          status: "cancelled",
          failure: null
        });
        continue;
      }

      if (failure || mapped.length === 0) {
        const reason =
          failure ??
          "The challenger finished without producing a challenge for this claim.";
        const failed = await this.dependencies.runs.failCrossReviewRun({
          runId: run.id,
          error: reason
        });
        if (!failed) {
          // Lost the race to a cancel: record what actually happened.
          runs.push({
            run: { ...run, status: "cancelled" },
            challenges: mapped,
            status: "cancelled",
            failure: null
          });
          continue;
        }
        await this.emit(input.sessionId, run.id, "AGENT_RUN_FAILED", {
          roleId: challenger.id,
          agentRunId: run.id,
          purpose: "cross_review",
          targetClaimId: input.claimId,
          message: reason
        });
        failures.push({ runId: run.id, roleId: challenger.id, reason });
        runs.push({
          run: { ...run, status: "failed", error: reason },
          challenges: [],
          status: "failed",
          failure: reason
        });
        continue;
      }

      const output = {
        purpose: "cross_review",
        targetClaimId: input.claimId,
        challenges: mapped.map((challenge) => ({
          id: challenge.id,
          type: challenge.type,
          question: challenge.question,
          severity: challenge.severity,
          status: challenge.status,
          requiredEvidence: challenge.requiredEvidence,
          resolutionStrategy: challenge.resolutionStrategy,
          responseClaimId: challenge.responseClaimId ?? null
        }))
      };
      const completedNow = await this.dependencies.runs.completeCrossReviewRun({
        runId: run.id,
        output
      });
      if (!completedNow) {
        // A cancel committed first. Announcing completion here would contradict
        // the row the operator is looking at.
        runs.push({
          run: { ...run, status: "cancelled" },
          challenges: mapped,
          status: "cancelled",
          failure: null
        });
        continue;
      }
      await this.emit(input.sessionId, run.id, "AGENT_RUN_COMPLETED", {
        roleId: challenger.id,
        agentRunId: run.id,
        purpose: "cross_review",
        targetClaimId: input.claimId,
        challengeCount: mapped.length
      });
      runs.push({
        run: { ...run, status: "completed" },
        challenges: mapped,
        status: "completed",
        failure: null
      });
    }

    const completed = runs.filter((entry) => entry.status === "completed").length;
    const cancelled = runs.filter((entry) => entry.status === "cancelled").length;
    this.releaseSignals(claims);
    return {
      sessionId: input.sessionId,
      claimId: input.claimId,
      status:
        completed === runs.length
          ? "completed"
          : completed > 0
            ? "partial"
            : cancelled === runs.length
              ? "cancelled"
              : "failed",
      runs,
      challenges: collected,
      responseClaims,
      conflicts,
      failures
    };
  }

  /**
   * Drops the signals for the runs this call owned. A finished run must not
   * leave a controller behind: the registry is bounded by live runs, and a
   * stale entry would make a later cancel look delivered when nothing is
   * listening. Safe to call on every exit path, including the failure one.
   */
  private releaseSignals(claims: ReadonlyArray<{ run: AgentRun }>): void {
    for (const { run } of claims) {
      this.dependencies.cancellations.end(run.id);
    }
  }

  private async emit(
    sessionId: string,
    correlationId: string,
    type: ExecutionEvent["type"],
    payload: unknown
  ): Promise<ExecutionEvent> {
    const event = await this.dependencies.eventBus.publishAfterCommit({
      append: () =>
        this.dependencies.appendEvent({
          sessionId,
          correlationId,
          type,
          payload
        })
    });
    return event;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isChallengeFailure(
  payload: unknown
): payload is { challengerRoleId: string; message: string } {
  return (
    isRecord(payload) &&
    typeof payload.challengerRoleId === "string" &&
    typeof payload.message === "string"
  );
}

function isChallenge(payload: unknown): payload is Challenge {
  return (
    isRecord(payload) &&
    typeof payload.id === "string" &&
    typeof payload.challengerRunId === "string" &&
    typeof payload.targetClaimId === "string"
  );
}

function isConflict(payload: unknown): payload is Conflict {
  return (
    isRecord(payload) && typeof payload.id === "string" && "severity" in payload
  );
}

/** Re-exported so callers can assert the invariant check the service relies on. */
export { evidenceCoversClaim };
