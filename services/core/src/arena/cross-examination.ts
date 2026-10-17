import {
  ChallengeSchema,
  ClaimSchema,
  newId,
  type AgentRole,
  type Challenge,
  type Claim,
  type Conflict,
  type ExecutionEvent
} from "@nexus/shared";
import { selectClaims } from "../workflow/claim-selector";
import { assignChallengers } from "../workflow/challenger-assigner";
import { detectConflicts } from "../workflow/conflict-detector";

export type CrossExaminationInput = {
  sessionId: string;
  claims: Claim[];
  roles: AgentRole[];
  plans?: CrossExaminationPlan[];
  /**
   * Persistence callbacks may answer `false`, meaning "this run may no longer
   * write" — the caller's row-locked guard refused the write because the run
   * was cancelled. The engine then stops that run's remaining work instead of
   * pretending it produced something.
   */
  persistChallenge?: (challenge: Challenge) => Promise<void | boolean>;
  persistResponseClaim?: (claim: Claim) => Promise<void | boolean>;
  persistChallengeUpdate?: (challenge: Challenge) => Promise<void | boolean>;
  persistConflict?: (conflict: Conflict) => Promise<void | boolean>;
  /**
   * The cancellation signal for one challenger run. Supplied by the caller that
   * owns the runs; the engine passes it to the provider on every call so an
   * abort actually interrupts the request instead of being observed too late.
   */
  signalFor?: (challengerRunId: string) => AbortSignal | undefined;
  emit: (
    event: Partial<ExecutionEvent> & { type: ExecutionEvent["type"] }
  ) => Promise<void> | void;
};

/**
 * Raised when a run's write was refused because that run is no longer running.
 * It is not a failure of the work — it is the work being stopped on purpose.
 */
export class CrossExaminationHaltedError extends Error {
  constructor(readonly challengerRunId: string) {
    super(`Cross-examination halted: run ${challengerRunId} is no longer running.`);
    this.name = "CrossExaminationHaltedError";
  }
}

export type CrossExaminationPlan = {
  targetClaimId: string;
  challengerRoleId: string;
  challengerRunId: string;
};

export type ChallengeDraft = Pick<
  Challenge,
  | "type"
  | "question"
  | "context"
  | "requiredEvidence"
  | "severity"
  | "resolutionStrategy"
>;

export type CrossExaminationResult = {
  challenges: Challenge[];
  responseClaims: Claim[];
  conflicts: Conflict[];
};

type CrossExaminationDependencies = {
  generateChallenge: (
    challenger: AgentRole,
    target: Claim,
    signal?: AbortSignal
  ) => Promise<ChallengeDraft>;
  respondToChallenge: (
    challenge: Challenge,
    target: Claim,
    signal?: AbortSignal
  ) => Promise<Claim>;
  evaluateResponse: (
    challenge: Challenge,
    responseClaim: Claim,
    signal?: AbortSignal
  ) => Promise<"resolved" | "unresolved">;
};

function validateResponseRevision(
  response: Claim,
  target: Claim,
  challenge: Challenge
): Claim {
  const parsed = ClaimSchema.parse(response);

  if (
    parsed.id === target.id ||
    parsed.revisionOfClaimId !== target.id ||
    parsed.revision <= target.revision
  ) {
    throw new Error(
      `Challenge ${challenge.id} must produce a newer Claim revision of ${target.id}`
    );
  }

  if (parsed.respondsToChallengeId !== challenge.id) {
    throw new Error(
      `Response Claim ${parsed.id} does not answer Challenge ${challenge.id}`
    );
  }

  if (parsed.sessionId !== target.sessionId) {
    throw new Error(
      `Response Claim ${parsed.id} belongs to a different session`
    );
  }

  return parsed;
}

export class CrossExaminationService {
  constructor(private readonly dependencies: CrossExaminationDependencies) {}

  async run(input: CrossExaminationInput): Promise<CrossExaminationResult> {
    const configuredMaxClaims = Number(
      process.env.CROSS_EXAMINATION_MAX_CLAIMS ?? 5
    );
    const configuredMaxChallengers = Number(
      process.env.CROSS_EXAMINATION_MAX_CHALLENGERS ?? 2
    );
    const maxClaims =
      Number.isFinite(configuredMaxClaims) && configuredMaxClaims > 0
        ? configuredMaxClaims
        : 5;
    const maxChallengers =
      Number.isFinite(configuredMaxChallengers) &&
      configuredMaxChallengers > 0
        ? configuredMaxChallengers
        : 2;
    const challenges: Challenge[] = [];
    const responseClaims: Claim[] = [];
    const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));
    const roleById = new Map(input.roles.map((role) => [role.id, role]));
    const work = input.plans
      ? input.plans.flatMap((plan) => {
          const target = claimById.get(plan.targetClaimId);
          const challenger = roleById.get(plan.challengerRoleId);
          return target && challenger
            ? [{ target, challenger, challengerRunId: plan.challengerRunId }]
            : [];
        })
      : selectClaims(input.claims, maxClaims).flatMap((target) =>
          assignChallengers(target, input.roles, maxChallengers).map((challenger) => ({
            target,
            challenger,
            challengerRunId: newId()
          }))
        );

    for (const { target, challenger, challengerRunId } of work) {
        const correlationId = newId();
        const signal = input.signalFor?.(challengerRunId);

        try {
          const draft = await this.dependencies.generateChallenge(
            challenger,
            structuredClone(target),
            signal
          );
          const now = new Date().toISOString();
          const challenge = ChallengeSchema.parse({
            id: newId(),
            sessionId: input.sessionId,
            targetClaimId: target.id,
            challengerRunId,
            challengerRoleId: challenger.id,
            ...draft,
            status: "open",
            correlationId,
            createdAt: now,
            updatedAt: now
          });
          // Push only after the write is accepted: a refused write must not
          // leave the engine believing this run produced a challenge.
          const challengeStored = await input.persistChallenge?.(
            structuredClone(challenge)
          );
          if (challengeStored === false) {
            throw new CrossExaminationHaltedError(challengerRunId);
          }
          challenges.push(challenge);
          await input.emit({
            type: "CHALLENGE_CREATED",
            payload: structuredClone(challenge),
            correlationId: challenge.correlationId
          });

          const response = validateResponseRevision(
            await this.dependencies.respondToChallenge(
              challenge,
              structuredClone(target),
              signal
            ),
            target,
            challenge
          );
          const responseStored = await input.persistResponseClaim?.(
            structuredClone(response)
          );
          if (responseStored === false) {
            throw new CrossExaminationHaltedError(challengerRunId);
          }
          responseClaims.push(response);
          challenge.status = "answered";
          challenge.responseClaimId = response.id;
          challenge.status = await this.dependencies.evaluateResponse(
            challenge,
            response,
            signal
          );
          challenge.updatedAt = new Date().toISOString();
          const updateStored = await input.persistChallengeUpdate?.(
            structuredClone(challenge)
          );
          if (updateStored === false) {
            throw new CrossExaminationHaltedError(challengerRunId);
          }
          await input.emit({
            type: "CHALLENGE_RESOLVED",
            payload: challenge,
            correlationId: challenge.correlationId
          });
        } catch (error) {
          if (
            error instanceof CrossExaminationHaltedError ||
            signal?.aborted === true
          ) {
            // A cancelled run did not fail — it was stopped on purpose.
            // Emitting CHALLENGE_FAILED here would put a failure badge on an
            // operator's deliberate action. An abort also counts even without
            // the sentinel error: a provider that honoured the signal rejects
            // with its own AbortError, and that is the same event.
            continue;
          }
          await input.emit({
            type: "CHALLENGE_FAILED",
            payload: {
              targetClaimId: target.id,
              challengerRoleId: challenger.id,
              message:
                error instanceof Error
                  ? error.message
                  : "Unknown challenge failure"
            },
            correlationId
          });
        }
    }

    const conflicts = detectConflicts({
      sessionId: input.sessionId,
      claims: [...input.claims, ...responseClaims],
      challenges
    });

    for (const conflict of conflicts) {
      const stored = await input.persistConflict?.(structuredClone(conflict));
      if (stored === false) {
        // The run behind this conflict was cancelled before the write landed.
        // Nothing was persisted, so nothing may be announced.
        continue;
      }
      await input.emit({
        type: "CONFLICT_DETECTED",
        payload: conflict,
        correlationId: newId()
      });
    }

    return { challenges, responseClaims, conflicts };
  }
}
