import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchQualityAssessmentSchema } from "@nexus/shared";

/**
 * The rules of the research-quality surface, checked against the real
 * component.
 *
 * Only the data access is faked. What these tests pin down is the honesty
 * contract: a dimension that could not be computed reads 无法计算 and never 0
 * or 100, the overall score is refused rather than guessed, status is spelled
 * out in words, one assessment drives every view (so a severity pick filters
 * locally and never re-runs the projection), every action button leads
 * somewhere real (and a finding with nowhere to go renders no button at all),
 * and a failure is stated with a working retry.
 */

const getResearchQuality = vi.fn();
const getResearchQualityClaims = vi.fn();
const getResearchQualityFindings = vi.fn();

class ResearchQualityFailedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ResearchQualityFailedError";
  }
}

vi.mock("./api", () => ({
  ResearchQualityFailedError,
  getResearchQuality: (...args: unknown[]) => getResearchQuality(...args),
  getResearchQualityClaims: (...args: unknown[]) =>
    getResearchQualityClaims(...args),
  getResearchQualityFindings: (...args: unknown[]) =>
    getResearchQualityFindings(...args)
}));

const { ResearchQualityPanel } = await import("./research-quality");

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const CLAIM_ID = "0199e6d0-0000-7000-8000-000000000002";
const SOURCE_ID = "0199e6d0-0000-7000-8000-000000000003";
const EVIDENCE_ID = "0199e6d0-0000-7000-8000-000000000004";
const RULE_VERSION = "research-quality-v1";
const ASSESSED_AT = "2026-10-12T09:30:00.000Z";

function dimension(overrides: {
  id: string;
  score: number | null;
  weight: number;
  status: string;
  explanation: string;
  inputMetrics?: Record<string, number | string | boolean | null>;
  limitations?: string[];
}) {
  return {
    id: overrides.id,
    score: overrides.score,
    weight: overrides.weight,
    status: overrides.status,
    explanation: overrides.explanation,
    inputMetrics: overrides.inputMetrics ?? {},
    limitations: overrides.limitations ?? [],
    ruleVersion: RULE_VERSION
  };
}

function assessmentFixture(overrides: Record<string, unknown> = {}) {
  return ResearchQualityAssessmentSchema.parse({
    sessionId: SESSION_ID,
    assessedAt: ASSESSED_AT,
    schemaVersion: 1,
    ruleVersion: RULE_VERSION,
    inputFingerprint: "0123456789abcdef",
    overall: {
      score: null,
      status: "insufficient_data",
      explanation: "不给出综合分数：可计算维度权重仅 45%，不足 50%。",
      assessedDimensions: 2,
      coverage: 0.45,
      ruleVersion: RULE_VERSION
    },
    dimensions: [
      dimension({
        id: "evidence_coverage",
        score: 40,
        weight: 25,
        status: "weak",
        explanation: "覆盖率 = 100 × (0.40 × 1.00) = 40。",
        inputMetrics: { claims: 2, claimsWithEvidence: 2 }
      }),
      dimension({
        id: "verification_quality",
        score: null,
        weight: 20,
        status: "insufficient_data",
        explanation: "本研究会话没有任何材料，核实程度无从计算。没有材料不等于材料没问题。",
        inputMetrics: { evidenceTotal: 0 },
        limitations: ["没有任何材料可核实。"]
      }),
      dimension({
        id: "source_independence",
        score: null,
        weight: 20,
        status: "insufficient_data",
        explanation: "本研究会话没有登记任何来源，来源独立性无从计算。",
        inputMetrics: { pages: 0 }
      }),
      dimension({
        id: "conflict_resolution",
        score: 100,
        weight: 15,
        status: "strong",
        explanation: "冲突处理 = 100。",
        inputMetrics: { conflicts: 1, conflictsResolved: 1 }
      }),
      dimension({
        id: "research_completeness",
        score: null,
        weight: 10,
        status: "insufficient_data",
        explanation: "当前规则没有诊断出任何缺口，也没有研究计划条目。",
        inputMetrics: { gaps: 0, planItems: 0 }
      }),
      dimension({
        id: "source_freshness",
        score: null,
        weight: 10,
        status: "insufficient_data",
        explanation: "未配置来源监测，无法评估来源变化风险。",
        inputMetrics: { monitoringConfigured: false }
      })
    ],
    claimFindings: [
      {
        claimId: CLAIM_ID,
        statement: "出货量同比增长 12%。",
        claimStatus: "proposed",
        importance: 5,
        verdictStatus: "unsupported",
        evidenceTotal: 0,
        evidenceVerified: 0,
        evidenceUnverified: 0,
        evidenceSupporting: 0,
        evidenceOpposing: 0,
        independentSourceCount: null,
        unresolvedConflictCount: 0,
        unansweredChallengeCount: 0,
        openGapCount: 0,
        blockingGapCount: 0,
        sourceUpdateRiskCount: 0,
        relatedRunIds: [],
        findingIds: [],
        recommendations: []
      }
    ],
    evidenceFindings: [],
    sourceFindings: [],
    findings: [
      {
        id: `missing_evidence:${CLAIM_ID}`,
        scope: "claim",
        entityId: CLAIM_ID,
        category: "missing_evidence",
        severity: "critical",
        reason: "该主张（重要度 5/5）没有任何关联材料，无法判断。",
        ruleId: "claim.no_evidence",
        evidenceReferences: [],
        claimId: CLAIM_ID,
        recommendation: "add_supporting_evidence"
      },
      {
        id: `insufficient_independence:${SOURCE_ID}`,
        scope: "source",
        entityId: SOURCE_ID,
        category: "insufficient_independence",
        severity: "info",
        reason: "该来源与 1 个其他来源文本相近，疑似同源但未经人工确认。",
        ruleId: "source.suspected_same_origin",
        evidenceReferences: [],
        claimId: null,
        recommendation: "open_source_relations"
      },
      {
        id: `stale_source:${EVIDENCE_ID}`,
        scope: "evidence",
        entityId: EVIDENCE_ID,
        category: "stale_source",
        severity: "warning",
        reason: "该材料所在的来源已发生变化，需要重新核查。",
        ruleId: "monitoring.evidence_reconfirmation",
        evidenceReferences: [EVIDENCE_ID],
        claimId: null,
        recommendation: "open_source_reader"
      }
    ],
    recommendations: [
      {
        id: `recommendation:claim:${CLAIM_ID}:missing_evidence`,
        title: "补充证据材料：出货量同比增长 12%。",
        detail: "该主张（重要度 5/5）没有任何关联材料，无法判断。",
        action: "add_supporting_evidence",
        claimId: CLAIM_ID,
        evidenceIds: [],
        sourceIds: [],
        findingIds: [`missing_evidence:${CLAIM_ID}`]
      }
    ],
    limitations: [
      "本评估为只读投影：不修改主张状态、核查结论、人工裁定或已保存的报告快照。",
      "质量分数描述研究流程与证据组织，不是结论正确的概率，也不能反推任何主张的真假。"
    ],
    ...overrides
  });
}

const noNavigation = {};

beforeEach(() => {
  getResearchQuality.mockReset();
  getResearchQualityClaims.mockReset();
  getResearchQualityFindings.mockReset();
  // One assessment is all the panel asks for; the narrow endpoints must not
  // be called at all, and these defaults make an accidental call fail loudly
  // rather than resolve into a second reading of the same rows.
  getResearchQuality.mockResolvedValue(assessmentFixture());
  getResearchQualityClaims.mockRejectedValue(
    new Error("the claims endpoint must not be requested")
  );
  getResearchQualityFindings.mockRejectedValue(
    new Error("the findings endpoint must not be requested")
  );
});

afterEach(() => {
  cleanup();
});

describe("ResearchQualityPanel · the overview", () => {
  it("shows the score it could compute and refuses the one it could not", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );

    await waitFor(() =>
      expect(screen.getByTestId("quality-overview")).toBeTruthy()
    );
    // The overall score is refused: 无法计算, never 0 and never a number.
    expect(screen.getByTestId("quality-overall-score").textContent).toBe(
      "无法计算"
    );
    expect(screen.getByTestId("quality-coverage").textContent).toContain("45%");
    expect(screen.getByTestId("quality-coverage").textContent).toContain("2/6");
    expect(screen.getByTestId("quality-overall-explanation").textContent).toContain(
      "不足 50%"
    );
    expect(screen.getByTestId("quality-overview").textContent).toContain(
      ASSESSED_AT.slice(0, 10)
    );
    // The overview names the rules in words a person can read.
    expect(screen.getByTestId("quality-overview").textContent).toContain(
      "研究质量-v1"
    );
    expect(screen.getByTestId("quality-overview").textContent).toContain(
      "0123456789abcdef"
    );
    // The standing disclaimer, in words, not just a colour.
    expect(screen.getByTestId("research-quality").textContent).toContain(
      "不是结论正确的概率"
    );
  });

  it("states the read-only promise and the rule version", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-dimensions")).toBeTruthy()
    );
    const panel = screen.getByTestId("research-quality");
    expect(panel.textContent).toContain("只读");
    // The exact machine id never disappears: the overview reads 研究质量-v1,
    // the footer still names research-quality-v1 so a reader can tell
    // precisely which rules produced the number.
    expect(panel.textContent).toContain(RULE_VERSION);
  });

  it("shows an unknown rule version exactly as it arrived", async () => {
    getResearchQuality.mockResolvedValue(
      assessmentFixture({ ruleVersion: "research-quality-v9-experimental" })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-overview")).toBeTruthy()
    );
    // No label is invented for rules this build does not know about.
    expect(screen.getByTestId("quality-overview").textContent).toContain(
      "research-quality-v9-experimental"
    );
    expect(screen.getByTestId("quality-overview").textContent).not.toContain(
      "研究质量-v1"
    );
  });
});

describe("ResearchQualityPanel · the six dimensions", () => {
  it("renders every dimension with its weight, status and basis", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-dimensions")).toBeTruthy()
    );
    for (const id of [
      "evidence_coverage",
      "verification_quality",
      "source_independence",
      "conflict_resolution",
      "research_completeness",
      "source_freshness"
    ]) {
      expect(screen.getByTestId(`quality-dimension-${id}`)).toBeTruthy();
    }
    // A computable dimension shows its number and how it was produced.
    const coverage = screen.getByTestId("quality-dimension-evidence_coverage");
    expect(coverage.textContent).toContain("40");
    expect(coverage.textContent).toContain("权重 25%");
    expect(coverage.textContent).toContain("覆盖率 = 100");
    // A dimension that could not be computed says so, with its reason.
    const verification = screen.getByTestId(
      "quality-dimension-verification_quality"
    );
    expect(verification.textContent).toContain("无法计算");
    expect(verification.textContent).toContain("没有材料不等于材料没问题");
    expect(
      screen.getByTestId("quality-dimension-score-verification_quality")
        .textContent
    ).toBe("无法计算");
  });

  it("keeps the dimension list countable when every dimension carries limitations", async () => {
    // Caught by the browser run: limitations rendered as nested list items
    // made the list hold twelve entries where the contract says six. A
    // limitation is a prose note about its own dimension, so it is printed as
    // a paragraph and the list keeps exactly one item per dimension.
    const dimensions = assessmentFixture().dimensions.map((item) => ({
      ...item,
      limitations: [`局限一：${item.id}`, `局限二：${item.id}`]
    }));
    getResearchQuality.mockResolvedValue(assessmentFixture({ dimensions }));
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-dimensions")).toBeTruthy()
    );
    expect(
      screen.getByTestId("quality-dimensions").querySelectorAll("li")
    ).toHaveLength(6);
    // The limitations themselves are still on screen, under their dimension.
    expect(
      screen.getByTestId("quality-dimension-source_independence").textContent
    ).toContain("局限一：source_independence");
  });
});

describe("ResearchQualityPanel · claim diagnostics", () => {
  it("diagnoses each claim and never invents an independence count", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId(`quality-claim-${CLAIM_ID}`)).toBeTruthy()
    );
    const claim = screen.getByTestId(`quality-claim-${CLAIM_ID}`);
    expect(claim.textContent).toContain("出货量同比增长 12%");
    // Unknown is displayed as unknown, not as 0 and not as 1.
    expect(claim.textContent).toContain("无法判断");
  });

  it("says so when there is no claim to diagnose", async () => {
    // The empty state comes from the one assessment the panel already
    // loaded; asking the narrow claims endpoint again would be a second
    // reading of the same rows, so it must stay untouched.
    getResearchQuality.mockResolvedValue(assessmentFixture({ claimFindings: [] }));
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-claims-empty")).toBeTruthy()
    );
    expect(screen.getByTestId("quality-claims-headline").textContent).toContain(
      "没有任何主张"
    );
    expect(getResearchQuality).toHaveBeenCalledTimes(1);
    expect(getResearchQualityClaims).not.toHaveBeenCalled();
    expect(getResearchQualityFindings).not.toHaveBeenCalled();
  });

  it("keeps one list item per claim even when the claim carries recommendations", async () => {
    // The same defect as the dimensions, on the claim list: a claim's
    // recommendations are notes about that claim, so they render as
    // paragraphs and the list stays countable — one item per claim.
    const claimFindings = [
      {
        ...assessmentFixture().claimFindings[0],
        recommendations: [
          "补充该主张的证据材料",
          "把研究缺口纳入计划"
        ]
      }
    ];
    getResearchQuality.mockResolvedValue(assessmentFixture({ claimFindings }));
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-claims")).toBeTruthy()
    );
    const items = screen.getByTestId("quality-claims").querySelectorAll("li");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toContain("补充该主张的证据材料");
    expect(items[0]?.textContent).toContain("把研究缺口纳入计划");
    // The claim list came from the same single assessment as everything else.
    expect(getResearchQuality).toHaveBeenCalledTimes(1);
    expect(getResearchQualityClaims).not.toHaveBeenCalled();
  });
});

describe("ResearchQualityPanel · findings", () => {
  it("filters locally when a severity is picked, and keeps the total", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-findings")).toBeTruthy()
    );
    // The one assessment the panel loaded already carried the findings; a
    // severity pick narrows them here and must not re-run the projection.
    expect(getResearchQuality).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("quality-filter-critical"));
    await waitFor(() =>
      expect(
        screen.getByText(/质量问题（筛选后 1 条，共 1 条）/)
      ).toBeTruthy()
    );
    // Still exactly one request: no findings endpoint call, no re-assessment.
    expect(getResearchQuality).toHaveBeenCalledTimes(1);
    expect(getResearchQualityClaims).not.toHaveBeenCalled();
    expect(getResearchQualityFindings).not.toHaveBeenCalled();
    expect(screen.getByTestId("quality-filter-critical").getAttribute("aria-pressed")).toBe(
      "true"
    );
    // The critical row is the only one left on screen.
    expect(
      screen.queryByTestId(`quality-finding-stale_source:${EVIDENCE_ID}`)
    ).toBeNull();
    expect(
      screen.getByTestId(`quality-finding-missing_evidence:${CLAIM_ID}`)
    ).toBeTruthy();
  });

  it("loads one assessment for every view, not one per endpoint", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-dimensions")).toBeTruthy()
    );
    // Overview, dimensions, claims and findings all rendered — from a single
    // request. The narrow endpoints were not asked at all.
    expect(screen.getByTestId("quality-overall-score")).toBeTruthy();
    expect(screen.getByTestId("quality-claims")).toBeTruthy();
    expect(screen.getByTestId("quality-findings")).toBeTruthy();
    expect(getResearchQuality).toHaveBeenCalledTimes(1);
    expect(getResearchQuality).toHaveBeenCalledWith(SESSION_ID);
    expect(getResearchQualityClaims).not.toHaveBeenCalled();
    expect(getResearchQualityFindings).not.toHaveBeenCalled();
  });

  it("keeps one assessedAt and fingerprint across every view", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-findings")).toBeTruthy()
    );
    // The overview is the only place the timestamp and fingerprint are
    // printed; both come from the same assessment object the claims and
    // findings render from, so the views cannot disagree by construction.
    const overview = screen.getByTestId("quality-overview");
    expect(overview.textContent).toContain("2026-10-12");
    expect(overview.textContent).toContain("0123456789abcdef");
    // One severity switch later, the same reading is still on screen —
    // no second assessment was fetched to redraw the list.
    fireEvent.click(screen.getByTestId("quality-filter-warning"));
    await waitFor(() =>
      expect(
        screen.getByText(/质量问题（筛选后 1 条，共 1 条）/)
      ).toBeTruthy()
    );
    expect(screen.getByTestId("quality-overview").textContent).toContain(
      "2026-10-12"
    );
    expect(getResearchQuality).toHaveBeenCalledTimes(1);
  });

  it("renders an action only when it leads somewhere real", async () => {
    const onOpenClaim = vi.fn();
    const onOpenSource = vi.fn();
    render(
      <ResearchQualityPanel
        sessionId={SESSION_ID}
        navigation={{ onOpenClaim, onOpenSource }}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-findings")).toBeTruthy()
    );

    // A source finding with a source-relations target: the button exists.
    const sourceAction = screen.getByTestId(
      `quality-action-insufficient_independence:${SOURCE_ID}`
    );
    fireEvent.click(sourceAction);
    expect(onOpenSource).toHaveBeenCalledWith(SOURCE_ID);

    // A reader action with no reader wired: no button at all, rather than a
    // control that cannot act.
    expect(
      screen.queryByTestId(`quality-action-stale_source:${EVIDENCE_ID}`)
    ).toBeNull();

    // A claim finding routes to the claim.
    fireEvent.click(
      screen.getByTestId(`quality-action-missing_evidence:${CLAIM_ID}`)
    );
    expect(onOpenClaim).toHaveBeenCalledWith(CLAIM_ID);
  });

  it("routes a re-read action to the surface that owns the id it has", async () => {
    const onOpenEvidence = vi.fn();
    const onOpenReader = vi.fn();
    render(
      <ResearchQualityPanel
        sessionId={SESSION_ID}
        navigation={{ onOpenEvidence, onOpenReader }}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-findings")).toBeTruthy()
    );

    // The stale-source finding is about an excerpt: its button opens that
    // excerpt's detail, never the reader with an evidence id it cannot use.
    fireEvent.click(
      screen.getByTestId(`quality-action-stale_source:${EVIDENCE_ID}`)
    );
    expect(onOpenEvidence).toHaveBeenCalledWith(EVIDENCE_ID);
    expect(onOpenReader).not.toHaveBeenCalled();
  });

  it("says an empty result is not a clean bill of health", async () => {
    getResearchQuality.mockResolvedValue(assessmentFixture({ findings: [] }));
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-findings-empty")).toBeTruthy()
    );
    expect(screen.getByTestId("quality-findings-empty").textContent).toContain(
      "没有发现问题不等于研究没有问题"
    );
    // The empty list came from the one assessment, not from a second call.
    expect(getResearchQuality).toHaveBeenCalledTimes(1);
    expect(getResearchQualityFindings).not.toHaveBeenCalled();
  });
});

describe("ResearchQualityPanel · failure and loading", () => {
  it("states the failure in an alert and offers a retry that works", async () => {
    getResearchQuality.mockRejectedValueOnce(
      new ResearchQualityFailedError("服务端尚未启用研究质量评估。", 501)
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-error")).toBeTruthy()
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("服务端尚未启用研究质量评估");

    // The retry re-reads; the second attempt succeeds.
    getResearchQuality.mockResolvedValue(assessmentFixture());
    fireEvent.click(screen.getByTestId("quality-retry"));
    await waitFor(() =>
      expect(screen.getByTestId("quality-overview")).toBeTruthy()
    );
    expect(getResearchQuality).toHaveBeenCalledTimes(2);
  });

  it("says a missing session is a missing session, not an error to retry", async () => {
    getResearchQuality.mockRejectedValue(
      new ResearchQualityFailedError("Session not found", 404)
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-error")).toBeTruthy()
    );
    expect(screen.getByTestId("quality-error").textContent).toContain(
      "找不到该研究会话"
    );
  });

  it("shows a loading state before the first read lands", async () => {
    let release: (value: unknown) => void = () => undefined;
    getResearchQuality.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    expect(screen.getByTestId("quality-loading")).toBeTruthy();
    release(assessmentFixture());
    await waitFor(() =>
      expect(screen.queryByTestId("quality-loading")).toBeNull()
    );
  });
});
