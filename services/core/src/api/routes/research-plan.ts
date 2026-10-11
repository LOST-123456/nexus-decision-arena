import { z } from "zod";
import {
  ResearchPlanItemDraftSchema,
  ResearchPlanOutcomeDraftSchema,
  ResearchQueryEditSchema
} from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import {
  ResearchPlanError,
  ResearchPlanService
} from "../../research/research-plan-service";
import { ResearchWorkspaceService } from "../../research/workspace-service";
import { deriveUuidV7 } from "../plugins/deterministic-id";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

/**
 * Routes for the research plan.
 *
 * The handlers authenticate, authorize, validate the request shape and map a
 * service failure to a status code. Everything that matters happens in the
 * service: which gaps exist (derived), which are planned (stored), and what a
 * person decided. There is deliberately no endpoint that executes a search —
 * this build has none, and `start_search` is never offered.
 */

/** Closing a gap or marking it out of scope. A reason is mandatory either way. */
const PlanDecisionBodySchema = z.object({
  result: z.enum(["not_applicable", "closed"]),
  reason: z.string().trim().min(10).max(2000)
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

function actorName(
  user: { displayName: string; username: string } | null
): string {
  return user ? `${user.displayName} (${user.username})` : "unattributed";
}

type PlanRouteDependencies = Pick<
  AppDependencies,
  "auth" | "evidence" | "arena" | "sessions" | "reviews" | "researchPlan"
>;

function planService(
  dependencies: PlanRouteDependencies
): ResearchPlanService | null {
  if (
    !dependencies.researchPlan ||
    !dependencies.evidence ||
    !dependencies.arena ||
    !dependencies.sessions ||
    !dependencies.reviews
  ) {
    return null;
  }
  // Same workspace projection the research workspace route builds, so gap
  // diagnoses can never disagree between the two surfaces.
  const workspaceService = new ResearchWorkspaceService({
    evidence: dependencies.evidence,
    arena: dependencies.arena,
    reviews: dependencies.reviews,
    getSession: async (sessionId) => {
      const session = await dependencies.sessions!.getById(sessionId);
      if (!session) return null;
      return {
        id: session.id,
        phase: session.phase,
        operationalStatus: session.operationalStatus,
        researchQuestion: session.researchQuestion ?? null,
        currentConclusion: session.currentConclusion ?? null
      };
    }
  });
  return new ResearchPlanService({
    plan: dependencies.researchPlan,
    workspace: (sessionId) => workspaceService.getWorkspace(sessionId),
    material: dependencies.evidence,
    // Honest by construction: no controlled web-search integration exists in
    // this build, so the plan never offers to run one.
    searchAvailable: false
  });
}

function notConfigured(
  reply: { code: (c: number) => { send: (b: unknown) => unknown } }
) {
  return reply.code(501).send({ error: "Research plan is not configured" });
}

function mapServiceError(reply: {
  code: (c: number) => { send: (b: unknown) => unknown };
}, error: unknown): boolean {
  if (error instanceof ResearchPlanError) {
    reply
      .code(error.httpStatus)
      .send({ error: error.message, code: error.code });
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

export function registerResearchPlanRoutes(
  app: FastifyInstance,
  dependencies: PlanRouteDependencies,
  idempotency: IdempotencyStore
): void {
  /* The plan and the still-unplanned gaps, in one read. */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/research-plan",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = planService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const view = await service.getPlan(request.params.id);
      if (!view) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return view;
    }
  );

  /* Adds one diagnosed gap to the plan as a queued item. */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/research-plan",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      const service = planService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = ResearchPlanItemDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid research plan item draft",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "research-plan-add",
        sessionId,
        body: parsed.data
      });
      const itemId = deriveUuidV7("research-plan-item", key, requestHash);

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          service.addToPlan({
            sessionId,
            draft: parsed.data,
            itemId,
            actor: actorName(user)
          })
        );
        if (!result.response) {
          return reply.code(404).send({ error: "Session not found" });
        }
        return reply
          .code(result.response.alreadyPlanned ? 200 : 201)
          .send(result.response);
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Every statement ever recorded for one gap, newest first. */
  app.get<{
    Params: { id: string };
    Querystring: { gapId?: string };
  }>(
    "/api/sessions/:id/research-plan/history",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      const service = planService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const { gapId } = request.query;
      if (!gapId) {
        return reply.code(400).send({ error: "gapId is required" });
      }
      const view = await service.getPlan(request.params.id);
      if (!view) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return {
        items: await service.listPlanItemHistory(
          request.params.id,
          gapId
        )
      };
    }
  );

  /* Rewrites the query skeleton of one item. */
  app.post<{ Params: { id: string; itemId: string } }>(
    "/api/sessions/:id/research-plan/:itemId/query",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      const service = planService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = ResearchQueryEditSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid query edit",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "research-plan-edit-query",
        sessionId,
        itemId: request.params.itemId,
        body: parsed.data
      });
      const replacementId = deriveUuidV7(
        "research-plan-item",
        key,
        requestHash
      );

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          service.editQuery({
            sessionId,
            itemId: request.params.itemId,
            edit: parsed.data,
            actor: actorName(user),
            replacementId
          })
        );
        if (!result.response) {
          return reply.code(404).send({ error: "Session not found" });
        }
        return result.response;
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* A person's decision that a gap does not apply, or is closed. */
  app.post<{ Params: { id: string; itemId: string } }>(
    "/api/sessions/:id/research-plan/:itemId/decision",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      const service = planService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = PlanDecisionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid plan decision",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "research-plan-decision",
        sessionId,
        itemId: request.params.itemId,
        body: parsed.data
      });
      const replacementId = deriveUuidV7(
        "research-plan-item",
        key,
        requestHash
      );

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          service.decide({
            sessionId,
            itemId: request.params.itemId,
            result: parsed.data.result,
            reason: parsed.data.reason,
            actor: actorName(user),
            replacementId
          })
        );
        if (!result.response) {
          return reply.code(404).send({ error: "Session not found" });
        }
        return result.response;
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );

  /* Records what a person actually found, completing the item. */
  app.post<{ Params: { id: string; itemId: string } }>(
    "/api/sessions/:id/research-plan/:itemId/outcome",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      const service = planService(dependencies);
      if (!service) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = ResearchPlanOutcomeDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid plan outcome",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "research-plan-outcome",
        sessionId,
        itemId: request.params.itemId,
        body: parsed.data
      });
      const replacementId = deriveUuidV7(
        "research-plan-item",
        key,
        requestHash
      );

      try {
        const result = await idempotency.execute(key, requestHash, () =>
          service.recordOutcome({
            sessionId,
            itemId: request.params.itemId,
            draft: parsed.data,
            actor: actorName(user),
            replacementId
          })
        );
        if (!result.response) {
          return reply.code(404).send({ error: "Session not found" });
        }
        return result.response;
      } catch (error) {
        if (mapServiceError(reply, error)) return undefined;
        throw error;
      }
    }
  );
}
