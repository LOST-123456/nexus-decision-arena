import { ReportNotReadyError } from "@nexus/db";
import {
  coverageLevelLabel,
  computeReportEvidenceCoverage,
  decisionReportFileStem,
  renderDecisionReportMarkdown,
  type ReportEvidenceCoverage,
  type FinalReport
} from "@nexus/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { AppDependencies } from "../../app";
import {
  AUDIT_SCOPE_VALUES,
  resolveAuditScope,
  scopeArenaMaterials,
  type ArenaAuditMaterial,
  type AuditDisclosure
} from "../../reports/audit-delivery";

/**
 * The audit package in Markdown: what this file is, then the report document,
 * then the trail behind it.
 *
 * The delivery note goes first on purpose. A reader who receives this file
 * outside the workspace has no other way to know whether the unchecked
 * material was withheld or simply never existed.
 */
function toMarkdown(bundle: {
  report: FinalReport;
  events: unknown[];
  delivery: { disclosure: AuditDisclosure };
  materials: ArenaAuditMaterial[];
  coverage: ReportEvidenceCoverage | null;
}): string {
  const { disclosure } = bundle.delivery;
  return [
    "# 审计包交付说明",
    "",
    `- 交付口径：${disclosure.scope === "all" ? "全部保留并标注" : "仅已核实材料"}`,
    `- 材料条数：${bundle.materials.length}（其中已核实 ${bundle.materials.filter((item) => item.verificationStatus === "verified").length} 条）`,
    `- 未包含：证据 ${disclosure.withheld.materials} 条 / 引用 ${disclosure.withheld.citations} 条`,
    ...(bundle.coverage
      ? [
          `- 证据覆盖率：${coverageLevelLabel(bundle.coverage.level)}——${bundle.coverage.statement}`,
          `  ${bundle.coverage.usage}`
        ]
      : []),
    "",
    disclosure.statement,
    "",
    // 覆盖率跟着报告走，不受交付口径影响：口径只决定包里放多少材料，
    // 不重算、也不改写这一轮结论到底核实过多少。
    renderDecisionReportMarkdown(bundle.report, bundle.coverage ?? undefined),
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

function sendWithFilename(reply: FastifyReply, filename: string): void {
  reply.header(
    "content-disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
}

export function registerReportRoutes(
  app: FastifyInstance,
  dependencies: Pick<AppDependencies, "sessions" | "reports" | "events" | "evidence">
): void {
  app.get<{
    Params: { id: string };
    Querystring: { format?: string; download?: string };
  }>(
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
        /**
         * 证据覆盖率跟报告一起返回。
         *
         * 不放在前端算：页面、Markdown 导出、审计包三个出口必须是同一个数字，
         * 两个实现迟早会分叉，而分叉的后果是"页面上写着证据不足、下载的文件
         * 里没有这句"。
         */
        const view = await dependencies.sessions.getView(request.params.id);
        const coverage = view
          ? computeReportEvidenceCoverage(view.claims, view.evidence)
          : null;
        /*
         * The same object the page is drawn from, rendered for a file. The web
         * client used to compose its own Markdown and JSON from the report
         * fields it happened to hold, which made the download a second, lossy
         * document; `format` moves that rendering behind the data instead.
         */
        if (request.query.format === "markdown") {
          if (request.query.download === "1") {
            sendWithFilename(reply, `${decisionReportFileStem(report)}.md`);
          }
          reply.type("text/markdown; charset=utf-8");
          return reply.send(
            renderDecisionReportMarkdown(report, coverage ?? undefined)
          );
        }
        return reply.send(
          coverage ? { ...report, evidenceCoverage: coverage } : report
        );
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
    Querystring: { format?: string; download?: string; scope?: string };
  }>("/api/sessions/:id/audit", async (request, reply) => {
    if (!dependencies.reports) {
      return reply.code(501).send({ error: "Report repository unavailable" });
    }
    const scope = resolveAuditScope(request.query.scope);
    if (scope === null) {
      return reply.code(400).send({
        error: `Unknown audit scope. Expected one of ${AUDIT_SCOPE_VALUES.join(", ")}`
      });
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
    /*
     * The evidence behind the decision, labelled with the verification status
     * already recorded on each row. The package used to carry the verdict and
     * not one excerpt — an outside reader could not tell checked material from
     * unchecked, because none of it was there.
     */
    const evidence = dependencies.evidence
      ? await dependencies.evidence.listEvidence(request.params.id)
      : [];
    const { materials, disclosure } = scopeArenaMaterials(evidence, scope);
    /*
     * 覆盖率用全量证据算，不用 scope 收窄后的那份。
     * 交付口径管的是"包里放多少"，不是"核实过多少"——用收窄后的集合重算，
     * 会让一次 scope=verified 的导出看起来比实际更可靠。
     */
    const coverage = computeReportEvidenceCoverage(
      sessionView.claims,
      sessionView.evidence
    );
    const bundle = {
      generatedAt: new Date().toISOString(),
      session: sessionView,
      project,
      report,
      delivery: { disclosure },
      coverage,
      materials,
      events
    };
    const format = request.query.format === "markdown" ? "markdown" : "json";
    const extension = format === "markdown" ? "md" : "json";
    const contentType =
      format === "markdown"
        ? "text/markdown; charset=utf-8"
        : "application/json; charset=utf-8";
    const filename = `${decisionReportFileStem(report)}-审计包.${extension}`;
    if (request.query.download === "1") {
      sendWithFilename(reply, filename);
    }
    reply.type(contentType);
    return format === "markdown" ? toMarkdown(bundle) : bundle;
  });
}