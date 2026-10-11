import { EvidenceMapGraphSchema } from "@nexus/shared";
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../../app";
import { projectEvidenceMap } from "../../research/evidence-map-projection";
import { ResearchWorkspaceService } from "../../research/workspace-service";

/**
 * Read-only Evidence Map endpoint.
 *
 * The graph is a projection of material that already exists, so this route is
 * a GET and nothing else: there is no endpoint here that could create
 * evidence, change a verdict or touch the research plan. A viewer may read it
 * — the map only shows what the workspace already shows, drawn as a graph.
 *
 * The projection is computed on every read from the same rows the research
 * workspace reads. That is deliberate: a cached projection would need event
 * hooks inside the write paths (which this build refuses to modify), and the
 * per-session datasets are small enough that computing on read is cheaper
 * than the machinery to keep a cache honest.
 */
export function registerEvidenceMapRoutes(
  app: FastifyInstance,
  dependencies: Pick<
    AppDependencies,
    "auth" | "sessions" | "evidence" | "arena" | "reviews"
  >
): void {
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/evidence-map",
    async (request, reply) => {
      const user = dependencies.auth?.userFromRequest(request) ?? null;
      if (dependencies.auth && !user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (
        !dependencies.evidence ||
        !dependencies.arena ||
        !dependencies.sessions ||
        !dependencies.reviews
      ) {
        return reply.code(501).send({ error: "Evidence map is not configured" });
      }
      const service = new ResearchWorkspaceService({
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
      const workspace = await service.getWorkspace(request.params.id);
      if (!workspace) {
        return reply.code(404).send({ error: "Session not found" });
      }
      return EvidenceMapGraphSchema.parse(projectEvidenceMap(workspace));
    }
  );
}
