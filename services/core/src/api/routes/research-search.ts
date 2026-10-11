import { z } from "zod";
import { ResearchSearchTaskDraftSchema } from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import {
  ResearchSearchError,
  ResearchSearchService
} from "../../research/research-search-service";
import { DeterministicSearchProvider } from "../../research/search-provider";
import {
  ResearchSearchTaskNotFoundError
} from "@nexus/db";
import { deriveUuidV7 } from "../plugins/deterministic-id";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for the controlled research search.
 *
 * Four operations, all explicit: create-and-run a task, read it (with the
 * candidates it surfaced), approve its candidates (each becomes a *source*, never
 * evidence), or reject them. There is no endpoint that produces evidence, and no
 * endpoint that hides the human in the loop — the approve step is the human.
 */

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

function actorOf(
  request: FastifyRequest,
  dependencies: Pick<AppDependencies, "auth">
): { user: ReturnType<NonNullable<AppDependencies["auth"]>["userFromRequest"]> } {
  return { user: dependencies.auth?.userFromRequest(request) ?? null };
}

function actorName(
  user: { displayName: string; username: string } | null
): string {
  return user ? `${user.displayName} (${user.username})` : "unattributed";
}

type SearchRouteDependencies = Pick<
  AppDependencies,
  "auth" | "evidence" | "researchSearch" | "searchProvider"
>;

function searchService(
  dependencies: SearchRouteDependencies
): ResearchSearchService | null {
  if (!dependencies.researchSearch || !dependencies.evidence) {
    return null;
  }
  return new ResearchSearchService({
    search: dependencies.researchSearch,
    material: dependencies.evidence,
    // Honest by construction: the production provider is deterministic and
    // network-free. Tests inject their own (incl. a failing one).
    provider: dependencies.searchProvider ?? new DeterministicSearchProvider()
  });
}

function notConfigured(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } }
) {
  return reply.code(501).send({ error: "Research search is not configured" });
}

function mapServiceError(
  reply: {
    code: (c: number) => { send: (b: unknown) => unknown };
  },
  error: unknown
): boolean {
  if (error instanceof ResearchSearchError) {
    reply
      .code(error.httpStatus)
      .send({ error: error.message, code: error.code });
    return true;
  }
  if (
    error instanceof ResearchSearchTaskNotFoundError ||
    (error instanceof Error && error.name === "ResearchSearchTaskNotFoundError")
  ) {
    reply.code(404).send({ error: "Search task not found", code: "search_task_not_found" });
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

export function registerResearchSearchRoutes(
  app: FastifyInstance,
  dependencies: SearchRouteDependencies,
  idempotency: IdempotencyStore
): void {
  /* Creates a search task and runs the controlled search. */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/research-search-tasks",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      const service = searchService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = ResearchSearchTaskDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid research search task draft",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "research-search-create",
        sessionId,
        body: parsed.data
      });
      const taskId = deriveUuidV7("research-search-task", key, requestHash);

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          service.createAndRun({
            sessionId,
            draft: parsed.data,
            taskId,
            actor: actorName(user)
          })
        );
        if (!result.response) {
          return reply.code(404).send({ error: "Session not found" });
        }
        // A failed search is recorded (status=failed) but the request itself
        // is a 422: the task was created, the search just did not succeed.
        if (result.response.task.status === "failed") {
          return reply
            .code(422)
            .send({ ...result.response, code: "search_failed" });
        }
        return reply.code(201).send(result.response);
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Lists every search task for the session with candidate counts. */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/research-search-tasks",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = searchService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      try {
        return {
          tasks: await service.listSearchTasks({ sessionId: request.params.id })
        };
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Reads a task with the candidates it surfaced. */
  app.get<{ Params: { id: string; taskId: string } }>(
    "/api/sessions/:id/research-search-tasks/:taskId",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = searchService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      try {
        return await service.getSearchTask({
          sessionId: request.params.id,
          taskId: request.params.taskId
        });
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Approves a completed task: each candidate becomes a Source (never evidence). */
  app.post<{ Params: { id: string; taskId: string } }>(
    "/api/sessions/:id/research-search-tasks/:taskId/approve",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      const service = searchService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "research-search-approve",
        sessionId,
        taskId: request.params.taskId
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          service.approve({
            sessionId,
            taskId: request.params.taskId,
            actor: actorName(user)
          })
        );
        if (!result.response) {
          return reply.code(404).send({ error: "Search task not found" });
        }
        return result.response;
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Rejects a task's candidates without registering any source. */
  app.post<{ Params: { id: string; taskId: string } }>(
    "/api/sessions/:id/research-search-tasks/:taskId/reject",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      const service = searchService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "research-search-reject",
        sessionId,
        taskId: request.params.taskId
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          service.reject({
            sessionId,
            taskId: request.params.taskId,
            actor: actorName(user)
          })
        );
        if (!result.response) {
          return reply.code(404).send({ error: "Search task not found" });
        }
        return result.response;
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );
}
