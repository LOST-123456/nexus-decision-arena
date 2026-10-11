import {
  ReviewClaimNotFoundError,
  ReviewReferenceError
} from "@nexus/db";
import {
  ClaimReviewDraftSchema,
  ClaimReviewSchema,
  deriveClaimVerdicts,
  type ExecutionEvent
} from "@nexus/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppDependencies } from "../../app";
import {
  CrossReviewClaimNotFoundError,
  CrossReviewInProgressError,
  CrossReviewNoChallengerError
} from "../../research/cross-review-service";
import { buildFactCheckReport } from "../../research/fact-check-report";
import { renderFactCheckReportMarkdown } from "../../research/fact-check-report-markdown";
import { deriveUuidV7 } from "../plugins/deterministic-id";
import type { EventBus } from "../../execution/event-bus";
import {
  hashIdempotencyRequest,
  IdempotencyConflictError,
  IdempotencyLeaseLostError,
  IdempotencyTimeoutError,
  type IdempotencyStore
} from "../plugins/idempotency";

function getIdempotencyKey(request: FastifyRequest): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && key.length > 0 ? key : null;
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

/**
 * A ruling is made about a specific derived verdict. If the verdict has moved
 * on since the reviewer's page was rendered, the ruling would silently apply
 * to a conclusion nobody reviewed, so the server refuses it instead of
 * accepting a stale decision.
 */
export class StaleVerdictError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `页面显示的事实核查结论（${expected}）已过期：当前自动推导的结论为 ${actual}。请刷新后重新复核。`
    );
    this.name = "StaleVerdictError";
  }
}

export function registerReviewRoutes(
  app: FastifyInstance,
  dependencies: Pick<
    AppDependencies,
    | "auth"
    | "reviews"
    | "evidence"
    | "arena"
    | "sessions"
    | "events"
    | "crossReview"
    | "researchPlan"
  >,
  idempotency: IdempotencyStore,
  eventBus: EventBus
): void {
  const notConfigured = (reply: {
    code: (c: number) => { send: (b: unknown) => unknown };
  }) =>
    reply.code(501).send({ error: "Review services unavailable" });

  function guard(
    request: FastifyRequest,
    reply: {
      code: (c: number) => { send: (b: unknown) => unknown };
    },
    mode: "read" | "write"
  ): { user: ReturnType<NonNullable<AppDependencies["auth"]>["userFromRequest"]> } | null {
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

  /**
   * Runs cross-examination against one claim, reusing the arena's own
   * challenger selection and CrossExaminationService. Every attempt is a real
   * agent run; a failure is reported as a failure, never as silence.
   */
  app.post<{ Params: { id: string; claimId: string } }>(
    "/api/sessions/:id/claims/:claimId/cross-review",
    async (request, reply) => {
      const actor = guard(request, reply, "write");
      if (!actor) return;
      if (!dependencies.crossReview) return notConfigured(reply);
      const key = getIdempotencyKey(request);
      if (!key) {
        return reply
          .code(400)
          .send({ error: "Idempotency-Key header is required" });
      }

      const sessionId = request.params.id;
      const claimId = request.params.claimId;
      const requestedBy = actorName(actor.user) ?? "unattributed";
      const requestHash = hashIdempotencyRequest({
        operation: "claim-cross-review",
        sessionId,
        claimId
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const outcome = await dependencies.crossReview!.runForClaim({
            sessionId,
            claimId,
            actor: requestedBy
          });
          return outcome;
        });
        return reply.code(201).send(result.response);
      } catch (error) {
        if (
          error instanceof IdempotencyConflictError ||
          error instanceof IdempotencyTimeoutError ||
          error instanceof IdempotencyLeaseLostError ||
          error instanceof CrossReviewInProgressError ||
          error instanceof CrossReviewNoChallengerError
        ) {
          return reply.code(409).send({ error: error.message });
        }
        if (error instanceof CrossReviewClaimNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: "Invalid cross-review request",
            details: error.flatten()
          });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/cross-reviews",
    async (request, reply) => {
      if (!guard(request, reply, "read")) return;
      if (!dependencies.reviews || !dependencies.arena) {
        return notConfigured(reply);
      }
      const artifacts = await dependencies.arena.getSessionArtifacts(
        request.params.id
      );
      if (!artifacts) {
        return reply.code(404).send({ error: "Session not found" });
      }
      const agentRuns = await dependencies.reviews.listAgentRuns(
        request.params.id
      );
      return {
        runs: agentRuns.filter((run) => run.purpose === "cross_review"),
        analysisRuns: agentRuns.filter((run) => run.purpose === "analysis"),
        challenges: artifacts.challenges,
        conflicts: artifacts.conflicts
      };
    }
  );

  /**
   * Records a human ruling. Append-only: the response carries the new ruling
   * and the endpoint never rewrites an earlier one, so history survives.
   */
  app.post<{ Params: { id: string; claimId: string } }>(
    "/api/sessions/:id/claims/:claimId/reviews",
    async (request, reply) => {
      const actor = guard(request, reply, "write");
      if (!actor) return;
      if (
        !dependencies.reviews ||
        !dependencies.evidence ||
        !dependencies.arena
      ) {
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
      const parsed = ClaimReviewDraftSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid review request",
          details: parsed.error.flatten()
        });
      }

      // The reviewer is the authenticated actor; a client cannot sign a ruling
      // with someone else's name.
      const reviewer = actorName(actor.user, undefined);
      if (!reviewer) {
        return reply
          .code(400)
          .send({ error: "A named reviewer is required to record a ruling" });
      }

      const requestHash = hashIdempotencyRequest({
        operation: "claim-review",
        sessionId,
        claimId,
        body: { ...parsed.data, reviewer }
      });

      try {
        const result = await idempotency.execute(key, requestHash, async () => {
          const [artifacts, evidence, reviews] = await Promise.all([
            dependencies.arena!.getSessionArtifacts(sessionId),
            dependencies.evidence!.listEvidence(sessionId),
            dependencies.reviews!.listReviews(sessionId)
          ]);
          if (!artifacts) {
            throw new ReviewClaimNotFoundError(claimId);
          }
          if (!artifacts.claims.some((claim) => claim.id === claimId)) {
            throw new ReviewClaimNotFoundError(claimId);
          }

          // Snapshot the derived verdict the reviewer is ruling on, so a later
          // evidence change cannot make the ruling look retrospective.
          const verdict = deriveClaimVerdicts(artifacts.claims, evidence, {
            challenges: artifacts.challenges,
            reviews
          }).find((item) => item.claimId === claimId);
          if (!verdict) {
            throw new ReviewClaimNotFoundError(claimId);
          }

          // Refuse a ruling written against a verdict that has since changed:
          // the reviewer would otherwise be ruling on a conclusion that no
          // longer exists, without seeing the difference.
          if (verdict.status !== parsed.data.expectedVerdictStatus) {
            throw new StaleVerdictError(
              parsed.data.expectedVerdictStatus,
              verdict.status
            );
          }

          const reviewId = deriveUuidV7("claim-review", key, requestHash);
          const createdAt = new Date().toISOString();
          const review = ClaimReviewSchema.parse({
            id: reviewId,
            sessionId,
            claimId,
            outcome: parsed.data.outcome,
            rationale: parsed.data.rationale,
            reviewer,
            evidenceIds: parsed.data.evidenceIds,
            sourceIds: parsed.data.sourceIds,
            verdictStatusAtReview: verdict.status,
            verdictConfidenceAtReview: verdict.confidence,
            createdAt
          });

          const event: {
            correlationId: string;
            type: ExecutionEvent["type"];
            payload: unknown;
          } = {
            correlationId: reviewId,
            type: "CLAIM_REVIEW_RECORDED",
            payload: {
              reviewId,
              claimId,
              outcome: review.outcome,
              reviewer: review.reviewer,
              rationale: review.rationale,
              evidenceIds: review.evidenceIds,
              sourceIds: review.sourceIds,
              verdictStatusAtReview: review.verdictStatusAtReview,
              verdictConfidenceAtReview: review.verdictConfidenceAtReview
            }
          };

          const created = await dependencies.reviews!.createReview({
            review,
            event
          });

          await eventBus.publishAfterCommit({
            append: async () => created.event
          });

          return created;
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
        if (error instanceof ReviewClaimNotFoundError) {
          return reply.code(404).send({ error: error.message });
        }
        if (error instanceof ReviewReferenceError) {
          return reply.code(400).send({ error: error.message });
        }
        if (error instanceof StaleVerdictError) {
          return reply.code(409).send({
            error: error.message,
            code: "stale_verdict",
            expected: error.expected,
            actual: error.actual
          });
        }
        if (error instanceof z.ZodError) {
          return reply.code(400).send({
            error: "Invalid review request",
            details: error.flatten()
          });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { id: string; claimId: string } }>(
    "/api/sessions/:id/claims/:claimId/reviews",
    async (request, reply) => {
      if (!guard(request, reply, "read")) return;
      if (!dependencies.reviews || !dependencies.arena) {
        return notConfigured(reply);
      }
      const artifacts = await dependencies.arena.getSessionArtifacts(
        request.params.id
      );
      if (!artifacts) {
        return reply.code(404).send({ error: "Session not found" });
      }
      if (!artifacts.claims.some((claim) => claim.id === request.params.claimId)) {
        return reply.code(404).send({ error: "Claim not found in this session" });
      }
      const history = await dependencies.reviews.listReviewHistory(
        request.params.id,
        request.params.claimId
      );
      return { reviews: history, latest: history[0] ?? null };
    }
  );

  /**
   * The fact-check report, built only from persisted material. `format`
   * switches to the Markdown rendering; both are generated from the same
   * object, so they cannot disagree.
   */
  app.get<{
    Params: { id: string };
    Querystring: { format?: string; download?: string };
  }>("/api/sessions/:id/fact-check-report", async (request, reply) => {
    if (!guard(request, reply, "read")) return;
    if (
      !dependencies.reviews ||
      !dependencies.evidence ||
      !dependencies.arena ||
      !dependencies.sessions
    ) {
      return notConfigured(reply);
    }

    const sessionId = request.params.id;
    const session = await dependencies.sessions.getById(sessionId);
    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }

    const [artifacts, evidence, sources, reviews, agentRuns, events] =
      await Promise.all([
        dependencies.arena.getSessionArtifacts(sessionId),
        dependencies.evidence.listEvidence(sessionId),
        dependencies.evidence.listSources(sessionId),
        dependencies.reviews.listReviews(sessionId),
        dependencies.reviews.listAgentRuns(sessionId),
        dependencies.events.listAfter(sessionId, 0)
      ]);

    if (!artifacts) {
      return reply.code(404).send({ error: "Session not found" });
    }

    // The report names, per gap, what the research plan has decided about it.
    // Absent when the plan is not configured; nothing is invented then.
    const planItems = dependencies.researchPlan
      ? await dependencies.researchPlan.listCurrentPlanItems(sessionId)
      : [];

    const verdicts = deriveClaimVerdicts(artifacts.claims, evidence, {
      challenges: artifacts.challenges,
      reviews
    });
    const lastEventSequence = events.reduce(
      (max, event) => Math.max(max, event.sequence),
      0
    );

    const report = buildFactCheckReport({
      session: {
        id: sessionId,
        researchQuestion: session.researchQuestion ?? null,
        phase: session.phase,
        operationalStatus: session.operationalStatus,
        currentConclusion: session.currentConclusion ?? null
      },
      claims: artifacts.claims,
      evidence,
      sources,
      challenges: artifacts.challenges,
      conflicts: artifacts.conflicts,
      verdicts,
      reviews,
      agentRuns,
      lastEventSequence,
      generatedAt: new Date().toISOString(),
      planItems
    });

    const format = request.query.format === "markdown" ? "markdown" : "json";
    if (format === "markdown") {
      const filename = `fact-check-report-${report.materialsFingerprint}.md`;
      if (request.query.download === "1") {
        reply.header(
          "content-disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
        );
      }
      reply.type("text/markdown; charset=utf-8");
      return renderFactCheckReportMarkdown(report);
    }
    return reply.send(report);
  });
}
