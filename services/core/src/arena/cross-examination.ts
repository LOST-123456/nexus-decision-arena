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
  emit: (
    event: Partial<ExecutionEvent> & { type: ExecutionEvent["type"] }
  ) => void;
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
    const challenges: Challenge[] = [];
    const responseClaims: Claim[] = [];
    const selected = selectClaims(input.claims, 5);

    for (const target of selected) {
      const challengers = assignChallengers(target, input.roles, 2);

      for (const challenger of challengers) {
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
            challengerRunId: newId(),
            challengerRoleId: challenger.id,
            ...draft,
            status: "open",
            correlationId,
            createdAt: now,
            updatedAt: now
          });
          challenges.push(challenge);
          input.emit({
            type: "CHALLENGE_CREATED",
            payload: challenge,
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
          challenge.status = "answered";
          challenge.responseClaimId = response.id;
          challenge.status = await this.dependencies.evaluateResponse(
            challenge,
            response
          );
          challenge.updatedAt = new Date().toISOString();
          input.emit({
            type: "CHALLENGE_RESOLVED",
            payload: challenge,
            correlationId: challenge.correlationId
          });
        } catch (error) {
          input.emit({
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
    }

    const conflicts = detectConflicts({
      sessionId: input.sessionId,
      claims: [...input.claims, ...responseClaims],
      challenges
    });

    for (const conflict of conflicts) {
      input.emit({
        type: "CONFLICT_DETECTED",
        payload: conflict,
        correlationId: newId()
      });
    }

    return { challenges, responseClaims, conflicts };
  }
}