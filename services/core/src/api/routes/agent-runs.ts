import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import {
  AgentRunAlreadyRetriedError,
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

  /** A run's event timeline, read straight from the execution log. */
  app.get<{ Params: { id: string; runId: string } }>(
    "/api/sessions/:id/agent-runs/:runId/events",
    async (request, reply) => {
      if (!guard(request, reply, "read")) return;
      if (!service) return notConfigured(reply);
      try {
        const events = await service.getRunEvents(
          request.params.id,
          request.params.runId
        );
        return { events };
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
   * already-cancelled run, and lease-guarded by `Idempotency-Key` so a
   * double-submit cannot produce two cancel requests for one decision.
   *
   * The response separates what is durable from what is not: `run.status` and
   * `statusChanged` are the database, `execution` is what this process managed
   * to do about the work in flight. Neither claims the executor has stopped —
   * only `AGENT_RUN_EXECUTION_STOPPED` in the run's timeline says that.
   *
   * `cancelledBy` is never read from the body: the actor comes from the
   * authenticated request, so a client cannot attribute a cancel to someone
   * else.
   */
  app.post<{
    Params: { id: string; runId: string };
    Body: { reason?: string } | undefined;
  }>(
    "/api/sessions/:id/agent-runs/:runId/cancel",
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
      const body = request.body;
      const reason =
        typeof body?.reason === "string" ? body.reason : null;
      const requestHash = hashIdempotencyRequest({
        operation: "agent-run-cancel",
        sessionId: id,
        runId
      });
      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const cancelled = await service.cancelRun(id, runId, requestedBy, {
            reason
          });
          return {
            run: cancelled.run,
            alreadyCancelled: cancelled.alreadyCancelled,
            statusChanged: cancelled.statusChanged,
            execution: cancelled.execution,
            previousStatus: cancelled.previousStatus,
            reason: cancelled.reason
          };
        });
        return reply.code(200).send(result.response);
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError
        ) {
          return reply.code(409).send({ error: error.message });
        }
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
   * Retries a failed cross-review run. Opens a new generation (new ids, higher
   * attempt, parent pointer) rather than mutating the failed one, and reuses
   * the same cross-examination engine.
   *
   * The response separates the two facts a retry actually produces:
   *
   * - `retry` is the lineage that was written **before** execution — the attempt
   *   number and the new run ids. It is present even when every new run failed,
   *   because the chain exists either way.
   * - `runs[].status` is what the executor then did with each of them.
   *
   * A refusal is never a 2xx: `409` with a `code` says whether the state was
   * wrong (`run_not_retryable`), the chain moved on (`already_retried`, with the
   * child to look at), or the budget is spent (`retry_limit`), and `501` says
   * the task type has no retry path at all. Nothing here creates a run it cannot
   * account for.
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
          error instanceof CrossReviewInProgressError
        ) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof AgentRunNotRetryableError) {
          return reply.code(409).send({
            error: error.message,
            code: "run_not_retryable",
            status: error.status
          });
        }
        if (error instanceof AgentRunAlreadyRetriedError) {
          return reply.code(409).send({
            error: error.message,
            code: "already_retried",
            childRunId: error.childRunId,
            deepestAttempt: error.deepestAttempt
          });
        }
        if (error instanceof AgentRunRetryLimitError) {
          return reply.code(409).send({
            error: error.message,
            code: "retry_limit",
            attempt: error.attempt,
            limit: error.limit
          });
        }
        if (error instanceof AgentRunNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof AgentRunRetryUnsupportedError) {
          return reply.code(501).send({
            error: error.message,
            code: "retry_unsupported",
            purpose: error.purpose
          });
        }
        throw error;
      }
    }
  );
}
