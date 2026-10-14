import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppDependencies } from "../../app";
import type { ResearchQualityService } from "../../research/research-quality-service";

/**
 * Read-only research quality endpoints.
 *
 * Every route here is a GET and every one of them answers from a projection of
 * rows that already exist: there is no endpoint in this file that could create
 * evidence, change a verdict, touch a ruling or rewrite a saved report. A
 * viewer may read them — the assessment shows exactly what the workspace
 * already shows, organised by rule.
 *
 * Session scoping is structural rather than advisory: the projection is built
 * from the session's own workspace, so an id from another research task simply
 * has no rows to read and answers 404. No claim id, evidence id or source id
 * is accepted from the client anywhere in this file, which is what keeps a
 * forged id from reaching across sessions.
 */

const FindingsQuerySchema = z.object({
  severity: z.enum(["info", "warning", "critical"]).optional(),
  category: z
    .enum([
      "missing_evidence",
      "unverified_evidence",
      "single_source_dependency",
      "unresolved_conflict",
      "unanswered_challenge",
      "broken_citation",
      "stale_source",
      "open_research_gap",
      "insufficient_independence",
      "duplicate_source",
      "missing_source_record",
      "publisher_concentration"
    ])
    .optional(),
  limit: z.coerce.number().int().positive().max(500).optional()
});

export function registerResearchQualityRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "auth" | "researchQuality">
): void {
  const configured = dependencies.researchQuality as
    | ResearchQualityService
    | undefined;

  /**
   * The shared gate: authentication when auth is configured, and a 501 when
   * the assessment service is not wired. Returning 501 rather than an empty
   * body keeps "not configured" distinguishable from "nothing to report".
   * A viewer passes: reading an assessment writes nothing.
   */
  function guard(
    request: FastifyRequest,
    reply: { code: (code: number) => { send: (body: unknown) => unknown } }
  ): ResearchQualityService | null {
    const user = dependencies.auth?.userFromRequest(request) ?? null;
    if (dependencies.auth && !user) {
      reply.code(401).send({ error: "Authentication required" });
      return null;
    }
    if (!configured) {
      reply
        .code(501)
        .send({ error: "Research quality assessment is not configured" });
      return null;
    }
    return configured;
  }

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/research-quality",
    async (request, reply) => {
      const quality = guard(request, reply);
      if (!quality) return;
      const assessment = await quality.assess(request.params.id);
      if (!assessment) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return assessment;
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/research-quality/claims",
    async (request, reply) => {
      const quality = guard(request, reply);
      if (!quality) return;
      const claims = await quality.assessClaims(request.params.id);
      if (!claims) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return claims;
    }
  );

  app.get<{
    Params: { id: string };
    Querystring: { severity?: string; category?: string; limit?: string };
  }>("/api/sessions/:id/research-quality/findings", async (request, reply) => {
    const quality = guard(request, reply);
    if (!quality) return;
    const parsed = FindingsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid findings filter",
        details: parsed.error.issues.map((issue) => issue.message)
      });
    }
    const findings = await quality.assessFindings(
      request.params.id,
      parsed.data
    );
    if (!findings) {
      return reply.code(404).send({ error: "Session not found" });
    }
    return findings;
  });
}
