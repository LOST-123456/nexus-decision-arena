import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId, type FinalReport } from "@nexus/shared";
import { ReportExportActions } from "./report-export-actions";

/**
 * The export contract both report pages share.
 *
 * What went wrong before: the decision report offered five exits, three of them
 * composed in the browser out of a subset of the report, and the fact-check
 * report offered two. So "export the report" produced two different documents
 * depending on which report it was, and neither matched the page for the
 * decision report. These tests pin the property that fixes it — the same set of
 * exits, in the same order, on both pages — rather than the markup of any one
 * of them.
 */

function report(): FinalReport {
  const timestamp = "2026-10-27T09:00:00.000Z";
  return {
    id: newId(),
    sessionId: newId(),
    projectName: "某项目",
    executiveSummary: "摘要",
    initialConclusion: "建议立项",
    postChallengeConclusion: "暂缓扩张",
    humanAction: "采纳关键质询",
    finalConclusion: "有限立项",
    decisionExplanation: "先试点。",
    requiredNextActions: ["取得试点确认"],
    decisiveChallengeIds: [],
    evidenceIds: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

afterEach(cleanup);

describe("ReportExportActions", () => {
  it("offers the same three exits for a decision report and a fact-check report", () => {
    const sessionId = newId();

    const { unmount } = render(
      <ReportExportActions kind="decision" sessionId={sessionId} />
    );
    const decisionLabels = screen
      .getAllByRole("button")
      .concat(screen.queryAllByRole("link"))
      .map((node) => node.textContent);
    unmount();

    render(<ReportExportActions kind="fact-check" sessionId={sessionId} />);
    const factCheckLabels = screen
      .getAllByRole("button")
      .concat(screen.queryAllByRole("link"))
      .map((node) => node.textContent);

    expect(factCheckLabels).toEqual(decisionLabels);
    expect(decisionLabels).toEqual([
      "打印 / 导出 PDF",
      "导出 Markdown",
      "完整审计包（JSON）"
    ]);
  });

  it("points the decision report at the report route, not at the browser copy", () => {
    const sessionId = newId();
    render(<ReportExportActions kind="decision" sessionId={sessionId} />);

    const markdown = screen.getByTestId("report-markdown-download");
    expect(markdown.getAttribute("href")).toContain(
      `/api/sessions/${sessionId}/report?format=markdown`
    );
    expect(markdown.getAttribute("href")).toContain("download=1");
    // A real download link: the file comes from the server that holds the
    // report, so it cannot be a stale subset of it.
    expect(markdown.tagName).toBe("A");
  });

  it("gives the fact-check report the audit package it did not have", () => {
    const sessionId = newId();
    render(<ReportExportActions kind="fact-check" sessionId={sessionId} />);

    expect(
      screen.getByTestId("report-audit-download").getAttribute("href")
    ).toContain(
      `/api/sessions/${sessionId}/fact-check-report?format=audit&download=1`
    );
  });

  it("does not offer an audit package for the demo, which has no trail", () => {
    render(
      <ReportExportActions
        kind="decision"
        sessionId="demo"
        demoReport={report()}
      />
    );

    expect(screen.queryByTestId("report-audit-download")).toBeNull();
    expect(screen.getByText("演示数据没有审计日志")).toBeTruthy();
  });

  it("keeps the demo's Markdown export instead of linking to a route that 404s", () => {
    render(
      <ReportExportActions
        kind="decision"
        sessionId="demo"
        demoReport={report()}
      />
    );

    const markdown = screen.getByTestId("report-markdown-download");
    // Rendered in the browser from the shared renderer, so it is a button.
    expect(markdown.tagName).toBe("BUTTON");
    expect(markdown.getAttribute("href")).toBeNull();
  });

  it("prints the page for PDF rather than pretending to render one", () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);

    render(<ReportExportActions kind="decision" sessionId={newId()} />);
    screen.getByTestId("report-print").click();

    expect(print).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
