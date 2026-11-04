import {
  MembershipExistsError
} from "@nexus/db";
import {
  CommentDraftSchema,
  ReviewRequestDecisionSchema,
  ReviewRequestDraftSchema,
  TeamMemberInviteSchema,
  TeamMemberRemovalSchema,
  TeamMemberRoleChangeSchema,
  WorkItemDraftSchema,
  WorkItemUpdateSchema
} from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import {
  CollaborationBadRequestError,
  CollaborationConflictError,
  CollaborationForbiddenError,
  CollaborationSessionNotFoundError,
  CollaborationTargetNotFoundError,
  TeamCollaborationService,
  type CollaborationCaller
} from "../../research/team-collaboration-service";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for team collaboration & human review.
 *
 * The whole surface is session-scoped: every path carries `:id` (the session)
 * and every handler re-derives the caller's collaboration role from the
 * session ownership and their membership. A session the caller is not a
 * collaborator on answers 404 — the same answer an unknown id gets — so the
 * API cannot be used to probe which researches exist. Attribution is always
 * taken from the server-side identity, never the body. Writes that create
 * entities carry an `Idempotency-Key`; the rest are guarded by the optimistic
 * `version` column, so a double submit is a 409, never a duplicate row.
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

type CollaborationRouteDependencies = Pick<
  AppDependencies,
  "auth" | "teamCollaboration"
>;

function collaborationService(
  dependencies: CollaborationRouteDependencies
): TeamCollaborationService | null {
  if (!dependencies.teamCollaboration) return null;
  return new TeamCollaborationService(dependencies.teamCollaboration);
}

function notConfigured(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } }
) {
  return reply.code(501).send({ error: "Team collaboration unavailable" });
}

function callerOf(
  user: ReturnType<NonNullable<AppDependencies["auth"]>["userFromRequest"]
>): CollaborationCaller {
  if (!user) {
    return {
      userId: "local-operator",
      role: "owner",
      name: "local operator",
      implicitOperator: true
    };
  }
  return { userId: user.id, role: user.role, name: actorName(user) };
}

function mapServiceError(
  reply: {
    code: (c: number) => { send: (b: unknown) => unknown };
  },
  error: unknown
): boolean {
  if (
    error instanceof CollaborationSessionNotFoundError ||
    error instanceof CollaborationTargetNotFoundError
  ) {
    reply.code(404).send({ error: "Not found", code: "not_found" });
    return true;
  }
  if (error instanceof CollaborationForbiddenError) {
    reply.code(403).send({ error: error.message, code: "forbidden" });
    return true;
  }
  if (error instanceof CollaborationConflictError || error instanceof MembershipExistsError) {
    reply.code(409).send({ error: error.message, code: "conflict" });
    return true;
  }
  if (error instanceof CollaborationBadRequestError) {
    reply.code(400).send({ error: error.message, code: "bad_request" });
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

const RoleChangeSchema = z.object({
  role: z.enum(["owner", "editor", "reviewer", "viewer"])
});

const RemoveSchema = z.object({
  reason: z.string().trim().min(1).max(1000)
});

const CommentQuerySchema = z.object({
  targetType: z
    .enum([
      "claim",
      "evidence",
      "source",
      "conflict",
      "challenge",
      "plan_item",
      "revalidation_task",
      "report_snapshot",
      "work_item"
    ]),
  targetId: z.string().min(1).max(120)
});

export function registerTeamCollaborationRoutes(
  app: FastifyInstance,
  dependencies: CollaborationRouteDependencies,
  idempotency: IdempotencyStore
): void {
  // ----- Members -------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/collaboration/members",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      try {
        return {
          members: await service.listMembers(callerOf(user), request.params.id)
        };
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/collaboration/members/invite",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = TeamMemberInviteSchema.safeParse({
        ...(request.body ?? {}),
        sessionId: request.params.id
      });
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid invitation",
          details: parsed.error.flatten()
        });
      }
      const draft = { ...parsed.data, sessionId: request.params.id };
      const requestHash = hashIdempotencyRequest({
        operation: "invite-member",
        body: draft
      });
      try {
        const result = await idempotency.execute(key, requestHash, async () =>
          service.inviteMember(callerOf(user), draft)
        );
        return reply.code(201).send(result.response);
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string; userId: string } }>(
    "/api/sessions/:id/collaboration/members/:userId/accept",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      try {
        return await service.acceptInvitation(
          callerOf(user),
          request.params.id,
          request.params.userId
        );
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string; userId: string } }>(
    "/api/sessions/:id/collaboration/members/:userId/decline",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      try {
        return await service.declineInvitation(
          callerOf(user),
          request.params.id,
          request.params.userId
        );
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.patch<{ Params: { id: string; userId: string } }>(
    "/api/sessions/:id/collaboration/members/:userId/role",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const parsed = RoleChangeSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid role change",
          details: parsed.error.flatten()
        });
      }
      try {
        return await service.changeMemberRole(callerOf(user), {
          sessionId: request.params.id,
          userId: request.params.userId,
          role: parsed.data.role
        });
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string; userId: string } }>(
    "/api/sessions/:id/collaboration/members/:userId/remove",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const parsed = RemoveSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "A removal reason is required",
          details: parsed.error.flatten()
        });
      }
      try {
        return await service.removeMember(callerOf(user), {
          sessionId: request.params.id,
          userId: request.params.userId,
          reason: parsed.data.reason
        });
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  // ----- Work items ----------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/collaboration/work-items",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      try {
        return {
          workItems: await service.listWorkItems(
            callerOf(user),
            request.params.id
          )
        };
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/collaboration/work-items",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = WorkItemDraftSchema.safeParse({
        ...(request.body ?? {}),
        sessionId: request.params.id
      });
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid work item",
          details: parsed.error.flatten()
        });
      }
      const draft = { ...parsed.data, sessionId: request.params.id };
      const requestHash = hashIdempotencyRequest({
        operation: "create-work-item",
        body: draft
      });
      try {
        const result = await idempotency.execute(key, requestHash, async () =>
          service.createWorkItem(callerOf(user), draft)
        );
        return reply.code(201).send(result.response);
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.patch<{ Params: { id: string; workItemId: string } }>(
    "/api/sessions/:id/collaboration/work-items/:workItemId",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const parsed = WorkItemUpdateSchema.safeParse({
        ...(request.body ?? {}),
        sessionId: request.params.id,
        workItemId: request.params.workItemId
      });
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid work item update",
          details: parsed.error.flatten()
        });
      }
      try {
        return await service.updateWorkItem(callerOf(user), {
          ...parsed.data,
          sessionId: request.params.id,
          workItemId: request.params.workItemId
        });
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  // ----- Comments ------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/collaboration/comments",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const parsed = CommentQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "targetType and targetId are required",
          details: parsed.error.flatten()
        });
      }
      try {
        return {
          comments: await service.listComments(
            callerOf(user),
            request.params.id,
            parsed.data.targetType,
            parsed.data.targetId
          )
        };
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/collaboration/comments",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = CommentDraftSchema.safeParse({
        ...(request.body ?? {}),
        sessionId: request.params.id
      });
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid comment",
          details: parsed.error.flatten()
        });
      }
      const draft = { ...parsed.data, sessionId: request.params.id };
      const requestHash = hashIdempotencyRequest({
        operation: "create-comment",
        body: draft
      });
      try {
        const result = await idempotency.execute(key, requestHash, async () =>
          service.createComment(callerOf(user), draft)
        );
        return reply.code(201).send(result.response);
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.delete<{ Params: { id: string; commentId: string } }>(
    "/api/sessions/:id/collaboration/comments/:commentId",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const parsed = z
        .object({ expectedVersion: z.coerce.number().int().nonnegative() })
        .safeParse(request.query);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "expectedVersion query parameter is required" });
      }
      try {
        return await service.deleteComment(
          callerOf(user),
          request.params.id,
          request.params.commentId,
          parsed.data.expectedVersion
        );
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  // ----- Review requests -----------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/collaboration/review-requests",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      try {
        return {
          reviewRequests: await service.listReviewRequests(
            callerOf(user),
            request.params.id
          )
        };
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/collaboration/review-requests",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = ReviewRequestDraftSchema.safeParse({
        ...(request.body ?? {}),
        sessionId: request.params.id
      });
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid review request",
          details: parsed.error.flatten()
        });
      }
      const draft = { ...parsed.data, sessionId: request.params.id };
      const requestHash = hashIdempotencyRequest({
        operation: "create-review-request",
        body: draft
      });
      try {
        const result = await idempotency.execute(key, requestHash, async () =>
          service.createReviewRequest(callerOf(user), draft)
        );
        return reply.code(201).send(result.response);
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string; reviewRequestId: string } }>(
    "/api/sessions/:id/collaboration/review-requests/:reviewRequestId/claim",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      try {
        return await service.claimReviewRequest(
          callerOf(user),
          request.params.id,
          request.params.reviewRequestId
        );
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string; reviewRequestId: string } }>(
    "/api/sessions/:id/collaboration/review-requests/:reviewRequestId/decide",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const parsed = ReviewRequestDecisionSchema.safeParse({
        ...(request.body ?? {}),
        sessionId: request.params.id,
        reviewRequestId: request.params.reviewRequestId
      });
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid decision",
          details: parsed.error.flatten()
        });
      }
      try {
        return await service.decideReviewRequest(callerOf(user), {
          ...parsed.data,
          sessionId: request.params.id,
          reviewRequestId: request.params.reviewRequestId
        });
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string; reviewRequestId: string } }>(
    "/api/sessions/:id/collaboration/review-requests/:reviewRequestId/cancel",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      try {
        return await service.cancelReviewRequest(
          callerOf(user),
          request.params.id,
          request.params.reviewRequestId
        );
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );

  // ----- Activity ------------------------------------------------------------

  /**
   * One page of the collaboration trail, newest first.
   *
   * `activity` keeps its name and shape; `nextCursor` / `hasNextPage` are
   * additive. The cursor is the `sequence` of the last event on the page, so a
   * comment posted between two requests cannot shift or duplicate a page.
   */
  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; after?: string };
  }>(
    "/api/sessions/:id/collaboration/activity",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = collaborationService(dependencies);
      if (!service) return notConfigured(reply);
      const limit =
        request.query.limit === undefined ? undefined : Number(request.query.limit);
      if (limit !== undefined && !Number.isFinite(limit)) {
        return reply.code(400).send({ error: "limit must be a number" });
      }
      const after =
        request.query.after === undefined ? undefined : Number(request.query.after);
      if (after !== undefined && !Number.isFinite(after)) {
        return reply
          .code(400)
          .send({ error: "after must be an event sequence number" });
      }
      try {
        const page: { limit?: number; after?: number } = {};
        if (limit !== undefined) page.limit = limit;
        if (after !== undefined) page.after = after;
        const result = await service.listActivity(
          callerOf(user),
          request.params.id,
          page
        );
        return {
          activity: result.items,
          nextCursor: result.nextCursor,
          hasNextPage: result.hasNextPage
        };
      } catch (error) {
        if (mapServiceError(reply, error)) return;
        throw error;
      }
    }
  );
}
