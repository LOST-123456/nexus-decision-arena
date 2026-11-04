"use client";

import { useState, type MouseEvent } from "react";
import type { FinalReport } from "@nexus/shared";
import {
  decisionReportFileStem,
  renderDecisionReportMarkdown
} from "@nexus/shared";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

/** Which report the page is showing. Only the export urls differ. */
export type ReportExportKind = "decision" | "fact-check";

/**
 * Every export a report offers, in one table.
 *
 * The two report pages used to disagree about what could be taken out of them:
 * the decision report offered five exits, three of which were composed in the
 * browser out of whatever fields the page happened to hold, and the fact-check
 * report offered two. A reader who wanted the file of the document they were
 * reading got a different document, depending on which kind of report it was.
 *
 * Now there are three exits and they are the same three on both pages:
 *
 *   1. the page itself, printed to PDF;
 *   2. the report document as Markdown — rendered by the server from the same
 *      object the page is drawn from (`renderDecisionReportMarkdown` for the
 *      decision report, the report's own renderer for the fact-check one);
 *   3. the audit package — everything the report rests on, as JSON.
 *
 * The third used to exist only for the decision report. It belongs to both: a
 * reader outside the workspace who is told a claim was checked needs the trail
 * of events behind it, not just the verdict.
 */
function exportUrls(kind: ReportExportKind, sessionId: string) {
  const id = encodeURIComponent(sessionId);
  if (kind === "decision") {
    return {
      markdown: `${apiUrl}/api/sessions/${id}/report?format=markdown&download=1`,
      audit: `${apiUrl}/api/sessions/${id}/audit?format=json&download=1`
    };
  }
  return {
    markdown: `${apiUrl}/api/sessions/${id}/fact-check-report?format=markdown&download=1`,
    audit: `${apiUrl}/api/sessions/${id}/fact-check-report?format=audit&download=1`
  };
}

function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * The name the server asked for, when it said one.
 *
 * The server sets `Content-Disposition`, and it knows the report better than
 * this component does — the file stem can carry the project name.
 */
function filenameFromResponse(response: Response, fallback: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (!match?.[1]) return fallback;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function ReportExportActions({
  kind,
  sessionId,
  demoReport
}: {
  kind: ReportExportKind;
  sessionId: string;
  /**
   * Set only for the fixed demo, which has no stored report to export: there
   * is no row to ask the server for, so the Markdown is rendered here from the
   * same shared function the server uses. There is also no event log for a
   * demo, so its audit exit is not offered at all rather than offered and
   * failing.
   */
  demoReport?: FinalReport;
}) {
  const urls = exportUrls(kind, sessionId);
  const [busy, setBusy] = useState<"markdown" | "audit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Download through fetch instead of letting the browser follow the link.
   *
   * As a plain navigation, a failed export took the reader away from the
   * report: the backend answers 404/409/501 with a bare JSON body, and the
   * browser put that on screen in place of the document — page, breadcrumbs
   * and the other two exits all gone, with only the browser's back button
   * left. The link is still a real link (middle-click still saves the file),
   * but a left click now stays on the page and says what went wrong.
   */
  async function downloadFromServer(
    event: MouseEvent<HTMLAnchorElement>,
    url: string,
    variant: "markdown" | "audit",
    fallbackName: string
  ): Promise<void> {
    event.preventDefault();
    setBusy(variant);
    setError(null);
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          payload?.error ?? `导出失败（HTTP ${response.status}）。报告可能还没有生成。`
        );
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filenameFromResponse(response, fallbackName);
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "导出失败，请稍后重试。");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="report-export-actions"
      role="group"
      aria-label="报告导出"
      data-export-kind={kind}
    >
      <button
        type="button"
        data-testid="report-print"
        onClick={() => window.print()}
      >
        打印 / 导出 PDF
      </button>
      {demoReport ? (
        <button
          type="button"
          data-testid="report-markdown-download"
          onClick={() =>
            downloadText(
              `${decisionReportFileStem(demoReport)}.md`,
              renderDecisionReportMarkdown(demoReport),
              "text/markdown"
            )
          }
        >
          导出 Markdown
        </button>
      ) : (
        <a
          href={urls.markdown}
          data-testid="report-markdown-download"
          aria-busy={busy === "markdown"}
          onClick={(event) =>
            void downloadFromServer(
              event,
              urls.markdown,
              "markdown",
              `${sessionId}.md`
            )
          }
        >
          {busy === "markdown" ? "导出中..." : "导出 Markdown"}
        </a>
      )}
      {demoReport ? (
        <span className="report-export-note">演示数据没有审计日志</span>
      ) : (
        <a
          href={urls.audit}
          data-testid="report-audit-download"
          aria-busy={busy === "audit"}
          onClick={(event) =>
            void downloadFromServer(
              event,
              urls.audit,
              "audit",
              `${sessionId}-audit.json`
            )
          }
        >
          {busy === "audit" ? "导出中..." : "完整审计包（JSON）"}
        </a>
      )}
      {error ? (
        <span className="report-export-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
