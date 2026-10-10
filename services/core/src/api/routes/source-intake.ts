import {
  describeFetchFailure,
  SourceImportError,
  type SourceImportService
} from "../../research/source-import-service";
import { SourceNotFoundError, SourceTitleConflictError } from "@nexus/db";
import { TargetRefusedError } from "../../research/ssrf-guard";
import { SourceSchema } from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { deriveUuidV7 } from "../plugins/deterministic-id";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Research intake routes: importing a page, reading what was stored, and
 * re-checking the excerpts that cite it.
 *
 * These are deliberately thin. Every safety decision — which address may be
 * contacted, how large a response may be, what counts as an anchor hit — lives
 * in the research service and the address guard, so the route only does the
 * things a route should: authentication, idempotency, request validation, and
 * mapping a failure onto a status code a researcher can act on.
 */

export const ImportSourceSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  /** Optional label; the page title is used when omitted. */
  title: z.string().trim().min(1).max(240).optional()
});

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function registerSourceIntakeRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "auth" | "evidence" | "sourceIntake">,
  idempotency: IdempotencyStore
): void {
  const actorOf = (
    request: FastifyRequest
  ): { user: ReturnType<NonNullable<AppDependencies["auth"]>["userFromRequest"]> } => ({
    user: dependencies.auth?.userFromRequest(request) ?? null
  });

  const actorName = (user: { displayName: string; username: string } | null): string =>
    user ? `${user.displayName} (${user.username})` : "unattributed";

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/sources/import",
    async (request, reply) => {
      const { user } = actorOf(request);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.sourceIntake || !dependencies.evidence) {
        return reply
          .code(501)
          .send({ error: "Page retrieval is not configured" });
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = ImportSourceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid import request",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "import-source",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const outcome = await dependencies.sourceIntake!.importUrl({
            sessionId,
            url: parsed.data.url,
            title: parsed.data.title,
            actor: actorName(user),
            // Ids are derived from the idempotency key, so a retry writes the
            // same rows instead of a second copy of the same import.
            sourceId: deriveUuidV7("source", key, requestHash),
            snapshotId: deriveUuidV7("source-snapshot", key, requestHash)
          });
          // The domain schema is applied here as well, so a row can never leave
          // the API in a shape the rest of the system would refuse.
          return {
            source: SourceSchema.parse({
              ...outcome.source,
              retrievalStatus: outcome.source.retrievalStatus ?? "fetched"
            }),
            snapshot: outcome.snapshot,
            versionCreated: outcome.versionCreated,
            reused: outcome.reused,
            truncated: outcome.truncated,
            redirects: outcome.redirects,
            finalUrl: outcome.finalUrl
          };
        });
        return reply.code(201).send(result.response);
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError
        ) {
          return reply.code(409).send({ error: error.message });
        }
        // The source row was written before this was raised, so the workspace
        // shows the failed attempt and its reason.
        if (error instanceof SourceImportError) {
          return reply
            .code(error.httpStatus)
            .send({ error: error.message, code: error.code });
        }
        if (error instanceof SourceTitleConflictError) {
          return reply.code(409).send({ error: error.message });
        }
        // Defence in depth: a refusal that escaped the service's own mapping
        // must still be reported as a refusal, never as a server fault.
        if (error instanceof TargetRefusedError) {
          const refusal = describeFetchFailure(error);
          return reply
            .code(refusal.httpStatus)
            .send({ error: refusal.message, code: refusal.code });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { id: string; sourceId: string } }>(
    "/api/sessions/:id/sources/:sourceId",
    async (request, reply) => {
      const { user } = actorOf(request);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.evidence) {
        return reply.code(501).send({ error: "Research storage unavailable" });
      }
      const { id: sessionId, sourceId } = request.params;
      // Every read is scoped to the session, so a source id from another
      // research task resolves to nothing rather than leaking its text.
      const source = await dependencies.evidence.getSource(sessionId, sourceId);
      if (!source) {
        return reply.code(404).send({ error: "Source not found" });
      }
      const [snapshots, excerpts, current] = await Promise.all([
        dependencies.evidence.listSnapshots(sessionId, sourceId),
        dependencies.evidence.listEvidenceForSource(sessionId, sourceId),
        dependencies.evidence.getCurrentSnapshot(sessionId, sourceId)
      ]);
      return { source, snapshots, excerpts, currentSnapshotId: current?.id ?? null };
    }
  );

  app.post<{ Params: { id: string; sourceId: string } }>(
    "/api/sessions/:id/sources/:sourceId/recheck",
    async (request, reply) => {
      const { user } = actorOf(request);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.sourceIntake) {
        return reply
          .code(501)
          .send({ error: "Page retrieval is not configured" });
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const { id: sessionId, sourceId } = request.params;
      const requestHash = hashIdempotencyRequest({
        operation: "recheck-source-excerpts",
        sessionId,
        sourceId
      });

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          dependencies.sourceIntake!.recheckExcerpts({
            sessionId,
            sourceId,
            actor: actorName(user)
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
        if (error instanceof SourceNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
    }
  );
}
