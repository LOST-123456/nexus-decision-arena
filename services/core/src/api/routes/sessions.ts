import { deriveUuidV7 } from "../plugins/deterministic-id";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { SessionAlreadyStartedError } from "../../arena/run-session";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

export const CreateSessionSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    summary: z.string().min(1),
    targetUsers: z.string().min(1),
    businessModel: z.string().min(1),
    expectedData: z.string().min(1)
  }),
  locale: z.enum(["zh-CN", "en-US"]).default("zh-CN")
});

class SessionNotFoundError extends Error {
  constructor() {
    super("Session not found");
    this.name = "SessionNotFoundError";
  }
}

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  idempotency: IdempotencyStore
): void {
  app.get<{ Querystring: { limit?: string } }>(
    "/api/sessions",
    async (request, reply) => {
      if (!dependencies.sessionHistory) {
        return reply.code(501).send({ error: "Session history unavailable" });
      }
      const requested = Number(request.query.limit ?? 50);
      const limit = Number.isFinite(requested) ? requested : 50;
      return dependencies.sessionHistory.listSummaries(limit);
    }
  );

  app.post("/api/sessions", async (request, reply) => {
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

    const parsed = CreateSessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid session request",
        details: parsed.error.flatten()
      });
    }

    const requestHash = hashIdempotencyRequest({
      operation: "create-session",
      body: parsed.data
    });

    try {
      const result = await idempotency.execute(key, requestHash, async () => {
        const projectId = deriveUuidV7("project", key, requestHash);
        const sessionId = deriveUuidV7("session", key, requestHash);
        const created = await dependencies.sessions.createWithProject(
          parsed.data.project,
          {
            id: sessionId,
            projectId,
            locale: parsed.data.locale,
            phase: "CREATED",
            operationalStatus: "ACTIVE",
            currentConclusion: null
          }
        );

        if (!created) {
          throw new Error("Session creation failed");
        }

        return created;
      });

      return reply.code(201).send(result.response);
    } catch (error) {
      if (
        error instanceof IdempotencyConflictError ||
        error instanceof IdempotencyTimeoutError
      ) {
        return reply.code(409).send({ error: error.message });
      }

      throw error;
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/start",
    async (request, reply) => {
      const startAuthUser = dependencies.auth?.userFromRequest(request);
      if (dependencies.auth && !startAuthUser) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (startAuthUser?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "start-session",
        sessionId
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const session = await dependencies.sessions.getById(sessionId);
          if (!session) {
            throw new SessionNotFoundError();
          }

          await dependencies.runSession.start(sessionId);
          return { id: sessionId, status: "STARTED" };
        });

        return reply.code(202).send(result.response);
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError
        ) {
          return reply.code(409).send({ error: error.message });
        }

        if (error instanceof SessionNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }

        if (error instanceof SessionAlreadyStartedError) {
          const session = await dependencies.sessions.getById(sessionId);
          if (session && session.phase !== "CREATED") {
            return reply
              .code(202)
              .send({ id: sessionId, status: "ALREADY_STARTED" });
          }
          return reply.code(409).send({ error: error.message });
        }

        throw error;
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      const view = await dependencies.sessions.getView(request.params.id);
      if (!view) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return reply.send(view);
    }
  );
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      const deleteAuthUser = dependencies.auth?.userFromRequest(request);
      if (dependencies.auth && deleteAuthUser?.role !== "owner") {
        return reply.code(403).send({ error: "Owner role required" });
      }
      if (!dependencies.sessionHistory) {
        return reply.code(501).send({ error: "Session history unavailable" });
      }
      const deleted = await dependencies.sessionHistory.deleteById(request.params.id);
      if (!deleted) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return reply.code(204).send();
    }
  );

}
