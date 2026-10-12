import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SourceNotFoundError } from "@nexus/db";
import { RevalidationTaskNotFoundError } from "@nexus/db";
import type { AppDependencies } from "../../app";
import {
  RevalidationTaskStateError,
  SourceMonitorService
} from "../../research/source-monitor-service";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for source monitoring and re-check tasks.
 *
 * Six endpoints, and the split is deliberate: reads are viewer-safe (the
 * monitoring panel, the diff and the task list show what the workspace
 * already shows), writes are reviewer-only and idempotent (a check costs a
 * network request, a resolution is a decision). Everything is scoped by
 * session — a task or a source from another session answers 404, exactly as
 * if it did not exist.
 *
 * Nothing here can change a verification status or a verdict. The only writes
 * are a check trail row, a stored capture of a page that genuinely moved, and
 * a task a person closes with a reason.
 */

/** Closing or moving a task. A reason is mandatory for a closing status. */
const ResolveTaskBodySchema = z.object({
  status: z.enum(["in_review", "resolved", "dismissed"]),
  note: z.string().trim().min(1).max(2000).optional()
});

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

function actorName(
  user: { displayName: string; username: string } | null
): string {
  return user ? `${user.displayName} (${user.username})` : "unattributed";
}

function mapServiceError(reply: {
  code: (c: number) => { send: (b: unknown) => unknown };
}, error: unknown): boolean {
  if (error instanceof RevalidationTaskStateError) {
    reply
      .code(error.httpStatus)
      .send({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof SourceNotFoundError) {
    reply.code(404).send({ error: error.message });
    return true;
  }
  if (error instanceof RevalidationTaskNotFoundError) {
    reply.code(404).send({ error: error.message });
    return true;
  }
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof IdempotencyTimeoutError ||
    error instanceof IdempotencyLeaseLostError
  ) {
    reply.code(409).send({ error: error.message });
    return true;
  }
  return false;
}

export function registerSourceMonitoringRoutes(
  app: FastifyInstance,
  dependencies: Pick<
    AppDependencies,
    "auth" | "sessions" | "evidence" | "sourceMonitor"
  >,
  idempotency: IdempotencyStore
): void {
  const service = dependencies.sourceMonitor;

  function guard(
    request: FastifyRequest,
    reply: { code: (c: number) => { send: (b: unknown) => unknown } },
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

  /**
   * Checks one source for drift.
   *
   * A POST with no body: the act of checking is the request, and the client
   * sends no content type at all (a JSON content type with an empty body is
   * refused before the route runs). The idempotency key makes a double
   * submit the same check rather than a second network request.
   */
  app.post<{ Params: { id: string; sourceId: string } }>(
    "/api/sessions/:id/sources/:sourceId/check",
    async (request, reply) => {
      const actor = guard(request, reply, "write");
      if (!actor) return;
      if (!service) {
        return reply
          .code(501)
          .send({ error: "Source monitoring is not configured" });
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "source-check",
        sessionId,
        sourceId: request.params.sourceId
      });
      try {
        // A replay answers with the stored outcome, so a double-submitted
        // check never spends the budget or re-fetches the page twice.
        const result = await idempotency.execute(key, requestHash, () =>
          service.checkSource({
            sessionId,
            sourceId: request.params.sourceId,
            actor: actorName(actor.user)
          })
        );
        return result.response;
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /** The monitoring panel for one source: status, versions, open work. */
  app.get<{ Params: { id: string; sourceId: string } }>(
    "/api/sessions/:id/sources/:sourceId/monitoring",
    async (request, reply) => {
      const actor = guard(request, reply, "read");
      if (!actor) return;
      if (!service) {
        return reply
          .code(501)
          .send({ error: "Source monitoring is not configured" });
      }
      try {
        return await service.getMonitoring(
          request.params.id,
          request.params.sourceId
        );
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /** The comparison between the two most recent versions of one source. */
  app.get<{ Params: { id: string; sourceId: string } }>(
    "/api/sessions/:id/sources/:sourceId/diff",
    async (request, reply) => {
      const actor = guard(request, reply, "read");
      if (!actor) return;
      if (!service) {
        return reply
          .code(501)
          .send({ error: "Source monitoring is not configured" });
      }
      try {
        return await service.getDiff(
          request.params.id,
          request.params.sourceId
        );
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /** Every re-check task in a session, newest first. */
  app.get<{
    Params: { id: string };
    Querystring: { status?: string };
  }>("/api/sessions/:id/revalidation-tasks", async (request, reply) => {
    const actor = guard(request, reply, "read");
    if (!actor) return;
    if (!service) {
      return reply
        .code(501)
        .send({ error: "Source monitoring is not configured" });
    }
    const status = request.query.status;
    if (
      status !== undefined &&
      !["open", "in_review", "resolved", "dismissed"].includes(status)
    ) {
      return reply.code(400).send({ error: "Unknown task status filter" });
    }
    try {
      const tasks = await service.listTasks(request.params.id, {
        ...(status
          ? { status: status as "open" | "in_review" | "resolved" | "dismissed" }
          : {})
      });
      return { tasks };
    } catch (error) {
      if (mapServiceError(reply, error)) return undefined;
      throw error;
    }
  });

  /** One task with its history and the material it names. */
  app.get<{ Params: { id: string; taskId: string } }>(
    "/api/sessions/:id/revalidation-tasks/:taskId",
    async (request, reply) => {
      const actor = guard(request, reply, "read");
      if (!actor) return;
      if (!service) {
        return reply
          .code(501)
          .send({ error: "Source monitoring is not configured" });
      }
      try {
        return await service.getTaskDetail(
          request.params.id,
          request.params.taskId
        );
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /**
   * Moves a task on a person's instruction.
   *
   * The actor comes from the server's own session, never from the body: who
   * closed a re-check is a fact about the account that asked, and a body that
   * could name someone else would make the history worthless.
   */
  app.post<{ Params: { id: string; taskId: string } }>(
    "/api/sessions/:id/revalidation-tasks/:taskId/resolve",
    async (request, reply) => {
      const actor = guard(request, reply, "write");
      if (!actor) return;
      if (!service) {
        return reply
          .code(501)
          .send({ error: "Source monitoring is not configured" });
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = ResolveTaskBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid revalidation task transition",
          details: parsed.error.flatten()
        });
      }
      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "revalidation-task-resolve",
        sessionId,
        taskId: request.params.taskId,
        body: parsed.data
      });
      try {
        const result = await idempotency.execute(key, requestHash, () =>
          service.resolveTask({
            sessionId,
            taskId: request.params.taskId,
            status: parsed.data.status,
            ...(parsed.data.note ? { note: parsed.data.note } : {}),
            actor: actorName(actor.user)
          })
        );
        return result.response;
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );
}
