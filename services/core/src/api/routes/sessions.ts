import { deriveUuidV7 } from "../plugins/deterministic-id";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvalidSessionCursorError } from "@nexus/db";
import { resolvePageLimit, type PageRequest } from "@nexus/shared";
import type { AppDependencies } from "../../app";
import { SessionAlreadyStartedError } from "../../arena/run-session";
import {
  callerOf,
  SESSION_RELATIONS,
  SessionAccessGuard,
  type SessionRelation
} from "../security/session-access";
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
  locale: z.enum(["zh-CN", "en-US"]).default("zh-CN"),
  /** The question this research has to answer. */
  researchQuestion: z.string().trim().min(1).max(1000).optional()
});

/**
 * The only field a research may be edited for now.
 *
 * Deliberately narrow: the question is what the research is *about*, and a
 * research created before the field existed has no way back otherwise. Phase,
 * status, conclusion and everything derived from the material are not in here,
 * so this route cannot be used to rewrite a finding.
 */
export const UpdateSessionSchema = z
  .object({
    researchQuestion: z.string().trim().min(1).max(1000)
  })
  // Strict on purpose: a client that also sends `currentConclusion` must be
  // told it was not applied, not left believing it was. Silently dropping the
  // field would be the worse outcome of the two.
  .strict();

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
  const access = new SessionAccessGuard(dependencies);

  /**
   * The workspace list — one page at a time.
   *
   * Three cases, and the interesting one is the third: a signed-in caller is
   * shown the researches they may read — their own, the ones shared with them,
   * the ones they collaborate on — and nothing else. The filter is a `WHERE id
   * IN (...)` in the query; the workspace is never read in full and then
   * trimmed here, which would leave the other accounts' rows one refactor away
   * from the response.
   *
   * This used to answer with a bare array of at most fifty rows and nothing
   * saying there were more. That is the shape that lets a screen print "50"
   * beside a workspace of four hundred and call it a count. It is now
   * `{ sessions, nextCursor, hasNextPage }`: the array keeps its name, and the
   * two new fields make "this is a window, not the whole list" something the
   * caller can read instead of guess.
   */
  app.get<{
    Querystring: { limit?: string; after?: string; relation?: string };
  }>(
    "/api/sessions",
    async (request, reply) => {
      // Both halves are required. The page query lives in `sessionPages`; the
      // readable-set filter lives in `sessionHistory`. A process wired with
      // only the first would answer every signed-in caller with an empty list
      // — "you have no research" instead of "this is not wired" — which is the
      // exact kind of quiet lie this route is being fixed for.
      if (!dependencies.sessionPages || !dependencies.sessionHistory) {
        return reply.code(501).send({ error: "Session history unavailable" });
      }
      // `resolvePageLimit` is the shared clamp: a client asking for 200 gets
      // 200, and one asking for nonsense gets the documented default instead
      // of a silently different number. The cursor below does not get the same
      // treatment, on purpose: a bad limit still describes a readable window,
      // while a bad cursor describes nothing.
      const limit = resolvePageLimit(
        request.query.limit === undefined ? undefined : Number(request.query.limit)
      );
      // Built field by field because `exactOptionalPropertyTypes` treats an
      // explicit `undefined` as a different thing from an absent key.
      const page: PageRequest = { limit };
      if (request.query.after !== undefined) page.after = request.query.after;

      const caller = callerOf(dependencies, request);
      if (caller.kind === "anonymous") {
        return reply.code(401).send({ error: "Authentication required" });
      }
      // A relation the endpoint does not know answers 400 rather than being
      // ignored: a filter that is silently dropped returns the whole list, and
      // the caller reads that as "I have nothing shared with me".
      const rawRelation = request.query.relation;
      const relationFilter =
        rawRelation === undefined || rawRelation === ""
          ? undefined
          : SESSION_RELATIONS.includes(rawRelation as SessionRelation)
            ? (rawRelation as SessionRelation)
            : null;
      if (relationFilter === null) {
        return reply.code(400).send({
          error: `relation must be one of ${SESSION_RELATIONS.join(", ")}`
        });
      }
      // `"all"` is the operator, or an administrator whose readable set is the
      // whole workspace; the query then runs unfiltered rather than being
      // handed every id in the database. An empty set is still a set, and the
      // query answers it without touching the table.
      //
      // `readableSessions` is `readableSessionIds` plus the reason each id is
      // in it, and both come from the same three queries. The list needs the
      // reasons so a screen can say 我创建的 and 别人共享给我的 apart — the
      // same read permission, two different facts, and the second one is what
      // a person deciding what to open actually wants to know. This is a view
      // on the access decision, not a fourth notion of "mine".
      const readable = await access.readableSessions(caller);
      const relationOf = readable.kind === "all" ? null : readable.relationOf;
      // The filter narrows the readable set *before* the query, not the page
      // after it. Filtering a page would answer "no shared research" from a
      // window that happened to hold none of them — the classic paginated
      // filter bug, where the result depends on how far down you scrolled.
      const sessionIds =
        readable.kind === "all"
          ? relationFilter === undefined
            ? undefined
            : // No identities means no relationships: every row would come
              // back with `relation: null`, so any relation filter is empty by
              // construction. Answering from the query would scan the whole
              // table to prove it.
              []
          : relationFilter === undefined
            ? [...readable.ids]
            : [...readable.ids].filter(
                (id) => readable.relationOf.get(id) === relationFilter
              );

      try {
        const result = await dependencies.sessionPages.listPage(page, sessionIds);
        return {
          sessions: result.items.map((item) => ({
            ...item,
            // `null` in operator mode: a deployment without an identity system
            // has nobody to relate a research to, and labelling those rows
            // "owner" would state an authorship the process never recorded.
            relation: relationOf?.get(item.id) ?? null
          })),
          nextCursor: result.nextCursor,
          hasNextPage: result.hasNextPage
        };
      } catch (error) {
        // A cursor this endpoint did not issue answers 400. Falling back to
        // the first page would show a caller that believes it is paging the
        // beginning of the list again, with no way to notice the repeat.
        if (error instanceof InvalidSessionCursorError) {
          return reply.code(400).send({
            error: "after is not a cursor issued by this endpoint"
          });
        }
        throw error;
      }
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
            currentConclusion: null,
            researchQuestion: parsed.data.researchQuestion ?? null,
            // Ownership comes from the server-side identity, never the body:
            // a research belongs to whoever was logged in when it was made.
            ownerUserId: authUser?.id ?? null
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
  /**
   * Editing the question the research asks.
   *
   * A research created before the field existed shows "（未填写研究问题）" and a
   * report renders the same, with no way to correct it — the question could only
   * ever be set once, at creation. This is that way back, and it writes nothing
   * but the question.
   */
  app.patch<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      if (!dependencies.sessionHistory) {
        return reply.code(501).send({ error: "Session history unavailable" });
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }

      const parsed = UpdateSessionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid session update",
          details: parsed.error.flatten()
        });
      }

      const caller = callerOf(dependencies, request);
      const decision = await access.mayEdit(caller, request.params.id);
      if (decision === "unauthenticated") {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (decision === "unknown") {
        return reply
          .code(404)
          .send({ error: "Session not found", code: "session_not_found" });
      }
      if (decision === "denied") {
        return reply
          .code(403)
          .send({ error: "Only a researcher on this session may edit it" });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "update-session",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const updated = await dependencies.sessionHistory?.setResearchQuestion(
            sessionId,
            parsed.data.researchQuestion
          );
          if (!updated) {
            throw new SessionNotFoundError();
          }
          return updated;
        });
        return reply.code(200).send(result.response);
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
        throw error;
      }
    }
  );

  /**
   * Retiring a research.
   *
   * Deleting is asked about separately from reading: the guard above lets
   * collaborators and share grantees in, which is right for reading and wrong
   * for erasing. Ownership — not the global role — decides, so a researcher can
   * now remove their own research, and someone who was merely given access to it
   * cannot remove it from under its owner.
   */
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply) => {
      if (!dependencies.sessionHistory) {
        return reply.code(501).send({ error: "Session history unavailable" });
      }
      const caller = callerOf(dependencies, request);
      const decision = await access.mayDelete(caller, request.params.id);
      if (decision === "unauthenticated") {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (decision === "unknown") {
        return reply
          .code(404)
          .send({ error: "Session not found", code: "session_not_found" });
      }
      if (decision === "denied") {
        // The guard already answered "not found" to callers who cannot read
        // this research, so anyone who reaches this branch can see it. Telling
        // them the truth — visible, but not theirs to delete — leaks nothing.
        return reply
          .code(403)
          .send({ error: "Only the session owner can delete this research" });
      }
      const deleted = await dependencies.sessionHistory.deleteById(
        request.params.id
      );
      if (!deleted) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return reply.code(204).send();
    }
  );

}
