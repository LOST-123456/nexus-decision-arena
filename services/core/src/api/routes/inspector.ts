import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../../app";

export function registerInspectorRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "inspector">
): void {
  app.get<{ Params: { sessionId: string; claimId: string } }>(
    "/api/sessions/:sessionId/claims/:claimId/inspector",
    async (request, reply) => {
      const inspector = await dependencies.inspector.getInspector(
        request.params.sessionId,
        request.params.claimId
      );

      if (inspector === null) {
        return reply.code(404).send({ error: "Inspector data not found" });
      }

      return reply.send(inspector);
    }
  );
}
