import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import {
  AgentRunNotFoundError,
  AgentRunNotRetryableError,
  AgentRunRetryLimitError,
  AgentRunRetryUnsupportedError,
  AgentRunService,
  AgentRunTerminalError
} from "../../research/agent-run-service";
import { CrossReviewInProgressError } from "../../research/cross-review-service";
import { actorName } from "./review";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function registerAgentRunRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "auth" | "agentRuns">,
  idempotency: IdempotencyStore
): void {
  const service: AgentRunService | undefined = dependencies.agentRuns;

  const notConfigured = (reply: {
    code: (c: number) => { send: (b: unknown) => unknown };
  }) => reply.code(501).send({ error: "Agent run service unavailable" });

  function guard(
    request: FastifyRequest,
    reply: {
      code: (c: number) => { send: (b: unknown) => unknown };
    },
    mode: "read" | "write"
  ): { user: ReturnType<NonNullable<AppDependencies["auth"]>["userFromRequest"]> } | null {
    const user = dependencies.auth?.userFromRequest(request) ?? null;
    if (dependencies.auth && !user) {
      reply.code(401).send({ error: "Authentication required" });
      return null;
    }
    if (mode === "write" && user?.role === "viewer") {
      reply.code(403).send({ error: "Reviewer role required" });
      return null;
    }
    return { user };
  }

  /** The run list — what the operations center shows first. */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/agent-runs",
    async (request, reply) => {
      if (!guard(request, reply, "read")) return;
      if (!service) return notConfigured(reply);
      const runs = await service.listRuns(request.params.id);
      return { runs };
    }
  );

  /** One run's detail, read-only, scoped to the session. */
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/sessions/:id/agent-runs/:runId",
    async (request, reply) => {
      if (!guard(request, reply, "read")) return;
      if (!service) return notConfigured(reply);
      try {
        const detail = await service.getRunDetail(
          request.params.id,
          request.params.runId
        );
        return detail;
      } catch (error) {
        if (error instanceof AgentRunNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  /** A run's event timeline, read from the session's execution log. */
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/sessions/:id/agent-runs/:runId/events",
    async (request, reply) => {
      if (!guard(request, reply, "read")) return;
      if (!service) return notConfigured(reply);
      try {
        const detail = await service.getRunDetail(
          request.params.id,
          request.params.runId
        );
        return { events: detail.events };
      } catch (error) {
        if (error instanceof AgentRunNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  /**
   * Cancels a run. Safe: only a `queued` or `running` run can be cancelled; a
   * terminal one (that is not already cancelled) is refused. Idempotent for an
   * already-cancelled run. A run in another session is a 404, never a 200.
   */
  app.post<{ Params: { id: string; runId: string } }>(
    "/api/sessions/:id/agent-runs/:runId/cancel",
    async (request, reply) => {
      const actor = guard(request, reply, "write");
      if (!actor) return;
      if (!service) return notConfigured(reply);
      const requestedBy = actorName(actor.user) ?? "unattributed";
      try {
        const result = await service.cancelRun(
          request.params.id,
          request.params.runId,
          requestedBy
        );
        return reply.code(200).send({
          run: result.run,
          alreadyCancelled: result.alreadyCancelled
        });
      } catch (error) {
        if (error instanceof AgentRunNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof AgentRunTerminalError) {
          return reply.code(409).send({
            error: error.message,
            code: "run_terminal",
            status: error.status
          });
        }
        throw error;
      }
    }
  );

  /**
   * Retries a failed cross-review run. Opens a new run (new id, higher attempt,
   * parent pointer) rather than mutating the failed one, and reuses the same
   * cross-examination engine. Bounded by `MAX_AGENT_RUN_RETRIES`; concurrency
   * is guarded by the cross-review service itself.
   */
  app.post<{ Params: { id: string; runId: string } }>(
    "/api/sessions/:id/agent-runs/:runId/retry",
    async (request, reply) => {
      const actor = guard(request, reply, "write");
      if (!actor) return;
      if (!service) return notConfigured(reply);
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const requestedBy = actorName(actor.user) ?? "unattributed";
      const { id, runId } = request.params;
      const requestHash = hashIdempotencyRequest({
        operation: "agent-run-retry",
        sessionId: id,
        runId
      });
      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          return service.retryRun(id, runId, requestedBy);
        });
        return reply.code(201).send(result.response);
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError ||
          error instanceof CrossReviewInProgressError ||
          error instanceof AgentRunNotRetryableError ||
          error instanceof AgentRunRetryLimitError
        ) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof AgentRunNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof AgentRunRetryUnsupportedError) {
          return reply.code(501).send({ error: error.message });
        }
        throw error;
      }
    }
  );
}
