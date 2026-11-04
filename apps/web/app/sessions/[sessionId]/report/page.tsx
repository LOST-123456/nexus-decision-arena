import type {
  FinalReport,
  ReportEvidenceCoverage
} from "@nexus/shared";
import Link from "next/link";
import { cookies } from "next/headers";
import { ReportCoverageNotice } from "../../../../components/report-coverage-notice";
import { ReportExportActions } from "../../../../components/report-export-actions";
import {
  buildPlanRows,
  type PlanRow,
  type PlanSource
} from "../../../../features/report/plan-rows";

const apiUrl =
  process.env.API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://127.0.0.1:4100";

/**
 * 计划表只读三样东西：质询本身、提出角色、被质疑主张的原文。
 * 其余字段一律不用，避免把无关数据混进「已核实」的观感里。
 */
type SessionDetail = PlanSource;


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

async function loadLiveReport(
  sessionId: string
): Promise<{ report: FinalReport; coverage: ReportEvidenceCoverage | null }> {
  /**
   * The cookie has to be carried over by hand.
   *
   * The browser reaches the API through the Next rewrite proxy, which
   * forwards cookies on its own. This is a server component, and its fetch
   * goes straight to the core — so without this header the request arrives
   * anonymous, the session guard answers 401, and the page renders
   * "Authentication required" with no export button on it. The report was
   * there the whole time; nobody was allowed to see it.
   */
  const cookieHeader = (await cookies()).toString();
  const response = await fetch(
    `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}/report`,
    {
      cache: "no-store",
      ...(cookieHeader ? { headers: { cookie: cookieHeader } } : {})
    }
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(
      payload?.error ?? `Report request failed: ${response.status}`
    );
  }
  /**
   * 覆盖率由服务端算好一并返回，页面只负责显示。
   *
   * 报告接口多带一个 `evidenceCoverage` 字段：页面、Markdown 导出、审计包
   * 三个出口必须是同一个数字。页面自己再算一遍，就成了两套判断，迟早对不上。
   */
  const payload = (await response.json()) as FinalReport & {
    evidenceCoverage?: ReportEvidenceCoverage;
  };
  const { evidenceCoverage, ...report } = payload;
  return { report: report as FinalReport, coverage: evidenceCoverage ?? null };
}

/**
 * 计划表需要质询原文和提出角色，这些不在报告对象里。
 * 取不到就返回 null，页面回退到有序列表 —— 少一张表不能变成整页报错。
 */
async function loadSessionDetail(
  sessionId: string
): Promise<SessionDetail | null> {
  const cookieHeader = (await cookies()).toString();
  try {
    const response = await fetch(
      `${apiUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
      {
        cache: "no-store",
        ...(cookieHeader ? { headers: { cookie: cookieHeader } } : {})
      }
    );
    if (!response.ok) return null;
    return (await response.json()) as SessionDetail;
  } catch {
    return null;
  }
}

function ReportDocument({
  report,
  fixture,
  coverage = null,
  planRows = [],
  missingMaterial = 0,
  mergedDuplicates = 0
}: {
  report: FinalReport;
  fixture: boolean;
  coverage?: ReportEvidenceCoverage | null;
  planRows?: PlanRow[];
  missingMaterial?: number;
  mergedDuplicates?: number;
}) {
  const decisiveCount = planRows.filter((row) => row.decisive).length;
  const planNotes = [
    missingMaterial > 0
      ? `另有 ${missingMaterial} 条质询未记录所需材料，无法生成待办事项。`
      : "",
    mergedDuplicates > 0
      ? `${mergedDuplicates} 条质询与已有条目针对同一主张、需要同一份材料，已合并。`
      : ""
  ]
    .filter((note) => note !== "")
    .join(" ");
  return (
    <article className="report-document">
      {/*
        放在结论之前，不是之后。读报告的人第一件要判断的事是"这份东西能不能
        拿去决策"，而不是"结论是什么"。放到底部就成了没人读到的免责声明。
      */}
      {coverage ? <ReportCoverageNotice coverage={coverage} /> : null}

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
        <p className="eyebrow">02 / ACTION PLAN</p>
        <h2>执行计划</h2>
        {planRows.length > 0 ? (
          <div className="report-plan-wrap">
            <table className="report-plan">
              <caption>
                {planRows.length} 项待补齐材料，其中 {decisiveCount}{" "}
                项由本次裁决直接采纳。必办＝本次裁决采纳的质询，参考＝其余质询，是否纳入由人判断。每一行都能追溯到一条具体质询。
                {planNotes === "" ? "" : ` ${planNotes}`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">待办事项</th>
                  <th scope="col">针对的主张</th>
                  <th scope="col">提出角色</th>
                  <th scope="col">严重度</th>
                  <th scope="col">本次采纳</th>
                </tr>
              </thead>
              <tbody>
                {planRows.map((row, index) => (
                  <tr key={row.key}>
                    <td className="report-plan-index" data-label="序号">
                      {String(index + 1).padStart(2, "0")}
                    </td>
                    <td className="report-plan-action" data-label="待办事项">
                      {row.action}
                    </td>
                    <td
                      className="report-plan-basis"
                      data-label="针对的主张"
                      {...(row.basis === row.basisFull
                        ? {}
                        : { title: row.basisFull })}
                    >
                      {row.basis === "" ? "未记录被质疑的主张" : row.basis}
                    </td>
                    <td className="report-plan-role" data-label="提出角色">
                      {row.raisedBy}
                    </td>
                    <td className="report-plan-sevcell" data-label="严重度">
                      {/* 包一层 span：手机端这个单元格是 grid，裸文字节点会被当成
                          独立的网格项跟 ::before 抢列。 */}
                      <span>
                        {row.severityLabel}
                        <span className="report-plan-sev">
                          {" "}
                          {row.severity}/5
                        </span>
                      </span>
                    </td>
                    <td data-label="本次采纳">
                      <span
                        className={
                          row.decisive
                            ? "report-plan-status is-decisive"
                            : "report-plan-status"
                        }
                      >
                        {row.decisive ? "必办" : "参考"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ol>
            {report.requiredNextActions.map((action, index) => (
              <li key={action}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                {action}
              </li>
            ))}
          </ol>
        )}
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
      <main id="main" tabIndex={-1} data-demo-fixture="true" className="report-shell">
        <header className="report-header">
          <nav className="ui-breadcrumbs" aria-label="面包屑">
            <Link href="/">首页</Link>
            <Link href="/sessions/demo">固定演示</Link>
            <span>决策报告</span>
          </nav>
          <div className="flex items-center gap-3">
            <span className="report-status">DEMO FIXTURE</span>
            <span className="report-status">REPORT READY</span>
            <ReportExportActions
              kind="decision"
              sessionId={sessionId}
              demoReport={fixtureReport}
            />
          </div>
        </header>
        <ReportDocument report={fixtureReport} fixture />
      </main>
    );
  }

  let report: FinalReport | null = null;
  let coverage: ReportEvidenceCoverage | null = null;
  let errorMessage: string | null = null;
  try {
    const loaded = await loadLiveReport(sessionId);
    report = loaded.report;
    coverage = loaded.coverage;
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "无法加载报告";
  }
  const detail = report ? await loadSessionDetail(sessionId) : null;
  const plan = report
    ? buildPlanRows(report.decisiveChallengeIds, detail)
    : { rows: [], missingMaterial: 0, mergedDuplicates: 0 };

  return (
    <main id="main" tabIndex={-1} data-report-source="live" className="report-shell">
      <header className="report-header">
        <nav className="ui-breadcrumbs" aria-label="面包屑">
          <Link href="/">首页</Link>
          <Link href={`/sessions/${sessionId}`}>会话 {sessionId.slice(0, 8)}</Link>
          <span>决策报告</span>
        </nav>
        <div className="flex items-center gap-3">
          <span className="report-status">LIVE SESSION</span>
          <span className="report-status">
            {report ? "REPORT READY" : "REPORT PENDING"}
          </span>
          {report ? (
            <ReportExportActions kind="decision" sessionId={sessionId} />
          ) : null}
        </div>
      </header>
      {report ? (
        <ReportDocument
          report={report}
          fixture={false}
          coverage={coverage}
          planRows={plan.rows}
          missingMaterial={plan.missingMaterial}
          mergedDuplicates={plan.mergedDuplicates}
        />
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
