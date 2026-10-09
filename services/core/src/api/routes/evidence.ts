import {
  ClaimLinkError,
  EvidenceNotFoundError,
  SourceNotFoundError,
  SourceTitleConflictError
} from "@nexus/db";
import {
  EvidenceDirectionSchema,
  EvidenceKindSchema,
  EvidenceSchema,
  EvidenceValidityPeriodSchema,
  EvidenceVerificationRequestSchema,
  planEvidenceVerification,
  EvidenceVerificationError,
  SourceDraftSchema,
  SourceSchema,
  type Claim
} from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import { ResearchWorkspaceService } from "../../research/workspace-service";
import { deriveUuidV7 } from "../plugins/deterministic-id";
import type { EventBus } from "../../execution/event-bus";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

export const CreateSourceSchema = SourceDraftSchema;

/**
 * Newly recorded evidence always starts `unverified`. Verification is a
 * separate, attributed act, so nothing that arrives through this endpoint can
 * land in a verified state — including output relayed from a model.
 */
export const CreateEvidenceSchema = z.object({
  kind: EvidenceKindSchema,
  title: z.string().trim().min(1).max(240),
  content: z.string().trim().min(1),
  description: z.string().trim().min(1),
  sourceId: z.string().uuid().optional(),
  sourceRef: z.string().url().optional(),
  locator: z.string().trim().max(240).optional(),
  direction: EvidenceDirectionSchema,
  reliability: z.number().min(0).max(1),
  claimIds: z.array(z.string().uuid()).min(1),
  validityPeriod: EvidenceValidityPeriodSchema.optional()
});

export const UpdateEvidenceSchema = CreateEvidenceSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: "At least one field must be updated" }
);

/** `verifiedBy` is only honoured when the deployment runs without auth. */
export const VerificationSchema =
  EvidenceVerificationRequestSchema.extend({
    verifiedBy: z.string().trim().min(1).max(120).optional()
  });

export const CreateClaimSchema = z.object({
  statement: z.string().trim().min(1),
  lens: z.string().trim().min(1).optional(),
  type: z.enum(["fact", "assumption", "prediction", "recommendation"]),
  stance: z.enum(["support", "oppose", "neutral"]),
  importance: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1).optional()
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
  user: { displayName: string; username: string } | null,
  fallback?: string
): string | null {
  if (user) {
    return `${user.displayName} (${user.username})`;
  }
  return fallback?.trim() ? fallback.trim() : null;
}

export function registerEvidenceRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "auth" | "evidence" | "arena" | "sessions">,
  idempotency: IdempotencyStore,
  eventBus: EventBus
): void {
  const notConfigured = (reply: { code: (c: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(501).send({ error: "Research evidence storage unavailable" });

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/research",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.evidence || !dependencies.arena || !dependencies.sessions) {
        return notConfigured(reply);
      }
      const service = new ResearchWorkspaceService({
        evidence: dependencies.evidence,
        arena: dependencies.arena,
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
      const workspace = await service.getWorkspace(request.params.id);
      if (!workspace) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return workspace;
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/sources",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.evidence) {
        return notConfigured(reply);
      }
      return { sources: await dependencies.evidence.listSources(request.params.id) };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/sources",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.evidence) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = CreateSourceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid source request",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "create-source",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const now = new Date().toISOString();
          const source = SourceSchema.parse({
            id: deriveUuidV7("source", key, requestHash),
            sessionId,
            ...parsed.data,
            createdBy: user ? "human" : "system",
            createdAt: now,
            updatedAt: now
          });
          return { source: await dependencies.evidence!.createSource(source) };
        });
        return reply.code(201).send(result.response);
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError ||
          error instanceof SourceTitleConflictError
        ) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: "Invalid research request",
            details: error.flatten()
          });
        }
        throw error;
      }
    }
  );

  app.get<{
    Params: { id: string };
    Querystring: { claimId?: string; verificationStatus?: string; direction?: string };
  }>("/api/sessions/:id/evidence", async (request, reply) => {
    const { user } = actorOf(request, dependencies);
    if (dependencies.auth && !user) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (!dependencies.evidence) {
      return notConfigured(reply);
    }
    const { claimId, verificationStatus, direction } = request.query;
    const evidence = await dependencies.evidence.listEvidence(
      request.params.id,
      {
        ...(claimId ? { claimId } : {}),
        ...(verificationStatus ? { verificationStatus } : {}),
        ...(direction ? { direction } : {})
      }
    );
    return { evidence };
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/evidence",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.evidence) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = CreateEvidenceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid evidence request",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "create-evidence",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const evidenceId = deriveUuidV7("evidence", key, requestHash);
          // Creation never marks anything verified; that is a separate act.
          const evidence = EvidenceSchema.parse({
            id: evidenceId,
            sessionId,
            claimIds: parsed.data.claimIds,
            kind: parsed.data.kind,
            title: parsed.data.title,
            content: parsed.data.content,
            description: parsed.data.description,
            ...(parsed.data.sourceId ? { sourceId: parsed.data.sourceId } : {}),
            ...(parsed.data.sourceRef ? { sourceRef: parsed.data.sourceRef } : {}),
            ...(parsed.data.locator ? { locator: parsed.data.locator } : {}),
            direction: parsed.data.direction,
            reliability: parsed.data.reliability,
            verificationStatus: "unverified",
            ...(parsed.data.validityPeriod
              ? { validityPeriod: parsed.data.validityPeriod }
              : {}),
            retrievedAt: new Date().toISOString(),
            createdBy: user ? "human" : "system"
          });

          const created = await dependencies.evidence!.createEvidence({
            evidence,
            event: {
              correlationId: evidenceId,
              type: "EVIDENCE_RECORDED",
              payload: {
                evidenceId,
                claimIds: evidence.claimIds,
                direction: evidence.direction,
                kind: evidence.kind,
                ...(evidence.sourceId ? { sourceId: evidence.sourceId } : {}),
                verificationStatus: evidence.verificationStatus,
                createdBy: evidence.createdBy
              }
            }
          });

          try {
            await eventBus.publishAfterCommit({
              append: async () => created.event
            });
          } catch (error) {
            request.log.error({ err: error }, "Failed to publish evidence event");
          }

          return { evidence: created.evidence, event: created.event };
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
        if (
          error instanceof ClaimLinkError ||
          error instanceof SourceNotFoundError
        ) {
          return reply.code(400).send({ error: error.message });
        }
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: "Invalid research request",
            details: error.flatten()
          });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { id: string; evidenceId: string } }>(
    "/api/sessions/:id/evidence/:evidenceId",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!dependencies.evidence) {
        return notConfigured(reply);
      }
      const context = await dependencies.evidence.getEvidenceContext(
        request.params.id,
        request.params.evidenceId
      );
      if (!context) {
        return reply.code(404).send({ error: "Evidence not found" });
      }
      return context;
    }
  );

  app.patch<{ Params: { id: string; evidenceId: string } }>(
    "/api/sessions/:id/evidence/:evidenceId",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.evidence) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = UpdateEvidenceSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid evidence update",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const evidenceId = request.params.evidenceId;
      const requestHash = hashIdempotencyRequest({
        operation: "update-evidence",
        sessionId,
        evidenceId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const updated = await dependencies.evidence!.updateEvidence({
            sessionId,
            evidenceId,
            patch: parsed.data,
            event: {
              correlationId: evidenceId,
              type: "EVIDENCE_RECORDED",
              payload: {
                evidenceId,
                updatedFields: Object.keys(parsed.data),
                changedBy: actorName(user) ?? "unattributed"
              }
            }
          });
          await eventBus.publishAfterCommit({
            append: async () => updated.event
          });
          return { evidence: updated.evidence, event: updated.event };
        });
        return result.response;
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError
        ) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof EvidenceNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (
          error instanceof ClaimLinkError ||
          error instanceof SourceNotFoundError
        ) {
          return reply.code(400).send({ error: error.message });
        }
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: "Invalid research request",
            details: error.flatten()
          });
        }
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string; evidenceId: string } }>(
    "/api/sessions/:id/evidence/:evidenceId/verification",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.evidence) {
        return notConfigured(reply);
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = VerificationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid verification request",
          details: parsed.error.flatten()
        });
      }

      // The reviewer identity always comes from the session, never from the
      // body, so a client cannot attribute a verification to someone else.
      const verifiedBy = actorName(user, parsed.data.verifiedBy);
      if (!verifiedBy) {
        return reply
          .code(400)
          .send({ error: "A named reviewer is required for verification" });
      }

      const sessionId = request.params.id;
      const evidenceId = request.params.evidenceId;
      const requestHash = hashIdempotencyRequest({
        operation: "verify-evidence",
        sessionId,
        evidenceId,
        body: { ...parsed.data, verifiedBy }
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const current = await dependencies.evidence!.getEvidence(
            sessionId,
            evidenceId
          );
          if (!current) {
            throw new EvidenceNotFoundError(evidenceId);
          }

          const plan = planEvidenceVerification({
            evidence: current,
            status: parsed.data.status,
            verifiedBy,
            verificationNote: parsed.data.verificationNote
          });

          const updated = await dependencies.evidence!.setVerification({
            sessionId,
            evidenceId,
            patch: plan.patch,
            event: {
              correlationId: evidenceId,
              type: "EVIDENCE_VERIFICATION_CHANGED",
              payload: {
                evidenceId,
                from: plan.from,
                to: plan.to,
                verifiedBy: plan.patch.verifiedBy,
                verifiedAt: plan.patch.verifiedAt,
                verificationNote: plan.patch.verificationNote,
                claimIds: current.claimIds
              }
            }
          });

          await eventBus.publishAfterCommit({
            append: async () => updated.event
          });

          return {
            evidence: updated.evidence,
            event: updated.event,
            verification: { from: plan.from, to: plan.to }
          };
        });
        return result.response;
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError ||
          error instanceof EvidenceVerificationError
        ) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof EvidenceNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: "Invalid research request",
            details: error.flatten()
          });
        }
        throw error;
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/claims",
    async (request, reply) => {
      const { user } = actorOf(request, dependencies);
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (user?.role === "viewer") {
        return reply.code(403).send({ error: "Reviewer role required" });
      }
      if (!dependencies.arena) {
        return reply.code(501).send({ error: "Claim storage unavailable" });
      }
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }
      const parsed = CreateClaimSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid claim request",
          details: parsed.error.flatten()
        });
      }

      const sessionId = request.params.id;
      const requestHash = hashIdempotencyRequest({
        operation: "create-research-claim",
        sessionId,
        body: parsed.data
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const claimId = deriveUuidV7("research-claim", key, requestHash);
          const now = new Date().toISOString();
          // No agent run and no role: a researcher wrote this themselves.
          const claim: Claim = {
            id: claimId,
            sessionId,
            lens: parsed.data.lens ?? "research",
            statement: parsed.data.statement,
            type: parsed.data.type,
            stance: parsed.data.stance,
            importance: parsed.data.importance,
            confidence: parsed.data.confidence ?? 0.5,
            evidenceIds: [],
            status: "proposed",
            rootClaimId: claimId,
            revision: 1,
            relations: [],
            createdAt: now,
            updatedAt: now
          };

          const created = await dependencies.arena!.createResearchClaim({
            claim,
            event: {
              correlationId: claimId,
              type: "CLAIM_CREATED",
              payload: {
                claimId,
                statement: claim.statement,
                type: claim.type,
                stance: claim.stance,
                importance: claim.importance,
                authoredBy: actorName(user) ?? "unattributed"
              }
            }
          });

          await eventBus.publishAfterCommit({
            append: async () => created.event
          });

          return { claim: created.claim, event: created.event };
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
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: "Invalid research request",
            details: error.flatten()
          });
        }
        throw error;
      }
    }
  );
}
