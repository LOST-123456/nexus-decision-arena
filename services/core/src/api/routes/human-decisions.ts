import {
  HumanDecisionConflictNotEligibleError,
  SessionNotInHumanReviewError,
  SupplementRoundLimitError
} from "@nexus/db";
import {
  HumanDecisionSchema,
  type HumanDecision
} from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import { applyHumanDecision } from "../../checkpoints/human-checkpoint";
import { deriveUuidV7 } from "../plugins/deterministic-id";
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
  createdAt: true,
  previousConclusion: true
});

class HumanDecisionSessionNotFoundError extends Error {
  constructor() {
    super("Session not found");
    this.name = "HumanDecisionSessionNotFoundError";
  }
}

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function registerHumanDecisionRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "sessions" | "runSession">,
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
            if (current.phase !== "HUMAN_REVIEW") {
              throw new SessionNotInHumanReviewError();
            }

            const decision: HumanDecision = {
              id: deriveUuidV7(
                "human-decision",
                key,
                requestHash
              ),
              sessionId,
              ...parsed.data,
              previousConclusion:
                current.currentConclusion ?? "No prior conclusion",
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

        if (result.response.decision.action !== "request_more_analysis") {
          return reply.code(201).send(result.response);
        }

        const currentAfterDecision = await dependencies.sessions.getById(
          sessionId
        );
        if (currentAfterDecision?.phase === "REASSESSING") {
          await dependencies.runSession.start(sessionId);
        }
        const finalSession =
          (await dependencies.sessions.getById(sessionId)) ??
          currentAfterDecision ??
          result.response.session;
        return reply
          .code(201)
          .send({ ...result.response, session: finalSession });
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError ||
          error instanceof SessionNotInHumanReviewError ||
          error instanceof SupplementRoundLimitError ||
          error instanceof HumanDecisionConflictNotEligibleError
        ) {
          return reply.code(409).send({ error: error.message });
        }

        if (error instanceof HumanDecisionSessionNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }

        throw error;
      }
    }
  );
}
