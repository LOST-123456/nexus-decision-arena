import type { FastifyInstance } from "fastify";

export function registerHumanDecisionRoutes(app: FastifyInstance): void {
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/human-decisions",
    async (_request, reply) =>
      reply.code(501).send({
        error: "Human decision persistence is not wired yet"
      })
  );
}
