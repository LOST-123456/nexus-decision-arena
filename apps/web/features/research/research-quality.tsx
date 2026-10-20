"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type {
  QualityFinding,
  QualityRecommendation,
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
  verdictLabel,
  verdictTone
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

/**
 * How close to the top of the viewport a section counts as "the one the
 * reader is in". Nothing on this surface overlays the viewport top — the
 * app bar is `position: relative` and scrolls away, the only sticky rule
 * is a table header inside its own scroll wrapper, and the fixed elements
 * are the off-canvas skip link and the modal scrims (see the offset note
 * in research.css) — so this is a reading heuristic, not a measurement:
 * a section becomes current as it arrives at the top, not after it has
 * scrolled past.
 */
const SECTION_SPY_OFFSET = 96;

/** How many characters a shortened id starts with before it grows for uniqueness. */
const SHORT_ID_MIN_LENGTH = 8;

/**
 * A shortened form of a stable id, for display only.
 *
 * The real id never moves: React keys, navigation targets and the `title`
 * attribute all carry it verbatim. The alias is the shortest prefix (at
 * least `SHORT_ID_MIN_LENGTH` characters) that no other id on screen shares,
 * so it is traceable back to the full id without ever being ambiguous — and
 * when even the full id would collide (it cannot for a uuid, but the loop
 * does not assume), the full id is returned rather than a lying alias.
 *
 * Exported for tests, the way `publishNavHeight` is: the conflict-growth and
 * full-collision fallback paths are pure functions, and a component test
 * could only reach them by contriving an assessment that happens to collide.
 */
export function shortId(id: string, siblings: readonly string[]): string {
  for (let length = SHORT_ID_MIN_LENGTH; length < id.length; length += 1) {
    const prefix = id.slice(0, length);
    const clashes = siblings.some(
      (other) => other !== id && other.startsWith(prefix)
    );
    if (!clashes) return prefix;
  }
  return id;
}

/**
 * Display aliases for every id the findings list shows, computed once.
 *
 * Uniqueness is judged against the ids that are actually on screen: the
 * entity ids and the evidence references of the findings being displayed.
 * A different filter shows a different set, so the aliases are recomputed
 * when the set changes — never per render, and never randomly.
 */
export function buildIdAliases(
  findings: readonly QualityFinding[]
): Map<string, string> {
  const ids = new Set<string>();
  for (const finding of findings) {
    ids.add(finding.entityId);
    for (const evidenceId of finding.evidenceReferences) ids.add(evidenceId);
  }
  const all = [...ids];
  return new Map(all.map((id) => [id, shortId(id, all)]));
}

/**
 * The panel's own sections, for the in-page navigation.
 *
 * An entry exists only when its section exists on screen: the nav points at
 * real blocks and never at a heading that this assessment did not produce
 * (no claims → no claims entry, and so on). Order is the reading order.
 */
type SectionNavItem = { id: string; label: string; anchor: string };

const SECTION_NAV: ReadonlyArray<SectionNavItem> = [
  { id: "verdict", label: "结论", anchor: "quality-section-verdict" },
  { id: "dimensions", label: "六个维度", anchor: "quality-section-dimensions" },
  { id: "claims", label: "主张诊断", anchor: "quality-section-claims" },
  { id: "findings", label: "问题", anchor: "quality-section-findings" },
  {
    id: "recommendations",
    label: "改进建议",
    anchor: "quality-section-recommendations"
  }
];

/**
 * The sections one assessment actually produced, in reading order. The
 * findings entry doubles as the severity-statistics target: the filter
 * counts and the per-severity summary sit at the head of that section, so
 * one entry covers both instead of adding a second that lands two lines
 * further down.
 */
function sectionsFor(
  assessment: ResearchQualityAssessment
): ReadonlyArray<SectionNavItem> {
  return SECTION_NAV.filter((item) => {
    if (item.id === "claims") return assessment.claimFindings.length > 0;
    if (item.id === "findings") return assessment.findings.length > 0;
    if (item.id === "recommendations")
      return assessment.recommendations.length > 0;
    return true;
  });
}

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
      <dt className="research-label">{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}

/**
 * What a recommendation's action button does, or null when there is nowhere
 * real to send the reader — the same honesty rule as a finding's action: a
 * control that cannot act is worse than no control. The recommendation
 * already carries its target ids (claimId / evidenceIds / sourceIds) and the
 * workspace wiring decides which surface can actually receive them, so the
 * button reuses the existing navigation and nothing else.
 */
function recommendationActionFor(
  recommendation: QualityRecommendation,
  navigation: ResearchQualityNavigation
): { label: string; run: () => void } | null {
  const claimId = recommendation.claimId;
  const firstEvidence = recommendation.evidenceIds[0];
  const firstSource = recommendation.sourceIds[0];
  const label = qualityActionLabel(recommendation.action);
  switch (recommendation.action) {
    case "open_claim_detail":
      return claimId && navigation.onOpenClaim
        ? { label, run: () => navigation.onOpenClaim?.(claimId) }
        : null;
    case "open_evidence_detail":
      if (firstEvidence && navigation.onOpenEvidence) {
        return {
          label,
          run: () => navigation.onOpenEvidence?.(firstEvidence)
        };
      }
      return claimId && navigation.onOpenClaim
        ? { label, run: () => navigation.onOpenClaim?.(claimId) }
        : null;
    case "open_source_reader":
      return firstSource && navigation.onOpenReader
        ? { label, run: () => navigation.onOpenReader?.(firstSource) }
        : null;
    case "open_source_relations":
      return firstSource && navigation.onOpenSource
        ? { label, run: () => navigation.onOpenSource?.(firstSource) }
        : null;
    case "open_research_plan":
      return navigation.onOpenPlan
        ? { label, run: () => navigation.onOpenPlan?.() }
        : null;
    case "open_human_review":
      return claimId && navigation.onOpenClaim
        ? { label, run: () => navigation.onOpenClaim?.(claimId) }
        : null;
    default:
      // The remaining actions are performed on a claim (or the material it
      // names) inside the workspace's own surfaces; with nothing wired
      // there is no button at all.
      if (claimId && navigation.onOpenClaim) {
        return { label, run: () => navigation.onOpenClaim?.(claimId) };
      }
      if (firstEvidence && navigation.onOpenEvidence) {
        return { label, run: () => navigation.onOpenEvidence?.(firstEvidence) };
      }
      return null;
  }
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

  // In-page navigation: the sections this assessment produced, and a stable
  // key of them. The key drives the scroll-spy below — the sections only
  // exist once the assessment has loaded, so the spy re-reads exactly then
  // and never otherwise.
  const visibleSections = assessment ? sectionsFor(assessment) : [];
  const sectionsKey = visibleSections.map((item) => item.anchor).join("|");

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

  // In-page navigation: which section the reader is in. The links
  // themselves are native anchors — the browser does the scrolling (it
  // honours the section offset declared in research.css), the keyboard
  // reaches every link for free, and no route or workspace state is
  // touched — so all this state does is mark the current section. The
  // listener is capture-phase so it also sees scroll events from an inner
  // scroller should the layout ever grow one, and every lookup is guarded
  // because a section that this assessment did not produce simply is not
  // there — a missing block is skipped, never an error.
  const [activeSection, setActiveSection] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let frame = 0;
    const readActiveSection = (): void => {
      let current: string | null = null;
      for (const item of visibleSections) {
        const element = document.getElementById(item.anchor);
        if (!element) continue;
        if (element.getBoundingClientRect().top <= SECTION_SPY_OFFSET) {
          current = item.id;
        }
      }
      setActiveSection(current);
    };
    const onScroll = (): void => {
      if (frame) return;
      if (typeof window.requestAnimationFrame !== "function") {
        readActiveSection();
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        readActiveSection();
      });
    };
    window.addEventListener("scroll", onScroll, { capture: true });
    // Read once whenever the set of sections changes: they only exist once
    // the assessment has loaded, so this is what marks the reader's place
    // on a freshly landed page instead of waiting for the first scroll.
    readActiveSection();
    return () => {
      window.removeEventListener("scroll", onScroll, { capture: true });
      if (frame && typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [sectionsKey]);

  // The same finding list the server would return from the findings
  // endpoint, narrowed here: the severity pick must not re-run the
  // projection, and the total is the narrowed count before the same
  // 500-row cap the endpoint applies. Hoisted above the early returns so
  // the hook order is identical while loading — a missing assessment
  // simply narrows nothing.
  const narrowedFindings = assessment
    ? severity === "all"
      ? assessment.findings
      : assessment.findings.filter(
          (finding) => finding.severity === severity
        )
    : [];
  const findingsTotal = narrowedFindings.length;
  const visibleFindings = narrowedFindings.slice(0, FINDINGS_VIEW_LIMIT);
  // Display aliases for the ids the findings list shows, computed per
  // assessment-and-filter combination rather than per render: which
  // prefixes must stay unambiguous is decided by the rows that are on
  // screen, so a filter switch (which changes those rows) recomputes and a
  // plain re-render does not. The alias never replaces the real id — keys,
  // action targets and the `title` attribute all carry it verbatim.
  const idAliases = useMemo(
    () => buildIdAliases(visibleFindings),
    [assessment, severity]
  );

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

  // Counts read off the assessment that was already loaded — the full
  // assessment carries every finding (the 500 cap belongs to the findings
  // endpoint, not to this payload), so these are complete counts, not a
  // sample of the first page.
  const criticalFindings = assessment.findings.filter(
    (finding) => finding.severity === "critical"
  );
  const warningFindings = assessment.findings.filter(
    (finding) => finding.severity === "warning"
  );
  const infoFindings = assessment.findings.filter(
    (finding) => finding.severity === "info"
  );
  const severityCount = (id: SeverityFilter): number =>
    id === "all"
      ? assessment.findings.length
      : id === "critical"
        ? criticalFindings.length
        : id === "warning"
          ? warningFindings.length
          : infoFindings.length;

  // The conclusion's risk notes are assembled only from facts the
  // assessment already states: the reasons of the findings that actually
  // fired, and how many dimensions the rules could not compute. Nothing is
  // inferred, and no risk is invented where none exists.
  const uncomputedDimensions = assessment.dimensions.filter(
    (dimension) => dimension.score === null
  ).length;
  const worstFinding = criticalFindings[0];
  const verdictRisks: string[] = [];
  if (worstFinding) {
    verdictRisks.push(
      `${criticalFindings.length} 条严重问题待处理：${worstFinding.reason}`
    );
  }
  if (warningFindings.length > 0) {
    verdictRisks.push(`${warningFindings.length} 条警告待处理。`);
  }
  if (uncomputedDimensions > 0) {
    verdictRisks.push(
      `${uncomputedDimensions}/6 个维度无法计算，原因见各维度说明。`
    );
  }
  if (verdictRisks.length === 0) {
    verdictRisks.push("当前各维度均可计算，且没有规则命中的质量问题。");
  }

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

      {/* ---------- conclusion (P0-1) ----------
          The answer first: the overall score, the status, the one-sentence
          conclusion the rules produced, and the risks that need action — all
          read off the assessment that was already loaded. The metadata
          (when, which rules, which fingerprint) is demoted to a meta row
          underneath, still inside this section so a reader can always reach
          it. Nothing here invents a verdict: every string is either an
          existing field or a count of existing rows. */}
      <div data-testid="quality-overview">
        <div
          className="quality-verdict"
          id="quality-section-verdict"
          data-testid="quality-verdict"
        >
          <div className="quality-verdict-score">
            <div className="research-label">综合评分</div>
            <p
              className="quality-verdict-number"
              data-testid="quality-overall-score"
            >
              {qualityScoreText(overall.score)}
            </p>
          </div>
          <div className="quality-verdict-body">
            <div className="research-actions">
              <span className="research-label">当前状态</span>
              <StatusPill tone={qualityStatusTone(overall.status)}>
                {qualityStatusLabel(overall.status)}
              </StatusPill>
              <span className="research-muted" data-testid="quality-coverage">
                可计算权重覆盖 {Math.round(overall.coverage * 100)}%
                （{overall.assessedDimensions}/6 个维度参与）
              </span>
            </div>
            <p
              className="quality-verdict-explanation"
              data-testid="quality-overall-explanation"
            >
              {overall.explanation}
            </p>
            <div className="quality-verdict-risks">
              <span className="research-label">关键风险</span>
              <ul data-testid="quality-verdict-risks">
                {verdictRisks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>

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

        {/* Secondary metadata: demoted from the facts grid, never dropped. */}
        <div className="quality-meta" data-testid="quality-meta">
          <span>评估时间 {formatDateTime(assessment.assessedAt)}</span>
          <span>规则版本 {qualityRuleVersionLabel(assessment.ruleVersion)}</span>
          <span>材料范围指纹 {assessment.inputFingerprint}</span>
        </div>
      </div>

      {/* ---------- in-page navigation ----------
          Native anchors, one per section this assessment produced: the
          browser scrolls to the target (honouring the offset declared in
          research.css), the keyboard reaches every link for free, and the
          scroll-spy marks the section the reader is in. It sits UNDER the
          conclusion on purpose — the answer stays first, and the navigation
          stays quiet (muted, small, no fill) so it never competes with the
          verdict or the claim cards. */}
      <nav className="quality-section-nav" aria-label="研究质量区块导航">
        {visibleSections.map((item) => (
          <a
            key={item.id}
            className={`quality-section-nav-link${
              activeSection === item.id ? " is-active" : ""
            }`}
            href={`#${item.anchor}`}
            aria-current={activeSection === item.id ? "true" : undefined}
            data-testid={`quality-section-nav-${item.id}`}
          >
            {item.label}
          </a>
        ))}
      </nav>

      {/* ---------- six dimensions ---------- */}
      <h3 className="research-label" id="quality-section-dimensions">
        六个维度
      </h3>
      <DimensionList assessment={assessment} />

      {/* ---------- claim diagnostics ---------- */}
      <h3 className="research-label" id="quality-section-claims">
        主张级诊断
      </h3>
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
                <StatusPill tone={verdictTone(claim.verdictStatus)}>
                  {verdictLabel(claim.verdictStatus)}
                </StatusPill>
                <strong>{claim.statement}</strong>
              </div>
              <dl className="research-deflist">
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
              </dl>
              {claim.relatedRunIds.length > 0 ? (
                <p className="research-muted">
                  相关交叉审查运行 {claim.relatedRunIds.length} 次；运行时长与
                  Token 用量不参与本评估。
                </p>
              ) : null}
              {/* The claim's own advice lines used to be printed here, which
                  said a third time what the findings and the recommendations
                  section already say. The claim card stays a diagnostic; the
                  actionable direction lives once, in the recommendations
                  section below, and this line is the pointer to it. */}
              {claim.recommendations.length > 0 ? (
                <p className="research-muted">
                  该主张的改进建议见面板下方「改进建议」区。
                </p>
              ) : null}
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
      {/* The nav target is the head of this section: the severity filters
          with their counts and the per-severity summary live here, so
          jumping to "问题" lands on the statistics, with the list right
          underneath. */}
      <div
        className="research-actions"
        id="quality-section-findings"
        data-testid="quality-filters"
      >
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
            {filter.label} {severityCount(filter.id)}
          </button>
        ))}
      </div>
      {/* The count summary (P0-2): how many findings the loaded assessment
          carries in total and per severity, all read off the assessment in
          state — no second request, no re-assessment. The current filter's
          result count is NOT repeated here: the list heading below owns it
          ("筛选后 X 条，共 Y 条", which already separates displayed rows
          from matched ones), so one number lives in exactly one place. */}
      <p className="research-muted" data-testid="quality-severity-summary">
        全部问题 {assessment.findings.length} 条：严重 {criticalFindings.length}{" "}
        · 警告 {warningFindings.length} · 提示 {infoFindings.length}。
      </p>
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
                  {/* The entity id shown short — a raw uuid used to occupy
                      this line in full — with the real id one hover away in
                      the title. What the finding is about stays legible:
                      the scope label, the reason and the rule are the
                      content; the id is the handle, not the headline. */}
                  <span className="research-muted">
                    {qualityScopeLabel(finding.scope)} ·{" "}
                    <span title={finding.entityId}>
                      {idAliases.get(finding.entityId) ?? finding.entityId}
                    </span>
                  </span>
                </div>
                <p style={{ margin: "6px 0" }}>{finding.reason}</p>
                <p className="research-muted">命中规则：{finding.ruleId}</p>
                {finding.evidenceReferences.length > 0 ? (
                  <p className="research-muted">
                    涉及材料：
                    {finding.evidenceReferences.map((evidenceId, index) => (
                      <Fragment key={evidenceId}>
                        {index > 0 ? "、" : null}
                        <span title={evidenceId}>
                          {idAliases.get(evidenceId) ?? evidenceId}
                        </span>
                      </Fragment>
                    ))}
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
          <h3 className="research-label" id="quality-section-recommendations">
            改进建议
          </h3>
          {/* This section is the one actionable layer: a direction, how many
              rule hits it covers, and a button that goes to the surface
              which can act. The finding reasons it used to reprint verbatim
              stay where they belong — in the findings list above. */}
          <ul className="research-plain-list" data-testid="quality-recommendations">
            {assessment.recommendations.map((recommendation) => {
              const action = recommendationActionFor(recommendation, navigation);
              return (
                <li
                  key={recommendation.id}
                  data-testid={`quality-recommendation-${recommendation.id}`}
                >
                  <div className="research-actions">
                    <strong>{recommendation.title}</strong>
                    <span className="research-muted">
                      覆盖 {recommendation.findingIds.length} 条规则命中项
                    </span>
                  </div>
                  {action ? (
                    <button
                      type="button"
                      className="research-button research-button-secondary"
                      data-testid={`quality-recommendation-action-${recommendation.id}`}
                      onClick={action.run}
                    >
                      {action.label}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <p className="research-muted" style={{ marginTop: 12 }} data-testid="quality-footer">
        本面板只读，不修改研究会话的任何数据。评估所用规则版本为{" "}
        {assessment.ruleVersion}；创建研究任务请使用「研究计划」面板的既有入口。
      </p>
    </section>
  );
}
