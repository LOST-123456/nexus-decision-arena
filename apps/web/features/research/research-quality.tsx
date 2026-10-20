"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  QualityFinding,
  QualitySeverity,
  ResearchQualityAssessment
} from "@nexus/shared";
import {
  getResearchQuality,
  ResearchQualityFailedError
} from "./api";
import { StatusPill } from "./components";
import {
  formatDateTime,
  qualityActionLabel,
  qualityDimensionLabel,
  qualityFindingCategoryLabel,
  qualityRuleVersionLabel,
  qualityScopeLabel,
  qualityScoreText,
  qualitySeverityLabel,
  qualitySeverityTone,
  qualityStatusLabel,
  qualityStatusTone,
  verdictLabel
} from "./labels";

/**
 * 研究质量 — a read-only diagnostic over the material, never a score of
 * whether the conclusions are true.
 *
 * The contract this panel holds to:
 *  - a dimension that could not be computed reads 无法计算 with its reason,
 *    never 0 and never 100;
 *  - the overall score is only shown when the rules could actually compute
 *    it; otherwise the six dimensions carry the reading alone;
 *  - status is always spelled out in words next to the colour, so the panel
 *    never relies on colour alone;
 *  - every button navigates to a surface that already exists in the
 *    workspace; nothing here writes, and nothing here opens a form that
 *    cannot act on the finding it came from.
 *
 * One assessment per load: the overview, the six dimensions, the claim
 * diagnostics and the findings all render from the single assessment the
 * panel fetches, so every view carries the same `assessedAt` and the same
 * `inputFingerprint` by construction — and a severity pick filters the
 * findings that were already loaded instead of re-running the projection.
 */

/** Where a finding's "go and look" button leads. */
export type ResearchQualityNavigation = {
  onOpenClaim?: (claimId: string) => void;
  onOpenEvidence?: (evidenceId: string) => void;
  onOpenSource?: (sourceId: string) => void;
  onOpenReader?: (sourceId: string) => void;
  onOpenPlan?: () => void;
};

type SeverityFilter = QualitySeverity | "all";

/**
 * The findings cap the server applies on the findings endpoint, kept
 * identical here so the locally narrowed view shows exactly the rows the
 * endpoint would have returned for the same filter.
 */
const FINDINGS_VIEW_LIMIT = 500;

const SEVERITY_FILTERS: Array<{ id: SeverityFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "critical", label: qualitySeverityLabel("critical") },
  { id: "warning", label: qualitySeverityLabel("warning") },
  { id: "info", label: qualitySeverityLabel("info") }
];

function failureText(cause: unknown, fallback: string): string {
  if (cause instanceof ResearchQualityFailedError) {
    if (cause.status === 404) {
      return "找不到该研究会话：它可能已被删除，或不属于当前登录用户。";
    }
    if (cause.status === 501) {
      return "服务端尚未启用研究质量评估。请联系管理员检查装配配置。";
    }
    return cause.message || fallback;
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}

/**
 * What one finding's action button does, or null when there is nowhere real
 * to send the reader — in which case no button is rendered at all. A control
 * that cannot act is worse than no control.
 */
function actionFor(
  finding: QualityFinding,
  navigation: ResearchQualityNavigation
): { label: string; run: () => void } | null {
  const claimId = finding.claimId;
  const firstEvidence = finding.evidenceReferences[0];
  switch (finding.recommendation) {
    case "open_claim_detail":
      return claimId && navigation.onOpenClaim
        ? {
            label: qualityActionLabel("open_claim_detail"),
            run: () => navigation.onOpenClaim?.(claimId)
          }
        : null;
    case "open_evidence_detail":
      if (firstEvidence && navigation.onOpenEvidence) {
        return {
          label: qualityActionLabel("open_evidence_detail"),
          run: () => navigation.onOpenEvidence?.(firstEvidence)
        };
      }
      return claimId && navigation.onOpenClaim
        ? {
            label: qualityActionLabel("open_claim_detail"),
            run: () => navigation.onOpenClaim?.(claimId)
          }
        : null;
    case "open_source_reader":
      // "Go and re-read the source" only makes sense for a source-scoped
      // finding, where the entity id IS a source id. An evidence-scoped
      // finding names an excerpt, and a claim-scoped one names a claim —
      // sending either to the reader would open it against an id that is not
      // a source. Each goes to the surface that can actually act on it, and
      // with nothing wired there is no button at all.
      if (finding.scope === "evidence") {
        if (navigation.onOpenEvidence) {
          return {
            label: qualityActionLabel("open_evidence_detail"),
            run: () => navigation.onOpenEvidence?.(finding.entityId)
          };
        }
        return claimId && navigation.onOpenClaim
          ? {
              label: qualityActionLabel("open_claim_detail"),
              run: () => navigation.onOpenClaim?.(claimId)
            }
          : null;
      }
      if (finding.scope === "claim") {
        return claimId && navigation.onOpenClaim
          ? {
              label: qualityActionLabel("open_claim_detail"),
              run: () => navigation.onOpenClaim?.(claimId)
            }
          : null;
      }
      return navigation.onOpenReader
        ? {
            label: qualityActionLabel("open_source_reader"),
            run: () => navigation.onOpenReader?.(finding.entityId)
          }
        : null;
    case "open_source_relations":
      return navigation.onOpenSource
        ? {
            label: qualityActionLabel("open_source_relations"),
            run: () => navigation.onOpenSource?.(finding.entityId)
          }
        : null;
    case "open_research_plan":
      return navigation.onOpenPlan
        ? {
            label: qualityActionLabel("open_research_plan"),
            run: () => navigation.onOpenPlan?.()
          }
        : null;
    case "open_human_review":
      return claimId && navigation.onOpenClaim
        ? {
            label: qualityActionLabel("open_human_review"),
            run: () => navigation.onOpenClaim?.(claimId)
          }
        : null;
    default:
      // The remaining actions (record_source, verify_evidence, add_*,
      // run_cross_review) are all performed on a claim inside the
      // workspace's own surfaces, so the button goes to the claim; with no
      // claim on record, the named material is the best target available.
      if (claimId && navigation.onOpenClaim) {
        return {
          label: qualityActionLabel(finding.recommendation),
          run: () => navigation.onOpenClaim?.(claimId)
        };
      }
      if (firstEvidence && navigation.onOpenEvidence) {
        return {
          label: qualityActionLabel(finding.recommendation),
          run: () => navigation.onOpenEvidence?.(firstEvidence)
        };
      }
      return null;
  }
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="research-label">{label}</div>
      <div style={{ margin: 0 }}>{value}</div>
    </div>
  );
}

/** The six dimensions, each stating how its number was — or was not — produced. */
function DimensionList({
  assessment
}: {
  assessment: ResearchQualityAssessment;
}) {
  return (
    <ul className="research-plain-list" data-testid="quality-dimensions">
      {assessment.dimensions.map((dimension) => (
        <li
          key={dimension.id}
          data-testid={`quality-dimension-${dimension.id}`}
        >
          <div className="research-actions">
            <strong>{qualityDimensionLabel(dimension.id)}</strong>
            <span data-testid={`quality-dimension-score-${dimension.id}`}>
              {qualityScoreText(dimension.score)}
            </span>
            <span className="research-muted">权重 {dimension.weight}%</span>
            <StatusPill tone={qualityStatusTone(dimension.status)}>
              {qualityStatusLabel(dimension.status)}
            </StatusPill>
          </div>
          <p className="research-muted">{dimension.explanation}</p>
          {Object.keys(dimension.inputMetrics).length > 0 ? (
            <p className="research-muted">
              输入指标：
              {Object.entries(dimension.inputMetrics)
                .map(
                  ([key, value]) => `${key}=${value === null ? "未知" : String(value)}`
                )
                .join("，")}
            </p>
          ) : null}
          {/* A dimension's limitations are prose notes about that one
              dimension, not items of the dimension list: rendering them as
              nested list items would make "the six dimensions" uncountable
              for anyone reading the list. */}
          {dimension.limitations.map((limitation) => (
            <p key={limitation} className="research-muted">
              局限：{limitation}
            </p>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function ResearchQualityPanel({
  sessionId,
  navigation
}: {
  sessionId: string;
  navigation: ResearchQualityNavigation;
}) {
  // One assessment drives every view: overview, dimensions, claims and
  // findings. The narrow endpoints still exist on the server, but the panel
  // has no reason to ask for the same projection three times — the full
  // assessment already carries the claim diagnostics and the findings.
  const [assessment, setAssessment] =
    useState<ResearchQualityAssessment | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [reloadCount, setReloadCount] = useState(0);

  const reload = useCallback(() => {
    setReloadCount((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailure(null);
    void (async () => {
      try {
        const nextAssessment = await getResearchQuality(sessionId);
        if (cancelled) return;
        setAssessment(nextAssessment);
      } catch (cause) {
        if (!cancelled) {
          setFailure(failureText(cause, "读取研究质量评估失败"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadCount]);
  // `severity` is deliberately not a dependency: it narrows the findings
  // that are already loaded, and must not re-run the assessment.

  if (failure) {
    return (
      <section className="research-panel" data-testid="research-quality">
        <header className="research-panel-header">
          <div>
            <h2 className="research-panel-title">研究质量</h2>
            <p className="research-muted">
              对材料支持程度的只读诊断。质量分数不是结论正确的概率。
            </p>
          </div>
        </header>
        <p className="research-error" role="alert" data-testid="quality-error">
          {failure}
        </p>
        <div className="research-actions">
          <button
            type="button"
            className="research-button research-button-secondary"
            data-testid="quality-retry"
            onClick={reload}
          >
            重试
          </button>
        </div>
      </section>
    );
  }

  if (loading || !assessment) {
    return (
      <section className="research-panel" data-testid="research-quality">
        <header className="research-panel-header">
          <div>
            <h2 className="research-panel-title">研究质量</h2>
            <p className="research-muted">
              对材料支持程度的只读诊断。质量分数不是结论正确的概率。
            </p>
          </div>
        </header>
        <p className="research-muted" data-testid="quality-loading">
          正在计算研究质量评估…
        </p>
      </section>
    );
  }

  const claimFindings = assessment.claimFindings;
  const overall = assessment.overall;
  // The same finding list the server would return from the findings
  // endpoint, narrowed here: the severity pick must not re-run the
  // projection, and the total is the narrowed count before the same
  // 500-row cap the endpoint applies.
  const narrowedFindings =
    severity === "all"
      ? assessment.findings
      : assessment.findings.filter((finding) => finding.severity === severity);
  const findingsTotal = narrowedFindings.length;
  const visibleFindings = narrowedFindings.slice(0, FINDINGS_VIEW_LIMIT);

  return (
    <section className="research-panel" data-testid="research-quality">
      <header className="research-panel-header">
        <div>
          <h2 className="research-panel-title">研究质量</h2>
          <p className="research-muted">
            对材料支持程度的只读诊断：证据覆盖、核实程度、来源独立性、冲突处理、
            研究完整度与来源时效。质量分数不是结论正确的概率，也不改变任何结论。
          </p>
        </div>
        <div className="research-actions">
          <button
            type="button"
            className="research-button research-button-secondary"
            data-testid="quality-refresh"
            onClick={reload}
          >
            重新评估
          </button>
        </div>
      </header>

      {/* ---------- overview ---------- */}
      <div className="research-facts" data-testid="quality-overview">
        <div>
          <div className="research-label">综合评分</div>
          <p style={{ margin: 0 }} data-testid="quality-overall-score">
            {qualityScoreText(overall.score)}
          </p>
        </div>
        <div>
          <div className="research-label">综合状态</div>
          <p style={{ margin: 0 }}>
            <StatusPill tone={qualityStatusTone(overall.status)}>
              {qualityStatusLabel(overall.status)}
            </StatusPill>
          </p>
        </div>
        <div>
          <div className="research-label">可计算权重覆盖</div>
          <p style={{ margin: 0 }} data-testid="quality-coverage">
            {Math.round(overall.coverage * 100)}%（{overall.assessedDimensions}
            /6 个维度参与）
          </p>
        </div>
        <MetricRow label="评估时间" value={formatDateTime(assessment.assessedAt)} />
        <MetricRow
          label="规则版本"
          value={qualityRuleVersionLabel(assessment.ruleVersion)}
        />
        <MetricRow label="材料范围指纹" value={assessment.inputFingerprint} />
      </div>

      <p className="research-muted" data-testid="quality-overall-explanation">
        {overall.explanation}
      </p>
      <p className="research-muted">
        综合分按各维度权重加权平均；覆盖不足 100% 说明有维度被排除而非记 0 分。
      </p>

      {assessment.limitations.length > 0 ? (
        <>
          <h3 className="research-label">评估局限</h3>
          <ul className="research-plain-list" data-testid="quality-limitations">
            {assessment.limitations.map((limitation) => (
              <li key={limitation} className="research-muted">
                {limitation}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* ---------- six dimensions ---------- */}
      <h3 className="research-label">六个维度</h3>
      <DimensionList assessment={assessment} />

      {/* ---------- claim diagnostics ---------- */}
      <h3 className="research-label">主张级诊断</h3>
      <p className="research-muted" data-testid="quality-claims-headline">
        {claimFindings.length === 0
          ? "当前没有任何主张：没有可评估的材料，也不给分。"
          : `共诊断 ${claimFindings.length} 条主张，其中 ${
              claimFindings.filter((claim) => claim.blockingGapCount > 0).length
            } 条仍带阻断性缺口。`}
      </p>
      {claimFindings.length === 0 ? (
        <p className="research-muted" data-testid="quality-claims-empty">
          先录入主张与证据，这里才会出现逐条诊断。
        </p>
      ) : (
        <ul className="research-plain-list" data-testid="quality-claims">
          {claimFindings.map((claim) => (
            <li key={claim.claimId} data-testid={`quality-claim-${claim.claimId}`}>
              <div className="research-actions">
                <StatusPill tone="research-pill-neutral">
                  {verdictLabel(claim.verdictStatus)}
                </StatusPill>
                <strong>{claim.statement}</strong>
              </div>
              <div className="research-facts">
                <MetricRow
                  label="材料（已核实 / 未核实）"
                  value={`${claim.evidenceVerified} / ${claim.evidenceUnverified}`}
                />
                <MetricRow
                  label="支持 / 反对"
                  value={`${claim.evidenceSupporting} / ${claim.evidenceOpposing}`}
                />
                <MetricRow
                  label="独立信息源"
                  value={
                    claim.independentSourceCount === null
                      ? "无法判断"
                      : `${claim.independentSourceCount} 条`
                  }
                />
                <MetricRow
                  label="未解决冲突 / 未回应质询"
                  value={`${claim.unresolvedConflictCount} / ${claim.unansweredChallengeCount}`}
                />
                <MetricRow
                  label="缺口（阻断）"
                  value={`${claim.openGapCount}（${claim.blockingGapCount}）`}
                />
                <MetricRow
                  label="来源变化风险"
                  value={
                    claim.sourceUpdateRiskCount === 0
                      ? "无"
                      : `${claim.sourceUpdateRiskCount} 条材料所引原文已变化`
                  }
                />
              </div>
              {claim.relatedRunIds.length > 0 ? (
                <p className="research-muted">
                  相关交叉审查运行 {claim.relatedRunIds.length} 次；运行时长与
                  Token 用量不参与本评估。
                </p>
              ) : null}
              {/* Same rule as the dimensions: a claim's recommendations are
                  notes about that claim, not items of the claim list. */}
              {claim.recommendations.map((line) => (
                <p key={line} className="research-muted">
                  {line}
                </p>
              ))}
              {navigation.onOpenClaim ? (
                <button
                  type="button"
                  className="research-button research-button-secondary"
                  data-testid={`quality-open-claim-${claim.claimId}`}
                  onClick={() => navigation.onOpenClaim?.(claim.claimId)}
                >
                  {qualityActionLabel("open_claim_detail")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {/* ---------- findings ---------- */}
      <div className="research-actions" data-testid="quality-filters">
        <span className="research-label">按严重度筛选</span>
        {SEVERITY_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            className={`research-button${filter.id === severity ? "" : " research-button-secondary"}`}
            aria-pressed={filter.id === severity}
            data-testid={`quality-filter-${filter.id}`}
            onClick={() => setSeverity(filter.id)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <h3 className="research-label">
        质量问题（筛选后 {visibleFindings.length} 条，共 {findingsTotal} 条）
      </h3>
      {visibleFindings.length === 0 ? (
        <p className="research-muted" data-testid="quality-findings-empty">
          当前筛选条件下没有规则命中项。没有发现问题不等于研究没有问题。
        </p>
      ) : (
        <ul className="research-plain-list" data-testid="quality-findings">
          {visibleFindings.map((finding) => {
            const action = actionFor(finding, navigation);
            return (
              <li key={finding.id} data-testid={`quality-finding-${finding.id}`}>
                <div className="research-actions">
                  <StatusPill tone={qualitySeverityTone(finding.severity)}>
                    {qualitySeverityLabel(finding.severity)}
                  </StatusPill>
                  <StatusPill tone="research-pill-neutral">
                    {qualityFindingCategoryLabel(finding.category)}
                  </StatusPill>
                  <span className="research-muted">
                    {qualityScopeLabel(finding.scope)} · {finding.entityId}
                  </span>
                </div>
                <p style={{ margin: "6px 0" }}>{finding.reason}</p>
                <p className="research-muted">命中规则：{finding.ruleId}</p>
                {finding.evidenceReferences.length > 0 ? (
                  <p className="research-muted">
                    涉及材料：{finding.evidenceReferences.join("、")}
                  </p>
                ) : null}
                {action ? (
                  <button
                    type="button"
                    className="research-button research-button-secondary"
                    data-testid={`quality-action-${finding.id}`}
                    onClick={action.run}
                  >
                    {action.label}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {/* ---------- recommendations ---------- */}
      {assessment.recommendations.length > 0 ? (
        <>
          <h3 className="research-label">改进建议</h3>
          <ul className="research-plain-list" data-testid="quality-recommendations">
            {assessment.recommendations.map((recommendation) => (
              <li key={recommendation.id}>
                <div className="research-actions">
                  <strong>{recommendation.title}</strong>
                  <StatusPill tone="research-pill-neutral">
                    {qualityActionLabel(recommendation.action)}
                  </StatusPill>
                </div>
                <p className="research-muted">{recommendation.detail}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <p className="research-muted" style={{ marginTop: 12 }}>
        本面板只读：它不修改主张状态、核查结论、核实记录、人工裁定或已保存的报告
        版本。评估所用规则版本为 {assessment.ruleVersion}；创建研究任务请使用
        「研究计划」面板的既有入口。
      </p>
    </section>
  );
}
