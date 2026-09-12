import type { FinalReport } from "@nexus/shared";
import Link from "next/link";

const apiUrl =
  process.env.API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://127.0.0.1:4100";

const fixtureReport: FinalReport = {
  id: "00000000-0000-7000-8000-000000000701",
  sessionId: "00000000-0000-7000-8000-000000000702",
  projectName: "高校实验室 AI 危化品库存与安全预警平台",
  executiveSummary:
    "项目方向具备必要性，但扩张、开发周期、毛利率和采购周期证据不足。",
  initialConclusion: "建议立项",
  postChallengeConclusion: "暂缓规模化扩张",
  humanAction: "采纳关键质询",
  finalConclusion: "有限立项",
  decisionExplanation:
    "先在 3 间实验室验证 12 个月，设置阶段验收门槛，验证通过后再讨论扩张。",
  requiredNextActions: [
    "取得 3 间实验室的试点确认",
    "提交硬件兼容性原型报告",
    "建立包含实施成本的单位经济模型",
    "取得采购周期和合规责任的外部依据"
  ],
  decisiveChallengeIds: [
    "00000000-0000-7000-8000-000000000711",
    "00000000-0000-7000-8000-000000000712",
    "00000000-0000-7000-8000-000000000713",
    "00000000-0000-7000-8000-000000000714",
    "00000000-0000-7000-8000-000000000715"
  ],
  evidenceIds: [],
  humanDecisionId: "00000000-0000-7000-8000-000000000721",
  createdAt: "2026-09-10T04:00:00.000Z",
  updatedAt: "2026-09-10T04:00:00.000Z"
};

async function loadLiveReport(sessionId: string): Promise<FinalReport> {
  const response = await fetch(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/report`,
    { cache: "no-store" }
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(
      payload?.error ?? `Report request failed: ${response.status}`
    );
  }
  return response.json() as Promise<FinalReport>;
}

function ReportDocument({
  report,
  fixture
}: {
  report: FinalReport;
  fixture: boolean;
}) {
  return (
    <article className="report-document">
      <div className="report-hero">
        <p className="eyebrow">DECISION REPORT</p>
        <h1>{report.finalConclusion}</h1>
        <p>{report.executiveSummary}</p>
      </div>

      <section className="report-section">
        <p className="eyebrow">01 / EXPLANATION</p>
        <h2>决策解释</h2>
        <p>{report.decisionExplanation}</p>
      </section>

      <section className="report-section">
        <p className="eyebrow">02 / NEXT ACTIONS</p>
        <h2>后续动作</h2>
        <ol>
          {report.requiredNextActions.map((action, index) => (
            <li key={action}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {action}
            </li>
          ))}
        </ol>
      </section>

      <section className="report-section">
        <p className="eyebrow">03 / TRACEABILITY</p>
        <h2>裁决依据</h2>
        <p>
          {report.decisiveChallengeIds.length} 项关键质询，
          {report.evidenceIds.length} 项关联证据，
          {report.humanDecisionId ? " 已关联人工裁决。" : " 尚无人工裁决。"}
        </p>
      </section>

      <footer className="report-footer">
        <span>INITIAL: {report.initialConclusion}</span>
        <span>CHALLENGED: {report.postChallengeConclusion}</span>
        <span>HUMAN: {report.humanAction}</span>
        <span>FINAL: {report.finalConclusion}</span>
        {fixture ? <span>SOURCE: DEMO FIXTURE</span> : <span>SOURCE: PERSISTED</span>}
      </footer>
    </article>
  );
}

export default async function ReportPage({
  params
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const fixture = sessionId === "demo";

  if (fixture) {
    return (
      <main data-demo-fixture="true" className="report-shell">
        <header className="report-header">
          <Link className="brand-lockup brand-lockup-compact" href="/sessions/demo">
            <span className="brand-mark" aria-hidden="true">N</span>
            <span>
              <strong>Nexus Decision Arena</strong>
              <small>SESSION / {sessionId}</small>
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="report-status">DEMO FIXTURE</span>
            <span className="report-status">REPORT READY</span>
          </div>
        </header>
        <ReportDocument report={fixtureReport} fixture />
      </main>
    );
  }

  let report: FinalReport | null = null;
  let errorMessage: string | null = null;
  try {
    report = await loadLiveReport(sessionId);
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Report could not be loaded";
  }

  return (
    <main data-report-source="live" className="report-shell">
      <header className="report-header">
        <Link className="brand-lockup brand-lockup-compact" href={`/sessions/${sessionId}`}>
          <span className="brand-mark" aria-hidden="true">N</span>
          <span>
            <strong>Nexus Decision Arena</strong>
            <small>SESSION / {sessionId}</small>
          </span>
        </Link>
        <div className="flex items-center gap-3">
          <span className="report-status">LIVE SESSION</span>
          <span className="report-status">
            {report ? "REPORT READY" : "REPORT PENDING"}
          </span>
        </div>
      </header>
      {report ? (
        <ReportDocument report={report} fixture={false} />
      ) : (
        <article className="report-document">
          <div className="report-hero">
            <p className="eyebrow">DECISION REPORT</p>
            <h1>报告尚不可用</h1>
            <p>{errorMessage}</p>
          </div>
        </article>
      )}
    </main>
  );
}
