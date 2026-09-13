"use client";

import type { FinalReport } from "@nexus/shared";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function fixtureMarkdown(report: FinalReport): string {
  return [
    `# ${report.projectName}`,
    "",
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
    ""
  ].join("\n");
}

export function ReportExportActions({
  sessionId,
  report,
  fixture
}: {
  sessionId: string;
  report: FinalReport;
  fixture: boolean;
}) {
  function exportJson(): void {
    downloadText(
      "Nexus-Decision-Report.json",
      JSON.stringify({ source: fixture ? "demo-fixture" : "persisted", sessionId, report }, null, 2),
      "application/json"
    );
  }

  function exportMarkdown(): void {
    downloadText(
      "Nexus-Decision-Report.md",
      fixtureMarkdown(report),
      "text/markdown"
    );
  }

  return (
    <div className="report-export-actions">
      <button type="button" onClick={() => window.print()}>
        导出 PDF
      </button>
      <button type="button" onClick={exportMarkdown}>
        导出 Markdown
      </button>
      <button type="button" onClick={exportJson}>
        导出 JSON
      </button>
      {!fixture ? (
        <>
          <a
            href={`${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/audit?format=markdown&download=1`}
          >
            完整 MD 审计
          </a>
          <a
            href={`${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/audit?format=json&download=1`}
          >
            完整 JSON 审计
          </a>
        </>
      ) : null}
    </div>
  );
}