import { ReportNotReadyError } from "@nexus/db";
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../../app";

function toMarkdown(bundle: {
  session: unknown;
  project: unknown;
  report: {
    projectName: string;
    executiveSummary: string;
    decisionExplanation: string;
    requiredNextActions: string[];
    initialConclusion: string;
    postChallengeConclusion: string;
    humanAction: string;
    finalConclusion: string;
  };
  events: unknown[];
}): string {
  const report = bundle.report;
  return [
    `# ${report.projectName} - 决策报告`,
    "",
    "## 执行摘要",
    "",
    report.executiveSummary,
    "",
    "## 决策解释",
    "",
    report.decisionExplanation,
    "",
    "## 结论变化",
    "",
    `- 初始结论：${report.initialConclusion}`,
    `- 质询后结论：${report.postChallengeConclusion}`,
    `- 人工动作：${report.humanAction}`,
    `- 最终结论：${report.finalConclusion}`,
    "",
    "## 后续动作",
    "",
    ...report.requiredNextActions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 审计统计",
    "",
    `- ExecutionEvent 数量：${bundle.events.length}`,
    "",
    "## 原始审计数据",
    "",
    "完整 JSON 审计包可通过同一导出的 JSON 格式下载。",
    ""
  ].join("\n");
}

export function registerReportRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "sessions" | "reports" | "events">
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
      if (session.phase !== "DECIDED" && session.phase !== "REPORT_READY") {
        return reply
          .code(409)
          .send({ error: "Final report is not ready for this session phase" });
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

  app.get<{
    Params: { id: string };
    Querystring: { format?: string; download?: string };
  }>("/api/sessions/:id/audit", async (request, reply) => {
    if (!dependencies.reports) {
      return reply.code(501).send({ error: "Report repository unavailable" });
    }
    const [sessionView, project] = await Promise.all([
      dependencies.sessions.getView(request.params.id),
      dependencies.sessions.getProjectBySessionId(request.params.id)
    ]);
    if (!sessionView || !project) {
      return reply.code(404).send({ error: "Session not found" });
    }
    if (
      sessionView.phase !== "DECIDED" &&
      sessionView.phase !== "REPORT_READY"
    ) {
      return reply.code(409).send({ error: "Final report is not ready" });
    }

    const report =
      (await dependencies.reports.getBySessionId(request.params.id)) ??
      (await dependencies.reports.generateAndPersist(request.params.id));
    const events = await dependencies.events.listAfter(request.params.id, 0);
    const bundle = {
      generatedAt: new Date().toISOString(),
      session: sessionView,
      project,
      report,
      events
    };
    const format = request.query.format === "markdown" ? "markdown" : "json";
    const extension = format === "markdown" ? "md" : "json";
    const contentType =
      format === "markdown"
        ? "text/markdown; charset=utf-8"
        : "application/json; charset=utf-8";
    const filename = `${report.projectName.replace(/[^\p{L}\p{N}._-]+/gu, "-")}-audit.${extension}`;
    if (request.query.download === "1") {
      reply.header(
        "content-disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
    }
    reply.type(contentType);
    return format === "markdown" ? toMarkdown(bundle) : bundle;
  });
}