import { newId } from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { InMemoryIdempotencyStore } from "../plugins/idempotency";

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

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function registerSessionRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  idempotency: InMemoryIdempotencyStore
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

    const requestHash = InMemoryIdempotencyStore.hash({
      operation: "create-session",
      body: parsed.data
    });
    const stored = await idempotency.get(key, requestHash);
    if (stored) {
      return reply.code(201).send(stored.response);
    }

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

    await idempotency.save(key, requestHash, created);
    return reply.code(201).send(created);
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
      const requestHash = InMemoryIdempotencyStore.hash({
        operation: "start-session",
        sessionId
      });
      const stored = await idempotency.get(key, requestHash);
      if (stored) {
        return reply.code(202).send(stored.response);
      }

      const session = await dependencies.sessions.getById(sessionId);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      await dependencies.runSession.start(sessionId);
      const response = { id: sessionId, status: "STARTED" };
      await idempotency.save(key, requestHash, response);
      return reply.code(202).send(response);
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      const session = await dependencies.sessions.getById(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }

      return reply.send(session);
    }
  );
}
