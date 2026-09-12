import {
  HumanDecisionSchema,
  SESSION_PHASES,
  newId,
  type HumanDecision,
  type SessionPhase
} from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import { applyHumanDecision } from "../../checkpoints/human-checkpoint";
import type { EventBus } from "../../execution/event-bus";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

export const CreateHumanDecisionSchema = HumanDecisionSchema.omit({
  id: true,
  sessionId: true,
  createdAt: true
});

class HumanDecisionSessionNotFoundError extends Error {
  constructor() {
    super("Session not found");
    this.name = "HumanDecisionSessionNotFoundError";
  }
}

class InvalidSessionPhaseError extends Error {
  constructor() {
    super("Session phase is not recognized");
    this.name = "InvalidSessionPhaseError";
  }
}

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

function isSessionPhase(value: string): value is SessionPhase {
  return SESSION_PHASES.includes(value as SessionPhase);
}

export function registerHumanDecisionRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "sessions">,
  idempotency: IdempotencyStore,
  eventBus: EventBus
): void {
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/human-decisions",
    async (request, reply) => {
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }

      const parsed = CreateHumanDecisionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid human decision request",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "record-human-decision",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(
          key,
          requestHash,
          async () => {
            const current = await dependencies.sessions.getById(sessionId);
            if (!current) {
              throw new HumanDecisionSessionNotFoundError();
            }
            if (!isSessionPhase(current.phase)) {
              throw new InvalidSessionPhaseError();
            }

            const decision: HumanDecision = {
              id: newId(),
              sessionId,
              ...parsed.data,
              createdAt: new Date().toISOString()
            };
            const decisionTransition = applyHumanDecision({
              decision,
              currentPhase: current.phase
            });
            const transition = {
              ...decisionTransition,
              operationalStatus:
                decisionTransition.phase === "REASSESSING"
                  ? ("ACTIVE" as const)
                  : ("COMPLETED" as const)
            };
            const record = await dependencies.sessions.recordHumanDecision({
              decision,
              transition,
              event: {
                correlationId: decision.id,
                type: "SESSION_STATE_CHANGED",
                payload: {
                  phase: transition.phase,
                  operationalStatus: transition.operationalStatus,
                  currentConclusion: transition.conclusion,
                  humanDecision: decision
                }
              }
            });

            try {
              await eventBus.publishAfterCommit({
                append: async () => record.event
              });
            } catch (error) {
              request.log.error(
                { err: error },
                "Failed to publish human decision event"
              );
            }

            return {
              session: record.session,
              decision: record.decision,
              event: record.event
            };
          }
        );

        return reply.code(201).send(result.response);
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError
        ) {
          return reply.code(409).send({ error: error.message });
        }

        if (error instanceof HumanDecisionSessionNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }

        if (error instanceof InvalidSessionPhaseError) {
          return reply.code(409).send({ error: error.message });
        }

        throw error;
      }
    }
  );
}
