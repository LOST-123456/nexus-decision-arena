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
  status: "completed" | "failed";
  failure: string | null;
};

export type CrossReviewResult = {
  sessionId: string;
  claimId: string;
  /** `failed` means every challenger run failed — it is never a success. */
  status: "completed" | "partial" | "failed";
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
  >;
  arena: Pick<
    ArenaRepository,
    "saveChallenge" | "updateChallenge" | "saveClaim" | "saveConflict"
  >;
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

    // A real run row per challenger, before any model work happens.
    const claims: Array<{ run: AgentRun; challenger: AgentRole }> = [];
    for (const challenger of challengers) {
      const runId = newId();
      const correlationId = newId();
      const run = await this.dependencies.runs.startCrossReviewRun({
        id: runId,
        sessionId: input.sessionId,
        roleId: challenger.id,
        promptVersionId: challenger.promptVersionId,
        targetClaimId: input.claimId,
        requestedBy: input.actor,
        correlationId
      });
      await this.emit(input.sessionId, correlationId, "AGENT_RUN_STARTED", {
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

    const plans: CrossExaminationPlan[] = claims.map(({ run, challenger }) => ({
      targetClaimId: input.claimId,
      challengerRoleId: challenger.id,
      challengerRunId: run.id
    }));

    const service = this.dependencies.crossExamination();
    await service.run({
      sessionId: input.sessionId,
      // The whole claim set is passed so challenge context stays consistent,
      // but `plans` restricts the work to the claim under examination.
      claims: artifacts.claims,
      roles,
      plans,
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
        await this.dependencies.arena.saveChallenge(challenge);
      },
      persistResponseClaim: async (responseClaim) => {
        const context = await this.dependencies.getClaimValidationContext(
          responseClaim.revisionOfClaimId ?? responseClaim.id
        );
        assertClaimInvariants(responseClaim, context?.evidence ?? []);
        await this.dependencies.arena.saveClaim(responseClaim);
      },
      persistChallengeUpdate: (challenge) =>
        this.dependencies.arena.updateChallenge(challenge),
      persistConflict: (conflict) =>
        this.dependencies.arena.saveConflict(conflict),
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

      if (failure || mapped.length === 0) {
        const reason =
          failure ??
          "The challenger finished without producing a challenge for this claim.";
        await this.dependencies.runs.failCrossReviewRun({
          runId: run.id,
          error: reason
        });
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
      await this.dependencies.runs.completeCrossReviewRun({
        runId: run.id,
        output
      });
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
    return {
      sessionId: input.sessionId,
      claimId: input.claimId,
      status:
        completed === runs.length
          ? "completed"
          : completed === 0
            ? "failed"
            : "partial",
      runs,
      challenges: collected,
      responseClaims,
      conflicts,
      failures
    };
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
