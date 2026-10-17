"use client";

import Link from "next/link";
import type {
  ClaimVerdictStatus,
  EvidenceGap,
  ResearchQualityAssessment
} from "@nexus/shared";
import {
  citationStatusLabel,
  citationStatusTone,
  directionLabel,
  exclusionReasonLabel,
  formatDate,
  formatDateTime,
  gapActionLabel,
  gapKindLabel,
  gapSeverityLabel,
  gapSeverityTone,
  qualityDimensionLabel,
  qualityFindingCategoryLabel,
  qualityScoreText,
  qualitySeverityLabel,
  qualitySeverityTone,
  qualityStatusLabel,
  qualityStatusTone,
  reviewOutcomeLabel,
  reviewOutcomeTone,
  runPurposeLabel,
  runStatusLabel,
  runStatusTone,
  sourceKindLabel,
  verificationLabel,
  verificationTone,
  verdictLabel,
  verdictRuleLabel,
  verdictTone
} from "./labels";
import {
  factCheckReportMarkdownUrl,
  type FactCheckReport,
  type MaterialsTimeRange,
  type ReportCitation
} from "./api";
import { StatusPill } from "./components";

function rangeText(range: MaterialsTimeRange): string {
  if (range.empty) {
    return "资料未记录任何日期";
  }
  return [
    `发布 ${formatDate(range.publishedAt.earliest)} ~ ${formatDate(range.publishedAt.latest)}`,
    `获取 ${formatDate(range.retrievedAt.earliest)} ~ ${formatDate(range.retrievedAt.latest)}`,
    `有效期 ${formatDate(range.validity.earliestFrom)} ~ ${formatDate(range.validity.latestTo)}`
  ].join(" · ");
}

/** One gap as the report presents it: what is missing and the next step. */
function ReportGapBlock({
  gap,
  sessionId
}: {
  gap: EvidenceGap;
  sessionId: string;
}) {
  return (
    <li
      className="research-report-gap"
      data-testid="report-gap"
      data-claim-id={gap.claimId}
    >
      <div className="research-claim-meta">
        <StatusPill tone={gapSeverityTone(gap.severity)}>
          {gapSeverityLabel(gap.severity)}
        </StatusPill>
        <StatusPill tone="research-pill-neutral">
          {gapKindLabel(gap.kind)}
        </StatusPill>
      </div>
      <div>{gap.message}</div>
      {gap.detail.length > 0 ? (
        <ul className="research-plain-list research-muted">
          {gap.detail.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {gap.suggestions.length > 0 ? (
        <div className="research-muted">
          建议（待验证，未执行检索）：
          {gap.suggestions.map((item) => item.label).join("；")}
        </div>
      ) : null}
      {/*
        Each action is a real navigation: the workspace opens the form that
        would close this gap, for this exact claim. It is not a decorative
        button that only reports success.
      */}
      <div className="research-actions research-report-gap-actions">
        {gap.actions.map((action) => {
          const query = new URLSearchParams({
            intent: action,
            claimId: gap.claimId
          });
          if (gap.evidenceIds[0]) {
            query.set("evidenceId", gap.evidenceIds[0]);
          }
          return (
            <Link
              key={action}
              className="research-button research-button-secondary"
              href={`/research/${sessionId}?${query.toString()}`}
            >
              {gapActionLabel(action)}
            </Link>
          );
        })}
      </div>
    </li>
  );
}

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

/**
 * The quality block inside the report: the same numbers the workspace's
 * 研究质量 panel shows, drawn from the payload this document was built (or
 * frozen) from. A dimension without a score says 无法计算 and says why —
 * never 0, never 100.
 */
function ResearchQualitySection({
  assessment
}: {
  assessment: ResearchQualityAssessment;
}) {
  const overall = assessment.overall;
  const bySeverity = assessment.findings.reduce(
    (counts, finding) => {
      const key = finding.severity as "critical" | "warning" | "info";
      counts[key] = counts[key] + 1;
      return counts;
    },
    { critical: 0, warning: 0, info: 0 }
  );
  return (
    <section className="research-report-section" data-testid="report-quality">
      <h2>研究质量评估</h2>
      <p className="research-muted">
        评估时间 {formatDateTime(assessment.assessedAt)} · 规则版本{" "}
        {assessment.ruleVersion}（结构 v{assessment.schemaVersion}） · 材料范围指纹{" "}
        <code>{assessment.inputFingerprint}</code>
      </p>
      <div className="research-claim-meta">
        <StatusPill tone={qualityStatusTone(overall.status)}>
          综合状态：{qualityStatusLabel(overall.status)}
        </StatusPill>
        <StatusPill tone="research-pill-neutral">
          综合评分：
          <span data-testid="report-quality-score">{qualityScoreText(overall.score)}</span>
        </StatusPill>
        <StatusPill tone="research-pill-neutral">
          可计算权重 {Math.round(overall.coverage * 100)}%（
          {overall.assessedDimensions}/6 个维度参与）
        </StatusPill>
      </div>
      <p className="research-muted">{overall.explanation}</p>
      <p className="research-muted">
        质量分数不是结论正确的概率：它只描述材料对结论的支持程度，不改变本报告的任何结论。
      </p>

      <div className="research-label">六个维度</div>
      <div className="research-table-scroll">
        <table className="research-table">
          <thead>
            <tr>
              <th scope="col">维度</th>
              <th scope="col">分数</th>
              <th scope="col">权重</th>
              <th scope="col">状态</th>
            </tr>
          </thead>
          <tbody>
            {assessment.dimensions.map((dimension) => (
              <tr key={dimension.id} data-testid={`report-quality-dimension-${dimension.id}`}>
                <td>{qualityDimensionLabel(dimension.id)}</td>
                <td>{qualityScoreText(dimension.score)}</td>
                <td className="research-muted">{dimension.weight}%</td>
                <td>
                  <StatusPill tone={qualityStatusTone(dimension.status)}>
                    {qualityStatusLabel(dimension.status)}
                  </StatusPill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="research-label">
        质量问题（{assessment.findings.length}：严重 {bySeverity.critical} · 警告{" "}
        {bySeverity.warning} · 提示 {bySeverity.info}）
      </div>
      {assessment.findings.length === 0 ? (
        <p className="research-muted">未发现规则命中项。</p>
      ) : (
        <ul className="research-plain-list">
          {assessment.findings.map((finding) => (
            <li key={finding.id}>
              <div className="research-claim-meta">
                <StatusPill tone={qualitySeverityTone(finding.severity)}>
                  {qualitySeverityLabel(finding.severity)}
                </StatusPill>
                <StatusPill tone="research-pill-neutral">
                  {qualityFindingCategoryLabel(finding.category)}
                </StatusPill>
                <span className="research-muted">{finding.ruleId}</span>
              </div>
              <div>{finding.reason}</div>
            </li>
          ))}
        </ul>
      )}

      {assessment.recommendations.length > 0 ? (
        <>
          <div className="research-label">改进建议</div>
          <ul className="research-plain-list">
            {assessment.recommendations.map((recommendation) => (
              <li key={recommendation.id}>
                <strong>{recommendation.title}</strong>：{recommendation.detail}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {assessment.limitations.length > 0 ? (
        <>
          <div className="research-label">评估局限</div>
          <ul className="research-plain-list">
            {assessment.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/**
 * The report itself, rendered from whatever object it is handed.
 *
 * Exported so a stored version can be read with exactly the renderer the live
 * report uses: an old version is the same document, drawn from its frozen
 * payload instead of from today's rows.
 */
export function FactCheckReportBody({
  report,
  sessionId
}: {
  report: FactCheckReport;
  sessionId: string;
}) {
  return (
    <div data-testid="fact-check-report">
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
          <p className="research-muted" data-testid="report-time-range">
            所用资料时间范围：{rangeText(report.materialsTimeRange)}
          </p>
          <p className="research-muted">
            核查范围：{report.scope.claims} 条主张 / {report.scope.evidence} 条材料 /{" "}
            {report.scope.sources} 个来源 / {report.scope.challenges} 项质询 /{" "}
            {report.scope.reviews} 条人工裁定 / {report.scope.agentRuns} 次 Agent 运行
          </p>
          {report.gaps.evidenceGaps.total > 0 ? (
            <p className="research-muted" data-testid="report-gap-summary">
              证据缺口：阻断 {report.gaps.evidenceGaps.bySeverity.blocking} 项 /
              重要 {report.gaps.evidenceGaps.bySeverity.important} 项 / 提示{" "}
              {report.gaps.evidenceGaps.bySeverity.advisory} 项
            </p>
          ) : null}
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
              data-claim-id={finding.claimId}
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

              {/* Why this conclusion: rule, inputs, exclusions, confidence. */}
              <details className="research-disclosure">
                <summary>结论依据（可核对）</summary>
                <div className="research-label" style={{ marginTop: 6 }}>
                  命中规则
                </div>
                <ul className="research-plain-list">
                  {finding.verdict.ruleHits.map((rule) => (
                    <li key={rule} title={rule}>
                      {verdictRuleLabel(rule)}
                    </li>
                  ))}
                </ul>
                <div className="research-label">参与判断的证据</div>
                <ul className="research-plain-list">
                  <li>
                    支持 {finding.verdict.basis.supportingEvidenceIds.length} 条
                    {finding.verdict.basis.supportingEvidenceIds.length > 0
                      ? `（${finding.verdict.basis.supportingEvidenceIds.join("、")}）`
                      : ""}
                  </li>
                  <li>
                    反对 {finding.verdict.basis.opposingEvidenceIds.length} 条
                    {finding.verdict.basis.opposingEvidenceIds.length > 0
                      ? `（${finding.verdict.basis.opposingEvidenceIds.join("、")}）`
                      : ""}
                  </li>
                  <li>
                    背景 {finding.verdict.basis.contextEvidenceIds.length} 条
                    {finding.verdict.basis.contextEvidenceIds.length > 0
                      ? `（${finding.verdict.basis.contextEvidenceIds.join("、")}）`
                      : ""}
                  </li>
                </ul>
                {finding.verdict.excluded.length > 0 ? (
                  <>
                    <div className="research-label">被排除的证据及原因</div>
                    <ul className="research-plain-list">
                      {finding.verdict.excluded.map((entry) => (
                        <li key={entry.evidenceId}>
                          {entry.evidenceId}：{exclusionReasonLabel(entry.reason)}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {finding.verdict.confidenceBasis.length > 0 ? (
                  <>
                    <div className="research-label">把握度依据</div>
                    <ul className="research-plain-list">
                      {finding.verdict.confidenceBasis.map((basis) => (
                        <li key={basis}>{basis}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </details>

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

              {finding.gaps.length > 0 ? (
                <>
                  <div className="research-label">
                    证据缺口与建议补充材料（{finding.gaps.length}，其中阻断{" "}
                    {finding.blockingGapCount}）
                  </div>
                  <ul
                    className="research-report-gaps"
                    data-testid="report-finding-gaps"
                  >
                    {finding.gaps.map((gap) => (
                      <ReportGapBlock
                        key={gap.id}
                        gap={gap}
                        sessionId={report.sessionId}
                      />
                    ))}
                  </ul>
                </>
              ) : null}

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
          <div className="research-table-scroll">
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
          </div>
        )}
        {report.crossExamination.failedRuns.length > 0 ? (
          <p className="research-muted">
            其中 {report.crossExamination.failedRuns.length} 次失败已如实记录，未产出结论。
          </p>
        ) : null}
      </section>

      <section className="research-report-section" data-testid="report-gaps">
        <h2>证据不足、冲突与假设</h2>
        {report.gaps.evidenceGaps.total > 0 ? (
          <>
            <div className="research-label">缺口类型统计</div>
            <ul className="research-plain-list">
              {Object.entries(report.gaps.evidenceGaps.byKind)
                .filter(([, count]) => count > 0)
                .map(([kind, count]) => (
                  <li key={kind}>
                    {gapKindLabel(kind as Parameters<typeof gapKindLabel>[0])}：
                    {count}
                  </li>
                ))}
            </ul>
          </>
        ) : null}
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

      {/* ---------- research quality ---------- */}
      {/*
        Rendered from the assessment the report carries. For a live report
        that is the reading at generation time; for a stored version it is
        exactly what that version froze — an old version never recomputes,
        and a version saved before the quality block existed simply has none.
        Nothing here feeds a verdict: the verdict pipeline cannot see it.
      */}
      {report.researchQuality ? (
        <ResearchQualitySection assessment={report.researchQuality} />
      ) : null}

      <section className="research-report-section">
        <h2>局限性与时间范围</h2>
        <p className="research-muted">
          本报告所依据资料的时间范围：{rangeText(report.materialsTimeRange)}
          。资料未覆盖当前时间时，结论只在其覆盖范围内成立。
        </p>
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
