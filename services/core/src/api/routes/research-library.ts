import {
  GrantAlreadyExistsError,
  GrantAlreadyRevokedError,
  GrantNotFoundError,
  LibraryDuplicateSourceError
} from "@nexus/db";
import {
  LibrarySearchFiltersSchema,
  ShareGrantDraftSchema,
  ShareGrantRevokeSchema
} from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import type { AuthUser } from "../../auth";
import {
  LibraryGrantExistsError,
  LibraryGrantNotFoundError,
  LibraryGrantNotPermittedError,
  LibraryNotVisibleError,
  LibrarySessionNotFoundError,
  LibrarySnapshotNotVisibleError,
  LibrarySourceHasNoCaptureError,
  LibrarySubjectNotFoundError,
  LibraryViewerForbiddenError,
  SourceLibraryService,
  type GrantSubjectResolver,
  type LibraryCaller
} from "../../research/source-library-service";
import { deriveUuidV7 } from "../plugins/deterministic-id";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for the cross-research library.
 *
 * The whole surface is built around one rule: material belongs to the
 * research it was collected in. Reads are scoped to the sessions the caller
 * owns or holds a live grant for; writes (grants, copies) are attributed to
 * the server-side identity and audited in the session they touch. An id the
 * caller may not see answers 404 — the same answer an unknown id gets — so
 * the API cannot be used to probe for existence.
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

function actorName(user: { displayName: string; username: string } | null): string {
  return user ? `${user.displayName} (${user.username})` : "unattributed";
}

type LibraryRouteDependencies = Pick<AppDependencies, "auth" | "sourceLibrary">;

function libraryService(
  dependencies: LibraryRouteDependencies
): SourceLibraryService | null {
  if (!dependencies.sourceLibrary) {
    return null;
  }
  const resolveSubject = grantSubjectResolver(dependencies.auth);
  return resolveSubject
    ? new SourceLibraryService(dependencies.sourceLibrary, resolveSubject)
    : new SourceLibraryService(dependencies.sourceLibrary);
}

function notConfigured(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } }
) {
  return reply.code(501).send({ error: "Research library unavailable" });
}

/** The roles a `role` grant can name; anything else would match nobody. */
const GRANTABLE_ROLES = new Set(["owner", "reviewer", "viewer"]);

/**
 * Builds the resolver that turns a typed grant subject into a real one.
 *
 * A `user` subject is matched by account **id**, but an operator naturally
 * reaches for a username; resolving it here is what makes the grant form's
 * promise true. An unresolvable subject resolves to null and is refused by the
 * service — after authorization, so that asking about an account the caller may
 * not share is answered like any other unauthorized attempt. With no account
 * directory there is nothing to resolve against, so no resolver is returned at
 * all and the subject is stored verbatim.
 */
function grantSubjectResolver(
  auth: AppDependencies["auth"]
): GrantSubjectResolver | undefined {
  const directory =
    typeof (auth as { listUsers?: unknown } | undefined)?.listUsers === "function"
      ? (auth as unknown as { listUsers: () => AuthUser[] }).listUsers()
      : [];
  if (directory.length === 0) {
    return undefined;
  }
  return (draft) => {
    const subjectId = draft.subjectId.trim();
    if (draft.subjectType === "role") {
      return GRANTABLE_ROLES.has(subjectId)
        ? { ...draft, subjectId }
        : null;
    }
    const byId = directory.find((entry) => entry.id === subjectId);
    if (byId) {
      return { ...draft, subjectId: byId.id };
    }
    const byUsername = directory.find(
      (entry) => entry.username.toLowerCase() === subjectId.toLowerCase()
    );
    return byUsername ? { ...draft, subjectId: byUsername.id } : null;
  };
}

function callerOf(
  user: ReturnType<NonNullable<AppDependencies["auth"]>["userFromRequest"]>
): LibraryCaller {
  if (!user) {
    // No identity system configured: the workspace operator. This is the
    // only path that ever sets `implicitOperator`; a request that carried a
    // login is always authorized as that user.
    return {
      userId: "local-operator",
      role: "owner",
      name: "local operator",
      implicitOperator: true
    };
  }
  return {
    userId: user.id,
    role: user.role,
    name: actorName(user)
  };
}

/** Query-string shape of the library search. */
const LibrarySearchQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  publisher: z.string().trim().max(120).optional(),
  author: z.string().trim().max(120).optional(),
  domain: z.string().trim().max(240).optional(),
  publishedFrom: z.string().datetime().optional(),
  publishedTo: z.string().datetime().optional(),
  language: z.string().trim().max(24).optional(),
  sessionId: z.string().uuid().optional(),
  targetSessionId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

const CopyIntoSessionSchema = z.object({
  sourceSessionId: z.string().uuid(),
  sourceId: z.string().uuid(),
  /** `copy` carries the captured text; `reference` carries metadata only. */
  mode: z.enum(["copy", "reference"]).default("copy")
});

function mapServiceError(
  reply: {
    code: (c: number) => {
      send: (b: unknown) => unknown;
    };
  },
  error: unknown
): boolean {
  if (error instanceof LibrarySessionNotFoundError) {
    reply.code(404).send({ error: error.message, code: "session_not_found" });
    return true;
  }
  if (
    error instanceof LibraryNotVisibleError ||
    error instanceof LibrarySnapshotNotVisibleError ||
    error instanceof LibraryGrantNotFoundError ||
    error instanceof GrantNotFoundError ||
    error instanceof GrantAlreadyRevokedError
  ) {
    reply.code(404).send({ error: "Not found", code: "not_found" });
    return true;
  }
  if (
    error instanceof LibraryViewerForbiddenError ||
    error instanceof LibraryGrantNotPermittedError
  ) {
    reply.code(403).send({
      error: error.message,
      code:
        error instanceof LibraryViewerForbiddenError
          ? "reviewer_required"
          : "grant_not_permitted"
    });
    return true;
  }
  if (error instanceof LibraryGrantExistsError || error instanceof GrantAlreadyExistsError) {
    reply.code(409).send({ error: error.message, code: "grant_exists" });
    return true;
  }
  if (error instanceof LibrarySubjectNotFoundError) {
    reply
      .code(400)
      .send({ error: error.message, code: "subject_not_found" });
    return true;
  }
  if (error instanceof LibrarySourceHasNoCaptureError) {
    reply
      .code(409)
      .send({ error: error.message, code: "source_has_no_capture" });
    return true;
  }
  if (error instanceof LibraryDuplicateSourceError) {
    reply.code(409).send({
      error: error.message,
      code: "duplicate_source",
      duplicate: error.detail
    });
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

export function registerResearchLibraryRoutes(
  app: FastifyInstance,
  dependencies: LibraryRouteDependencies,
  idempotency: IdempotencyStore
): void {
  /** Sessions the caller may browse: their own plus the granted ones. */
  app.get("/api/library/sessions", async (request, reply) => {
    const { user } = actorOf(request, dependencies);
    if (dependencies.auth && !user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const service = libraryService(dependencies);
    if (!service) {
      return notConfigured(reply);
    }
    return { sessions: await service.listSessions(callerOf(user)) };
  });

  /**
   * Authorized search across researches. A filter naming a session the caller
   * may not see returns an empty result — the search is not an existence
   * oracle — while a source id they may not see answers 404 on the detail
   * routes below.
   */
  app.get("/api/library/sources", async (request, reply) => {
    const { user } = actorOf(request, dependencies);
    if (dependencies.auth && !user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const service = libraryService(dependencies);
    if (!service) {
      return notConfigured(reply);
    }
    const parsed = LibrarySearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid library search",
        details: parsed.error.flatten()
      });
    }
    const filters = LibrarySearchFiltersSchema.parse(parsed.data);
    return service.searchSources(callerOf(user), filters);
  });

  /** The original source and its version history. */
  app.get<{ Params: { sourceId: string } }>(
    "/api/library/sources/:sourceId",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = libraryService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      try {
        return await service.getSourceDetail(
          callerOf(user),
          request.params.sourceId
        );
      } catch (error) {
        if (mapServiceError(reply, error)) {
          return;
        }
        throw error;
      }
    }
  );

  /** One immutable capture's text, for reading what is about to be copied. */
  app.get<{ Params: { sourceId: string; snapshotId: string } }>(
    "/api/library/sources/:sourceId/snapshots/:snapshotId",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = libraryService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      try {
        return await service.getSnapshotContent(
          callerOf(user),
          request.params.sourceId,
          request.params.snapshotId
        );
      } catch (error) {
        if (mapServiceError(reply, error)) {
          return;
        }
        throw error;
      }
    }
  );

  /** Grants a user or a role the right to browse a research's material. */
  app.post("/api/library/grants", async (request, reply) => {
    const { user } = actorOf(request, dependencies);
    if (dependencies.auth && !user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    const service = libraryService(dependencies);
    if (!service) {
      return notConfigured(reply);
    }
    const key = getIdempotencyKey(request);
    if (!key) {
      return reply
        .code(400)
        .send({ error: "Idempotency-Key header is required" });
    }
    const parsed = ShareGrantDraftSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid share grant",
        details: parsed.error.flatten()
      });
    }
    const requestHash = hashIdempotencyRequest({
      operation: "create-share-grant",
      body: parsed.data
    });
    try {
      const result = await idempotency.execute(key, requestHash, async () =>
        service.createGrant(callerOf(user), parsed.data)
      );
      return reply.code(201).send(result.response);
    } catch (error) {
      if (mapServiceError(reply, error)) {
        return;
      }
      throw error;
    }
  });

  /** Lists a session's grants; only its owner (or an admin) may look. */
  app.get<{ Querystring: { sessionId?: string } }>(
    "/api/library/grants",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = libraryService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const sessionId = request.query.sessionId;
      if (!sessionId) {
        return reply
          .code(400)
          .send({ error: "sessionId query parameter is required" });
      }
      try {
        return {
          grants: await service.listGrants(callerOf(user), sessionId)
        };
      } catch (error) {
        if (mapServiceError(reply, error)) {
          return;
        }
        throw error;
      }
    }
  );

  /**
   * Revokes a live grant. The grant row, the copies made under it and every
   * audit entry survive; only future visibility ends.
   */
  app.post<{ Params: { grantId: string } }>(
    "/api/library/grants/:grantId/revoke",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = libraryService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = ShareGrantRevokeSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid revoke request",
          details: parsed.error.flatten()
        });
      }
      const reason = parsed.data.reason ?? "revoked by owner";
      const requestHash = hashIdempotencyRequest({
        operation: "revoke-share-grant",
        grantId: request.params.grantId,
        reason
      });
      try {
        const result = await idempotency.execute(
          key,
          requestHash,
          async () => service.revokeGrant(callerOf(user), request.params.grantId, reason)
        );
        return result.response;
      } catch (error) {
        if (mapServiceError(reply, error)) {
          return;
        }
        throw error;
      }
    }
  );

  /**
   * Copies a source from the library into this research as an independent
   * source with a self-contained snapshot. Only material travels: no
   * evidence, claim, verification or review is inherited, and anything the
   * researcher later cites from the copy starts `unverified` through the
   * existing controlled path.
   */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/library/copies",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = libraryService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = CopyIntoSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid copy request",
          details: parsed.error.flatten()
        });
      }
      const requestHash = hashIdempotencyRequest({
        operation: "copy-library-source",
        sessionId: request.params.id,
        body: parsed.data
      });
      const sourceId = deriveUuidV7("source", key, requestHash);
      const snapshotId = deriveUuidV7("snapshot", key, requestHash);
      const copyId = deriveUuidV7("source-copy", key, requestHash);
      try {
        const result = await idempotency.execute(key, requestHash, async () =>
          service.copySourceIntoSession(callerOf(user), {
            targetSessionId: request.params.id,
            sourceSessionId: parsed.data.sourceSessionId,
            sourceId: parsed.data.sourceId,
            mode: parsed.data.mode,
            ids: { sourceId, snapshotId, copyId }
          })
        );
        return reply.code(201).send(result.response);
      } catch (error) {
        if (mapServiceError(reply, error)) {
          return;
        }
        throw error;
      }
    }
  );

  /**
   * Copy lineage for one session's sources, with the live origin status.
   * Read-only: it explains where a source came from and whether the origin
   * has since moved; it never changes anything.
   */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/library/lineage",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = libraryService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      try {
        const lineage = await service.listCopyLineage(
          callerOf(user),
          request.params.id
        );
        return { lineage: Object.fromEntries(lineage) };
      } catch (error) {
        // A research the caller may not browse is answered exactly like one
        // that does not exist. Without this the authorization decision would
        // surface as a 500, which is both a worse answer and a different one
        // for the same question.
        if (mapServiceError(reply, error)) {
          return;
        }
        throw error;
      }
    }
  );
}
