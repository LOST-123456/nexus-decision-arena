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
  persistChallenge?: (challenge: Challenge) => Promise<void>;
  persistResponseClaim?: (claim: Claim) => Promise<void>;
  persistChallengeUpdate?: (challenge: Challenge) => Promise<void>;
  persistConflict?: (conflict: Conflict) => Promise<void>;
  emit: (
    event: Partial<ExecutionEvent> & { type: ExecutionEvent["type"] }
  ) => Promise<void> | void;
};

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
    target: Claim
  ) => Promise<ChallengeDraft>;
  respondToChallenge: (
    challenge: Challenge,
    target: Claim
  ) => Promise<Claim>;
  evaluateResponse: (
    challenge: Challenge,
    responseClaim: Claim
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

        try {
          const draft = await this.dependencies.generateChallenge(
            challenger,
            structuredClone(target)
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
          challenges.push(challenge);
          await input.persistChallenge?.(structuredClone(challenge));
          await input.emit({
            type: "CHALLENGE_CREATED",
            payload: structuredClone(challenge),
            correlationId: challenge.correlationId
          });

          const response = validateResponseRevision(
            await this.dependencies.respondToChallenge(
              challenge,
              structuredClone(target)
            ),
            target,
            challenge
          );
          responseClaims.push(response);
          await input.persistResponseClaim?.(structuredClone(response));
          challenge.status = "answered";
          challenge.responseClaimId = response.id;
          challenge.status = await this.dependencies.evaluateResponse(
            challenge,
            response
          );
          challenge.updatedAt = new Date().toISOString();
          await input.persistChallengeUpdate?.(structuredClone(challenge));
          await input.emit({
            type: "CHALLENGE_RESOLVED",
            payload: challenge,
            correlationId: challenge.correlationId
          });
        } catch (error) {
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
      await input.persistConflict?.(structuredClone(conflict));
      await input.emit({
        type: "CONFLICT_DETECTED",
        payload: conflict,
        correlationId: newId()
      });
    }

    return { challenges, responseClaims, conflicts };
  }
}
