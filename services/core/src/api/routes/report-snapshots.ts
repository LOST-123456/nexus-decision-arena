import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { IdSchema } from "@nexus/shared";
import {
  ReportSnapshotNotFoundError,
  ReportSnapshotSessionNotFoundError
} from "@nexus/db";
import type { AppDependencies } from "../../app";
import { ReportPayloadFormatError } from "../../research/report-diff";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for immutable report versions: save one, list them, read one,
 * compare two, export one.
 *
 * The split is deliberate. Reads are viewer-safe — a version is a frozen
 * document, and reading one changes nothing. The only write is a save, and
 * it is reviewer-only, idempotent and attributed: the actor comes from the
 * server's own session, never from the request body, so a version's history
 * can always name the account that asked for it.
 *
 * Everything is scoped by session. A version belonging to another session
 * answers 404, exactly as if it did not exist — the same rule the rest of
 * the research surfaces follow.
 */

/** Why a version was saved. Optional, but never anonymous once given. */
const SaveSnapshotBodySchema = z.object({
  changeReason: z.string().trim().min(1).max(2000).optional()
});

const CompareQuerySchema = z.object({
  from: IdSchema,
  to: IdSchema
});

const SnapshotIdParamsSchema = z.object({
  id: IdSchema,
  snapshotId: IdSchema
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
  if (
    error instanceof ReportSnapshotNotFoundError ||
    error instanceof ReportSnapshotSessionNotFoundError
  ) {
    reply.code(404).send({ error: error.message });
    return true;
  }
  if (error instanceof ReportPayloadFormatError) {
    reply.code(422).send({ error: error.message });
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

export function registerReportSnapshotRoutes(
  app: FastifyInstance,
  dependencies: Pick<
    AppDependencies,
    "auth" | "sessions" | "reportSnapshots"
  >,
  idempotency: IdempotencyStore
): void {
  const service = dependencies.reportSnapshots;

  function guard(
    request: FastifyRequest,
    reply: { code: (c: number) => { send: (b: unknown) => unknown } },
    mode: "read" | "write"
  ): {
    user: ReturnType<NonNullable<AppDependencies["auth"]>["userFromRequest"]>;
  } | null {
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

  function notConfigured(
    reply: { code: (c: number) => { send: (b: unknown) => unknown } }
  ) {
    return reply
      .code(501)
      .send({ error: "Report snapshots are not configured" });
  }

  /**
   * Saves the current report as a new immutable version.
   *
   * The idempotency key is what makes a double submit the same version
   * instead of a second one, and the service honours it at the database
   * level too, so a retry after a restart still resolves to the version the
   * first attempt created.
   */
  app.post<{
    Params: { id: string };
    Body: { changeReason?: string };
  }>("/api/sessions/:id/report-snapshots", async (request, reply) => {
    const actor = guard(request, reply, "write");
    if (!actor) return;
    if (!service) return notConfigured(reply);
    const key = getIdempotencyKey(request);
    if (!key) {
      return reply
        .code(400)
        .send({ error: "Idempotency-Key header is required" });
    }
    const parsed = SaveSnapshotBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid report snapshot request",
        details: parsed.error.flatten()
      });
    }
    const sessionId = request.params.id;
    const requestHash = hashIdempotencyRequest({
      operation: "report-snapshot-create",
      sessionId,
      body: parsed.data
    });
    try {
      const snapshot = await idempotency.execute(key, requestHash, () =>
        service.createSnapshot({
          sessionId,
          actor: actorName(actor.user),
          ...(parsed.data.changeReason
            ? { changeReason: parsed.data.changeReason }
            : {}),
          idempotencyKey: key
        })
      );
      // `execute` answers with the stored envelope; the body is the version
      // it produced, whether this attempt created it or replayed an earlier one.
      return reply.code(201).send(snapshot.response);
    } catch (error) {
      if (mapServiceError(reply, error)) return undefined;
      throw error;
    }
  });

  /**
   * One page of a session's saved versions, newest first, without payloads.
   *
   * `snapshots` keeps its name and shape so every existing reader of this
   * endpoint keeps working; `nextCursor` / `hasNextPage` are additive. The
   * cursor is the `version` of the last item on the page — a value, not an
   * offset, so a version saved between two requests cannot shift a page.
   */
  app.get<{ Params: { id: string }; Querystring: { limit?: string; after?: string } }>(
    "/api/sessions/:id/report-snapshots",
    async (request, reply) => {
      const actor = guard(request, reply, "read");
      if (!actor) return;
      if (!service) return notConfigured(reply);
      const limit = request.query.limit === undefined
        ? undefined
        : Number(request.query.limit);
      if (limit !== undefined && !Number.isFinite(limit)) {
        return reply.code(400).send({ error: "limit must be a number" });
      }
      const after = request.query.after === undefined
        ? undefined
        : Number(request.query.after);
      if (after !== undefined && !Number.isFinite(after)) {
        return reply.code(400).send({ error: "after must be a version number" });
      }
      try {
        // Built field by field rather than passed as `{ limit, after }`:
        // `exactOptionalPropertyTypes` treats an explicit `undefined` as a
        // different thing from an absent key, and "the client said nothing"
        // must mean "page defaults", not "undefined".
        const page: { limit?: number; after?: number } = {};
        if (limit !== undefined) page.limit = limit;
        if (after !== undefined) page.after = after;
        const result = await service.listSnapshots(request.params.id, page);
        return {
          snapshots: result.items,
          nextCursor: result.nextCursor,
          hasNextPage: result.hasNextPage
        };
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /** One version, payload included — always the stored payload. */
  app.get<{ Params: { id: string; snapshotId: string } }>(
    "/api/sessions/:id/report-snapshots/:snapshotId",
    async (request, reply) => {
      const actor = guard(request, reply, "read");
      if (!actor) return;
      if (!service) return notConfigured(reply);
      const parsed = SnapshotIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Unknown report snapshot" });
      }
      try {
        return await service.getSnapshot(parsed.data.id, parsed.data.snapshotId);
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /**
   * Compares two versions.
   *
   * Both ids must belong to the session; a version from another session
   * answers 404 like any other unknown id.
   */
  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string };
  }>("/api/sessions/:id/report-snapshots/compare", async (request, reply) => {
    const actor = guard(request, reply, "read");
    if (!actor) return;
    if (!service) return notConfigured(reply);
    const parsed = CompareQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Comparing needs two snapshot ids: ?from=<id>&to=<id>",
        details: parsed.error.flatten()
      });
    }
    if (parsed.data.from === parsed.data.to) {
      return reply
        .code(400)
        .send({ error: "Comparing a version with itself has no result" });
    }
    try {
      return await service.compare(
        request.params.id,
        parsed.data.from,
        parsed.data.to
      );
    } catch (error) {
      if (mapServiceError(reply, error)) return undefined;
      throw error;
    }
  });

  /**
   * Exports one stored version.
   *
   * The body is rendered from the frozen payload, so an export never mixes
   * in material that arrived after the save. `download=1` turns it into an
   * attachment, exactly like the live report's markdown export.
   */
  app.get<{
    Params: { id: string; snapshotId: string };
    Querystring: { format?: string; download?: string };
  }>(
    "/api/sessions/:id/report-snapshots/:snapshotId/export",
    async (request, reply) => {
      const actor = guard(request, reply, "read");
      if (!actor) return;
      if (!service) return notConfigured(reply);
      const parsed = SnapshotIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Unknown report snapshot" });
      }
      const format = request.query.format === "html" ? "html" : "markdown";
      try {
        const exported = await service.exportSnapshot(
          parsed.data.id,
          parsed.data.snapshotId,
          format
        );
        if (request.query.download === "1") {
          reply.header(
            "content-disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`
          );
        }
        reply.type(exported.contentType);
        return exported.body;
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );
}
