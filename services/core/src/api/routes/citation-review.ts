import {
  CitationCorrectionDraftSchema,
  isCorrectableIntegrityStatus,
  isCorrectableSupportStatus
} from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import {
  CitationReviewError,
  type CitationReviewService
} from "../../research/citation-review-service";
import { deriveUuidV7 } from "../plugins/deterministic-id";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for citation integrity (A) and claim-evidence support (B).
 *
 * These handlers decide nothing about a citation. They authenticate,
 * authorize, validate the request shape, and translate a service failure into
 * a status code. Whether a quote resolves, and whether it bears on a claim, is
 * decided in the service against stored captures.
 *
 * The one rule worth stating here: none of these endpoints can verify an
 * excerpt. There is no request body that sets `verificationStatus`, and the
 * service has no write path to it. Support assessment is advice; verification
 * stays a human act through the existing evidence endpoints.
 */

const CheckRequestSchema = z
  .object({
    evidenceIds: z.array(z.string().uuid()).max(200).optional()
  })
  .optional();

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

function clientDisconnected(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  return controller.signal;
}

export function registerCitationReviewRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "auth" | "citationReview">,
  idempotency: IdempotencyStore
): void {
  const notConfigured = (
    reply: { code: (c: number) => { send: (b: unknown) => unknown } }
  ) => reply.code(501).send({ error: "Citation review is not configured" });

  /* A. Re-check every citation against the stored captures. */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/citations/check",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.citationReview) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }

      // No body is not "empty JSON": declaring a content type we did not send
      // makes Fastify reject the request before it reaches this handler.
      const parsed =
        request.body === undefined || request.body === null
          ? { success: true as const, data: undefined }
          : CheckRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid citation check request",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "citation-integrity-check",
        sessionId,
        body: parsed.data ?? null
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.citationReview!.checkIntegrity({
            sessionId,
            ...(parsed.data?.evidenceIds
              ? { evidenceIds: parsed.data.evidenceIds }
              : {}),
            actor: actorName(user),
            correlationId: deriveUuidV7("citation-check", key, requestHash)
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
        if (error instanceof CitationReviewError) {
          return reply
            .code(error.httpStatus)
            .send({ error: error.message, code: error.code });
        }
        throw error;
      }
    }
  );

  /* B. Compare one claim against the excerpts attached to it. */
  app.post<{ Params: { id: string; claimId: string } }>(
    "/api/sessions/:id/claims/:claimId/support-assessment",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.citationReview) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }

      const sessionId = request.params.id;
      const claimId = request.params.claimId;
      const requestHash = hashIdempotencyRequest({
        operation: "claim-support-assessment",
        sessionId,
        claimId
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.citationReview!.assessSupport({
            sessionId,
            claimId,
            actor: actorName(user),
            correlationId: deriveUuidV7("support-assessment", key, requestHash),
            signal: clientDisconnected(request)
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
        if (error instanceof CitationReviewError) {
          return reply
            .code(error.httpStatus)
            .send({ error: error.message, code: error.code });
        }
        throw error;
      }
    }
  );

  /* What is currently concluded about every citation in this session. */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/citations",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.citationReview) {
        return notConfigured(reply);
      }
      return dependencies.citationReview.getSnapshot(request.params.id);
    }
  );

  /* History of one excerpt's checks, or of one (claim, excerpt) assessment. */
  app.get<{
    Params: { id: string };
    Querystring: { kind?: string; evidenceId?: string; claimId?: string };
  }>("/api/sessions/:id/citations/history", async (request, reply) => {
    const { user } = actorOf(request, dependencies);
    if (dependencies.auth && !user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!dependencies.citationReview) {
      return notConfigured(reply);
    }
    const { kind, evidenceId, claimId } = request.query;
    if (kind === "integrity" && evidenceId) {
      return {
        kind,
        items: await dependencies.citationReview.history(request.params.id, {
          kind: "integrity",
          evidenceId
        })
      };
    }
    if (kind === "support" && evidenceId && claimId) {
      return {
        kind,
        items: await dependencies.citationReview.history(request.params.id, {
          kind: "support",
          claimId,
          evidenceId
        })
      };
    }
    return reply
      .code(400)
      .send({ error: "kind, evidenceId (and claimId for support) are required" });
  });

  /*
   * A human correction.
   *
   * Stored as a new record that points back at what it replaced, so "who
   * changed this, from what, and why" stays answerable. Nothing here edits the
   * earlier conclusion.
   */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/citation-corrections",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.citationReview) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }

      const parsed = CitationCorrectionDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid citation correction",
          details: parsed.error.flatten()
        });
      }
      const { kind, targetId, status, rationale } = parsed.data;
      const valid =
        kind === "integrity"
          ? isCorrectableIntegrityStatus(status)
          : isCorrectableSupportStatus(status);
      if (!valid) {
        return reply
          .code(400)
          .send({ error: `Unsupported ${kind} status: ${status}` });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "citation-correction",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.citationReview!.correct({
            sessionId,
            kind,
            targetId,
            status,
            rationale,
            actor: actorName(user),
            correlationId: deriveUuidV7("citation-correction", key, requestHash)
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
        if (error instanceof CitationReviewError) {
          return reply
            .code(error.httpStatus)
            .send({ error: error.message, code: error.code });
        }
        throw error;
      }
    }
  );
}
