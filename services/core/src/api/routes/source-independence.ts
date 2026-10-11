import {
  SourceProfileOverrideDraftSchema,
  SourceRelationDraftSchema
} from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import {
  SourceIndependenceError,
  type SourceIndependenceService
} from "../../research/source-independence-service";
import { deriveUuidV7 } from "../plugins/deterministic-id";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for source independence.
 *
 * These handlers decide nothing about a source. They authenticate, authorize,
 * validate the request shape, and translate a service failure into a status
 * code. Which pages are the same information — and which a person has ruled on
 * — is worked out in the service from stored sources and captures.
 *
 * The rule worth stating here: nothing here can make a source authoritative or
 * verify an excerpt. There is no request body that sets a reliability score or
 * a `verificationStatus`; a person may state a relation, and that is all.
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

export function registerSourceIndependenceRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "auth" | "sourceIndependence">,
  idempotency: IdempotencyStore
): void {
  const notConfigured = (
    reply: { code: (c: number) => { send: (b: unknown) => unknown } }
  ) => reply.code(501).send({ error: "Source analysis is not configured" });

  /* The computed reading: profiles, links and the independence count. */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/sources/analysis",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.sourceIndependence) {
        return notConfigured(reply);
      }
      return dependencies.sourceIndependence.analyze(request.params.id);
    }
  );

  /* A person's ruling about a pair of sources. */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/source-relations",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.sourceIndependence) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = SourceRelationDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid source relation",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "source-relation",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.sourceIndependence!.declareRelation({
            sessionId,
            draft: parsed.data,
            relationId: deriveUuidV7("source-relation", key, requestHash),
            actor: actorName(user)
          })
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
        if (error instanceof SourceIndependenceError) {
          return reply
            .code(error.httpStatus)
            .send({ error: error.message, code: error.code });
        }
        throw error;
      }
    }
  );

  /* A person's override of one source's provenance kind. */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/source-profile-overrides",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.sourceIndependence) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = SourceProfileOverrideDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid source profile override",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "source-profile-override",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.sourceIndependence!.overrideProfile({
            sessionId,
            draft: parsed.data,
            overrideId: deriveUuidV7("source-profile-override", key, requestHash),
            actor: actorName(user)
          })
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
        if (error instanceof SourceIndependenceError) {
          return reply
            .code(error.httpStatus)
            .send({ error: error.message, code: error.code });
        }
        throw error;
      }
    }
  );

  /* Every statement ever made about a pair, so a correction is readable. */
  app.get<{
    Params: { id: string };
    Querystring: { firstSourceId?: string; secondSourceId?: string };
  }>("/api/sessions/:id/source-relations/history", async (request, reply) => {
    const { user } = actorOf(request, dependencies);
    if (dependencies.auth && !user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!dependencies.sourceIndependence) {
      return notConfigured(reply);
    }
    const { firstSourceId, secondSourceId } = request.query;
    if (!firstSourceId || !secondSourceId) {
      return reply
        .code(400)
        .send({ error: "firstSourceId and secondSourceId are required" });
    }
    return {
      items: await dependencies.sourceIndependence.relationHistory({
        sessionId: request.params.id,
        firstSourceId,
        secondSourceId
      })
    };
  });

  /* Every override ever made for one source, newest first. */
  app.get<{
    Params: { id: string };
    Querystring: { sourceId?: string };
  }>("/api/sessions/:id/source-profile-overrides/history", async (request, reply) => {
    const { user } = actorOf(request, dependencies);
    if (dependencies.auth && !user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!dependencies.sourceIndependence) {
      return notConfigured(reply);
    }
    const { sourceId } = request.query;
    if (!sourceId) {
      return reply.code(400).send({ error: "sourceId is required" });
    }
    return {
      items: await dependencies.sourceIndependence.profileHistory(
        request.params.id,
        sourceId
      )
    };
  });
}
