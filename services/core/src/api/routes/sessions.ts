import { newId } from "@nexus/shared";
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
  app.post("/api/sessions", async (request, reply) => {
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
        const projectId = newId();
        const sessionId = newId();
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
}
