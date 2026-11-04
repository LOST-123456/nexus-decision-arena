import type { FinalReport } from "../domain/final-report";
import {
  coverageLevelLabel,
  type ReportEvidenceCoverage
} from "./evidence-coverage";

/**
 * The decision report as Markdown.
 *
 * One renderer, two callers: the API for `?format=markdown`, and the demo page
 * for the export it builds in the browser. The demo has no persisted row to
 * ask the server about, and the previous client-side copy drifted — it wrote a
 * three-section summary that left out the conclusion chain and the decision
 * basis, so the file a reader downloaded was not the document they were
 * reading.
 *
 * The rule this file exists to keep: an export is the document, not a summary
 * of it. Every section below is a section the report page renders, in the same
 * order, from the same fields. Nothing is added that the page never showed, and
 * nothing the page shows is dropped.
 */
export function renderDecisionReportMarkdown(
  report: FinalReport,
  /**
   * 证据覆盖率。传了就在正文最前面写一段"这份报告能用到什么程度"。
   *
   * 放在封面之后、执行摘要之前，是因为读者判断"要不要读下去"取决于这一句；
   * 放在文件末尾等于免责声明，没人会读到那里。可选参数是为了不破坏 demo
   * 那条没有数据库可查的导出路径。
   */
  coverage?: ReportEvidenceCoverage
): string {
  const lines: string[] = [
    `# ${report.projectName}`,
    "",
    "决策报告",
    "",
    ...(coverage ? coverageSection(coverage) : []),
    "## 执行摘要",
    "",
    report.executiveSummary,
    "",
    "## 决策解释",
    "",
    report.decisionExplanation,
    "",
    "## 后续动作",
    "",
    ...report.requiredNextActions.map((item, index) => `${index + 1}. ${item}`),
    "",
    "## 结论链",
    "",
    `- 初始结论：${report.initialConclusion}`,
    `- 质询后结论：${report.postChallengeConclusion}`,
    `- 人工动作：${report.humanAction}`,
    `- 最终结论：${report.finalConclusion}`,
    "",
    "## 裁决依据",
    "",
    `- 关键质询：${report.decisiveChallengeIds.length} 项`,
    ...report.decisiveChallengeIds.map((id) => `  - ${id}`),
    `- 关联证据：${report.evidenceIds.length} 项`,
    ...report.evidenceIds.map((id) => `  - ${id}`),
    `- 人工裁决：${report.humanDecisionId ?? "尚未记录"}`,
    "",
    "## 文件信息",
    "",
    `- 报告 ID：${report.id}`,
    `- 会话 ID：${report.sessionId}`,
    `- 生成时间：${report.createdAt}`,
    `- 最后更新：${report.updatedAt}`,
    ""
  ];

  return lines.join("\n");
}

/**
 * Filename stem a reader will recognise, and a different one for every report.
 *
 * The name used to be the constant `Nexus-Decision-Report`, so a reader who
 * downloaded two reports ended up with one file: the second download silently
 * replaced the first. A project name plus the report's own date separates them
 * without turning the filename into an id.
 */
export function decisionReportFileStem(report: FinalReport): string {
  const project = report.projectName
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const stamp = report.updatedAt.slice(0, 10);
  return `${project || "decision"}-决策报告-${stamp}`;
}

/**
 * 报告开头那段"这份东西能用到什么程度"。
 *
 * 与页面上的横幅同源：都从这里出，措辞才可能一致。导出的文件常常脱离
 * 工作区单独流转，读到它的人没有别的地方可以知道结论到底核实过没有。
 */
function coverageSection(coverage: ReportEvidenceCoverage): string[] {
  return [
    "## 证据覆盖率",
    "",
    `- 判定：${coverageLevelLabel(coverage.level)}`,
    `- ${coverage.statement}`,
    `- ${coverage.usage}`,
    `- 已核实证据：${coverage.verifiedEvidence} / ${coverage.totalEvidence} 条`,
    ""
  ];
}
