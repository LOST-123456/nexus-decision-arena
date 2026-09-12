import { ReportNotReadyError } from "@nexus/db";
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../../app";

export function registerReportRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "sessions" | "reports">
): void {
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/report",
    async (request, reply) => {
      if (!dependencies.reports) {
        return reply.code(501).send({ error: "Report repository unavailable" });
      }
      const session = await dependencies.sessions.getById(request.params.id);
      if (!session) {
        return reply.code(404).send({ error: "Session not found" });
      }
      try {
        const report =
          (await dependencies.reports.getBySessionId(request.params.id)) ??
          (await dependencies.reports.generateAndPersist(request.params.id));
        return reply.send(report);
      } catch (error) {
        if (error instanceof ReportNotReadyError) {
          return reply.code(409).send({ error: error.message });
        }
        throw error;
      }
    }
  );
}
