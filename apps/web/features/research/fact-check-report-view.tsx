"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ClaimVerdictStatus } from "@nexus/shared";
import {
  citationStatusLabel,
  citationStatusTone,
  directionLabel,
  formatDate,
  reviewOutcomeLabel,
  reviewOutcomeTone,
  runPurposeLabel,
  runStatusLabel,
  runStatusTone,
  sourceKindLabel,
  verificationLabel,
  verificationTone,
  verdictLabel,
  verdictTone
} from "./labels";
import {
  factCheckReportMarkdownUrl,
  getFactCheckReport,
  type FactCheckReport,
  type ReportCitation
} from "./api";
import { StatusPill } from "./components";

function CitationBlock({ citation }: { citation: ReportCitation }) {
  return (
    <div className="research-report-citation" data-direction={citation.direction}>
      <div className="research-claim-meta">
        <StatusPill tone={directionToneFor(citation.direction)}>
          {directionLabel(citation.direction)}
        </StatusPill>
        <StatusPill tone={verificationTone(citation.verificationStatus)}>
          {verificationLabel(citation.verificationStatus)}
        </StatusPill>
        <StatusPill tone={citationStatusTone(citation.citationStatus)}>
          {citationStatusLabel(citation.citationStatus)}
        </StatusPill>
      </div>
      <div>
        <strong>{citation.title}</strong>
      </div>
      <p className="research-report-quote">{citation.excerpt}</p>
      <div className="research-muted">
        来源：
        {citation.source
          ? `${citation.source.title}（${sourceKindLabel(citation.source.kind)}）${
              citation.source.publisher ? ` · ${citation.source.publisher}` : ""
            }`
          : "未登记来源"}
        {citation.locator ? ` · 定位 ${citation.locator}` : ""}
        {citation.sourceRef ? ` · ${citation.sourceRef}` : ""}
        {citation.source?.url ? (
          <>
            {" · "}
            <a href={citation.source.url} target="_blank" rel="noreferrer">
              原始链接
            </a>
          </>
        ) : null}
      </div>
      <div className="research-muted">
        可靠度 {citation.reliability.toFixed(2)}
        {citation.verifiedBy ? ` · 核实人 ${citation.verifiedBy}` : ""}
        {citation.verificationNote ? ` · ${citation.verificationNote}` : ""}
      </div>
    </div>
  );
}

function directionToneFor(direction: ReportCitation["direction"]): string {
  if (direction === "supports") return "research-pill-supports";
  if (direction === "opposes") return "research-pill-opposes";
  return "research-pill-context";
}

export function FactCheckReportView({ sessionId }: { sessionId: string }) {
  const [report, setReport] = useState<FactCheckReport | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="research-report-shell" data-testid="fact-check-report">
      <div className="research-report-head">
        <div>
          <p className="research-label">FACT CHECK REPORT</p>
          <h1 className="research-question">
            {report.researchQuestion ?? "（未填写研究问题）"}
          </h1>
          <p className="research-muted" data-testid="report-meta">
            生成时间 {report.generatedAt} · 报告版本 v{report.reportVersion} ·
            材料指纹 <code>{report.materialsFingerprint}</code>
          </p>
          <p className="research-muted">
            核查范围：{report.scope.claims} 条主张 / {report.scope.evidence} 条材料 /{" "}
            {report.scope.sources} 个来源 / {report.scope.challenges} 项质询 /{" "}
            {report.scope.reviews} 条人工裁定 / {report.scope.agentRuns} 次 Agent 运行
          </p>
        </div>
        <div className="research-report-actions">
          <button
            type="button"
            className="research-button research-button-secondary"
            onClick={() => window.print()}
          >
            打印 / 导出 PDF
          </button>
          <a
            className="research-button"
            href={factCheckReportMarkdownUrl(sessionId)}
            data-testid="report-markdown-download"
          >
            下载 Markdown
          </a>
        </div>
      </div>

      <section className="research-report-section">
        <h2>结论概览</h2>
        <div className="research-claim-meta">
          {Object.entries(report.summary.byStatus).map(([status, count]) => {
            const known = status as ClaimVerdictStatus;
            return (
              <StatusPill key={status} tone={verdictTone(known)}>
                {verdictLabel(known)}：{count}
              </StatusPill>
            );
          })}
          <StatusPill tone="research-pill-unverified">
            仍需处理的主张：{report.summary.openVerdicts}
          </StatusPill>
          <StatusPill tone="research-pill-neutral">
            已核实 {report.summary.verified} / 待核实 {report.summary.unverified} / 已驳回{" "}
            {report.summary.rejected}
          </StatusPill>
        </div>
      </section>

      <section className="research-report-section">
        <h2>逐条主张的核查结论（{report.findings.length}）</h2>
        {report.findings.length === 0 ? (
          <div className="research-empty">该会话还没有主张。</div>
        ) : (
          report.findings.map((finding) => (
            <article
              key={finding.claimId}
              className="research-report-finding"
              data-testid="report-finding"
            >
              <div className="research-claim-meta">
                <StatusPill tone={verdictTone(finding.verdict.status)}>
                  核查结论：{verdictLabel(finding.verdict.status)}
                </StatusPill>
                {finding.verdict.effectiveStatus !== finding.verdict.status ? (
                  <StatusPill tone={verdictTone(finding.verdict.effectiveStatus)}>
                    对外结论：{verdictLabel(finding.verdict.effectiveStatus)}
                  </StatusPill>
                ) : null}
                <span className="research-muted">
                  把握度 {Math.round(finding.verdict.confidence * 100)}% · 类型{" "}
                  {finding.type} · 重要性 {finding.importance}
                </span>
              </div>
              <p className="research-question">{finding.statement}</p>
              <p className="research-muted">{finding.verdict.rationale}</p>

              {finding.verdict.openQuestions.length > 0 ? (
                <div>
                  <div className="research-label">交叉审查未解决的问题</div>
                  <ul className="research-plain-list">
                    {finding.verdict.openQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {finding.verdict.limits.length > 0 ? (
                <div>
                  <div className="research-label">适用范围与限制</div>
                  <ul className="research-plain-list">
                    {finding.verdict.limits.map((limit) => (
                      <li key={limit}>{limit}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="research-label">支持证据（{finding.supporting.length}）</div>
              {finding.supporting.length === 0 ? (
                <p className="research-muted">没有支持该主张的已登记材料。</p>
              ) : (
                finding.supporting.map((citation) => (
                  <CitationBlock key={citation.evidenceId} citation={citation} />
                ))
              )}

              <div className="research-label">反对证据（{finding.opposing.length}）</div>
              {finding.opposing.length === 0 ? (
                <p className="research-muted">没有反对该主张的已登记材料。</p>
              ) : (
                finding.opposing.map((citation) => (
                  <CitationBlock key={citation.evidenceId} citation={citation} />
                ))
              )}

              <div className="research-label">背景材料（{finding.context.length}）</div>
              {finding.context.length === 0 ? (
                <p className="research-muted">没有背景材料。</p>
              ) : (
                finding.context.map((citation) => (
                  <CitationBlock key={citation.evidenceId} citation={citation} />
                ))
              )}

              {finding.excluded.length > 0 ? (
                <>
                  <div className="research-label">
                    未参与结论的材料（{finding.excluded.length}）
                  </div>
                  {finding.excluded.map((citation) => (
                    <CitationBlock key={citation.evidenceId} citation={citation} />
                  ))}
                </>
              ) : null}

              {finding.challenges.length > 0 ? (
                <>
                  <div className="research-label">交叉审查发现</div>
                  <ul className="research-plain-list">
                    {finding.challenges.map((challenge) => (
                      <li key={challenge.challengeId}>
                        <div className="research-claim-meta">
                          <StatusPill tone="research-pill-neutral">
                            严重度 {challenge.severity}
                          </StatusPill>
                          <span className="research-muted">
                            {challenge.status} ·{" "}
                            {challenge.registeredEvidenceIds.length} 条已登记依据
                          </span>
                        </div>
                        <div>{challenge.question}</div>
                        {challenge.unverifiedReferences.length > 0 ? (
                          <div className="research-muted">
                            挑战者提到但未登记为证据：{" "}
                            {challenge.unverifiedReferences.join("；")}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              {finding.reviewHistory.length > 0 ? (
                <>
                  <div className="research-label">人工复核记录</div>
                  <ul className="research-plain-list" data-testid="report-reviews">
                    {finding.reviewHistory.map((review) => (
                      <li key={review.id}>
                        <div className="research-claim-meta">
                          <StatusPill tone={reviewOutcomeTone(review.outcome)}>
                            {reviewOutcomeLabel(review.outcome)}
                          </StatusPill>
                          <span className="research-muted">
                            {review.reviewer} · {formatDate(review.createdAt)}
                          </span>
                        </div>
                        <div>{review.rationale}</div>
                        <div className="research-muted">
                          裁定时的推导结论：{verdictLabel(review.verdictStatusAtReview)}
                          （把握度{" "}
                          {Math.round(review.verdictConfidenceAtReview * 100)}%）
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="research-muted">尚未有人工复核记录。</p>
              )}

              <div className="research-muted" data-testid="report-finding-provenance">
                追踪：主张 {finding.claimId} · 证据{" "}
                {finding.supporting.length +
                  finding.opposing.length +
                  finding.context.length +
                  finding.excluded.length}{" "}
                条 · 质询 {finding.challenges.length} 项 · 运行 {finding.runs.length} 次
              </div>
            </article>
          ))
        )}
      </section>

      <section className="research-report-section">
        <h2>交叉审查运行（{report.crossExamination.runs.length}）</h2>
        {report.crossExamination.runs.length === 0 ? (
          <p className="research-muted">该会话还没有交叉审查运行记录。</p>
        ) : (
          <table className="research-table">
            <thead>
              <tr>
                <th scope="col">用途</th>
                <th scope="col">角色</th>
                <th scope="col">状态</th>
                <th scope="col">开始</th>
                <th scope="col">失败原因</th>
              </tr>
            </thead>
            <tbody>
              {report.crossExamination.runs.map((run) => (
                <tr key={run.id}>
                  <td className="research-muted">{runPurposeLabel(run.purpose)}</td>
                  <td className="research-muted">{run.roleId.slice(0, 8)}</td>
                  <td>
                    <StatusPill tone={runStatusTone(run.status)}>
                      {runStatusLabel(run.status)}
                    </StatusPill>
                  </td>
                  <td className="research-muted">{formatDate(run.startedAt)}</td>
                  <td className="research-muted">{run.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {report.crossExamination.failedRuns.length > 0 ? (
          <p className="research-muted">
            其中 {report.crossExamination.failedRuns.length} 次失败已如实记录，未产出结论。
          </p>
        ) : null}
      </section>

      <section className="research-report-section" data-testid="report-gaps">
        <h2>证据不足、冲突与假设</h2>
        <div className="research-label">
          证据不足的主张（{report.gaps.insufficientEvidence.length}）
        </div>
        {report.gaps.insufficientEvidence.length === 0 ? (
          <p className="research-muted">没有仅因证据不足而未下结论的主张。</p>
        ) : (
          <ul className="research-plain-list">
            {report.gaps.insufficientEvidence.map((gap) => (
              <li key={gap.claimId}>{gap.statement}</li>
            ))}
          </ul>
        )}
        <div className="research-label">未解决冲突（{report.gaps.unresolvedConflicts.length}）</div>
        {report.gaps.unresolvedConflicts.length === 0 ? (
          <p className="research-muted">没有未解决的冲突。</p>
        ) : (
          <ul className="research-plain-list">
            {report.gaps.unresolvedConflicts.map((conflict) => (
              <li key={conflict.conflictId}>
                严重度 {conflict.severity}：{conflict.summary}
              </li>
            ))}
          </ul>
        )}
        <div className="research-label">仍以假设支撑的主张（{report.gaps.assumptions.length}）</div>
        {report.gaps.assumptions.length === 0 ? (
          <p className="research-muted">没有以假设支撑的主张。</p>
        ) : (
          <ul className="research-plain-list">
            {report.gaps.assumptions.map((gap) => (
              <li key={gap.claimId}>{gap.statement}</li>
            ))}
          </ul>
        )}
        <div className="research-label">
          来源不完整的引用（{report.gaps.unlinkedCitations.length}）
        </div>
        {report.gaps.unlinkedCitations.length === 0 ? (
          <p className="research-muted">所有引用都关联了已登记来源。</p>
        ) : (
          <ul className="research-plain-list">
            {report.gaps.unlinkedCitations.map((citation) => (
              <li key={citation.evidenceId}>
                {citation.title}（未登记来源，未编造链接）
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="research-report-section">
        <h2>局限性与时间范围</h2>
        {report.limits.length === 0 ? (
          <p className="research-muted">本次报告没有额外限制说明。</p>
        ) : (
          <ul className="research-plain-list">
            {report.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="research-report-section" data-testid="report-provenance">
        <h2>可追溯性</h2>
        <p className="research-muted">
          报告由持久化资料生成：主张 {report.provenance.claimIds.length} 条 · 材料{" "}
          {report.provenance.evidenceIds.length} 条 · 来源{" "}
          {report.provenance.sourceIds.length} 个 · 质询{" "}
          {report.provenance.challengeIds.length} 项 · Agent 运行{" "}
          {report.provenance.agentRunIds.length} 次 · 人工裁定{" "}
          {report.provenance.reviewIds.length} 条 · 最后事件序号{" "}
          {report.provenance.lastEventSequence}
        </p>
        <p className="research-muted">
          同一批材料会得到同一指纹 <code>{report.materialsFingerprint}</code>
          ；材料、质询或裁定发生变化时指纹随之改变，可与历史报告版本比对。
        </p>
      </section>

      <p className="research-muted">
        <Link className="research-report-link" href={`/research/${sessionId}`}>
          ← 返回研究工作台
        </Link>
      </p>
    </div>
  );
}
