"use client";

import { useCallback, useEffect, useState } from "react";
import { getFactCheckReport, type FactCheckReport } from "./api";
import { FactCheckReportBody } from "./fact-check-report-body";
import { ReportComparePanel, ReportVersionsPanel } from "./report-versions";

type ReportTab = "current" | "history" | "compare";

const REPORT_TABS: Array<{ id: ReportTab; label: string }> = [
  { id: "current", label: "当前报告" },
  { id: "history", label: "历史版本" },
  { id: "compare", label: "版本比较" }
];

export function FactCheckReportView({ sessionId }: { sessionId: string }) {
  const [report, setReport] = useState<FactCheckReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<ReportTab>("current");

  const load = useCallback(async () => {
    try {
      const next = await getFactCheckReport(sessionId);
      setReport(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "报告生成失败");
    }
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await getFactCheckReport(sessionId);
        if (!cancelled) setReport(next);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "报告生成失败");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (error) {
    return (
      <div className="research-report-shell">
        <p className="research-error" role="alert">
          {error}
        </p>
        <p className="research-muted" style={{ marginTop: 8 }}>
          报告无法生成。请确认该会话存在，并且后端已启用核查报告服务。
        </p>
        <button type="button" className="research-button" onClick={load}>
          重新生成
        </button>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="research-report-shell">
        <div className="research-empty">正在从持久化资料生成核查报告…</div>
      </div>
    );
  }

  return (
    <div className="research-report-shell">
      {/*
        Three views of one report: the live one, the versions that were saved,
        and the difference between two of them. The live report stays the
        default view so the page a reader lands on is the current state.
      */}
      <div
        className="research-tabs"
        role="tablist"
        aria-label="报告视图"
        data-testid="report-view-tabs"
      >
        {REPORT_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            className="research-tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "current" ? (
        <FactCheckReportBody report={report} sessionId={sessionId} />
      ) : null}
      {tab === "history" ? (
        <ReportVersionsPanel
          sessionId={sessionId}
          currentFingerprint={report.materialsFingerprint}
        />
      ) : null}
      {tab === "compare" ? <ReportComparePanel sessionId={sessionId} /> : null}
    </div>
  );
}
