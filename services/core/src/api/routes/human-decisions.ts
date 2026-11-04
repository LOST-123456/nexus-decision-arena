import {
  HumanDecisionConflictNotEligibleError,
  SessionNotInHumanReviewError,
  SupplementRoundLimitError
} from "@nexus/db";
import {
  DecisionWritebackError,
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
  dependencies: Pick<
    AppDependencies,
    "sessions" | "runSession" | "auth" | "events"
  >,
  idempotency: IdempotencyStore,
  eventBus: EventBus
): void {
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/human-decisions",
    async (request, reply) => {
      const authUser = dependencies.auth?.userFromRequest(request);
      if (dependencies.auth && !authUser) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (authUser?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
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
      const operatorId = authUser?.id ?? parsed.data.operatorId;
      const requestHash = hashIdempotencyRequest({
        operation: "record-human-decision",
        sessionId,
        body: { ...parsed.data, operatorId }
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
              operatorId,
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
          /**
           * 不在这里等这一轮跑完。
           *
           * 上一版是 `await runSession.start(...)`，于是整轮补充分析（逐条重新
           * 质询 + 作答）全部压在这一次 HTTP 请求上：真实模型下几分钟，浏览器
           * 一直转圈，用户看到的就是"点了要求补充分析就卡住"。裁决其实早在
           * 打开这个请求之前就已经落库了——把它挂在响应上没有任何好处。
           *
           * 现在立刻返回 201（会话已经是 REASSESSING，前端据此显示进行中与
           * 计时），分析在后台继续。失败不再能"返回给谁"，所以写一条
           * AGENT_RUN_FAILED 事件：审计包和时间线里还看得见，而不是静默消失。
           */
          void dependencies.runSession.start(sessionId).catch(async (error) => {
            request.log.error(
              { err: error, sessionId },
              "supplement round failed to start"
            );
            try {
              await eventBus.publishAfterCommit({
                append: () =>
                  dependencies.events.append({
                    sessionId,
                    correlationId: result.response.decision.id,
                    type: "AGENT_RUN_FAILED",
                    payload: {
                      stage: "supplement_round",
                      message:
                        error instanceof Error ? error.message : String(error)
                    }
                  })
              });
            } catch (publishError) {
              request.log.error(
                { err: publishError },
                "failed to record supplement failure"
              );
            }
          });
        }
        return reply.code(201).send(result.response);
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError ||
          error instanceof SessionNotInHumanReviewError ||
          error instanceof SupplementRoundLimitError ||
          error instanceof HumanDecisionConflictNotEligibleError ||
          error instanceof DecisionWritebackError
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
