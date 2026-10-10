import { CandidateNotFoundError, SourceNotFoundError } from "@nexus/db";
import { CandidateDecisionSchema } from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import {
  ClaimExtractionError,
  type ClaimExtractionService
} from "../../research/claim-extraction-service";
import { deriveUuidV7 } from "../plugins/deterministic-id";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for proposing claims from a saved page.
 *
 * Thin on purpose. Everything that decides what a suggestion means — how the
 * page is split, what may be asked of the model, whether a quote really appears
 * in the capture — lives in the extraction service. These handlers only do the
 * parts a handler should: authentication, authorization, idempotency, request
 * validation, and turning a failure into a status code a researcher can act on.
 *
 * Note that accepting a candidate is *not* handled here beyond recording the
 * ruling. The rows themselves are created by the ordinary claim and evidence
 * endpoints, so there is exactly one write path into the domain.
 */

export const CandidateDecisionsSchema = z.object({
  decisions: z.array(CandidateDecisionSchema).min(1).max(200)
});

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

function actorName(user: { displayName: string; username: string } | null): string {
  return user ? `${user.displayName} (${user.username})` : "unattributed";
}

/**
 * Ties generation to the client still being there.
 *
 * An analysis can take a while, and continuing to spend tokens on a request
 * whose socket already closed answers nothing for anybody.
 */
function clientDisconnected(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.once("close", () => controller.abort());
  return controller.signal;
}

export function registerClaimExtractionRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "auth" | "claimExtraction">,
  idempotency: IdempotencyStore
): void {
  const notConfigured = (
    reply: { code: (c: number) => { send: (b: unknown) => unknown } }
  ) => reply.code(501).send({ error: "Claim extraction is not configured" });

  app.post<{ Params: { id: string; sourceId: string } }>(
    "/api/sessions/:id/sources/:sourceId/extract-claims",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.claimExtraction) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }

      const sessionId = request.params.id;
      const sourceId = request.params.sourceId;
      // Ids derive from the idempotency key, so replaying the request re-addresses
      // the same analysis instead of starting a second one.
      const runId = deriveUuidV7("claim-extraction", key, `${sessionId}:${sourceId}`);
      const requestHash = hashIdempotencyRequest({
        operation: "extract-claims",
        sessionId,
        sourceId
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.claimExtraction!.extract({
            sessionId,
            sourceId,
            actor: actorName(user),
            correlationId: runId,
            runId,
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
        // A page that was never captured, or was captured empty, is an unmet
        // precondition rather than a fault: the message tells the researcher
        // what to do next.
        if (error instanceof ClaimExtractionError) {
          return reply
            .code(error.httpStatus)
            .send({ error: error.message, code: error.code });
        }
        if (error instanceof SourceNotFoundError) {
          return reply.code(404).send({ error: "Source not found" });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { id: string }; Querystring: { sourceId?: string } }>(
    "/api/sessions/:id/extraction-runs",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.claimExtraction) {
        return notConfigured(reply);
      }
      const { sourceId } = request.query;
      const runs = await dependencies.claimExtraction.listRuns(
        request.params.id,
        sourceId ? { sourceId } : {}
      );
      return { runs };
    }
  );

  app.get<{ Params: { id: string; runId: string } }>(
    "/api/sessions/:id/extraction-runs/:runId",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.claimExtraction) {
        return notConfigured(reply);
      }
      const result = await dependencies.claimExtraction.getResult(
        request.params.id,
        request.params.runId
      );
      if (!result) {
        return reply.code(404).send({ error: "Extraction run not found" });
      }
      return result;
    }
  );

  app.post<{ Params: { id: string; runId: string } }>(
    "/api/sessions/:id/extraction-runs/:runId/decisions",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.claimExtraction) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = CandidateDecisionsSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid candidate decision",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const runId = request.params.runId;

      // Scoped read first. A run from another research task has to answer "not
      // found" rather than a fault — both because its existence is none of this
      // caller's business, and because a 500 here would invite a retry that can
      // never succeed.
      const run = await dependencies.claimExtraction.getRun(sessionId, runId);
      if (!run) {
        return reply.code(404).send({ error: "Extraction run not found" });
      }

      const requestHash = hashIdempotencyRequest({
        operation: "candidate-decisions",
        sessionId,
        runId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.claimExtraction!.recordDecisions({
            sessionId,
            runId,
            decisions: parsed.data.decisions,
            decidedBy: actorName(user),
            correlationId: deriveUuidV7("candidate-decisions", key, requestHash)
          })
        );
        return result.response;
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError
        ) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof ClaimExtractionError) {
          return reply
            .code(error.httpStatus)
            .send({ error: error.message, code: error.code });
        }
        // A candidate outside this run is absent, not an error: the routes
        // answer with 404 for anything scoped to another session.
        if (error instanceof CandidateNotFoundError) {
          return reply.code(404).send({ error: "Candidate not found" });
        }
        throw error;
      }
    }
  );
}
