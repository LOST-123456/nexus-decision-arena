import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchQualityAssessmentSchema } from "@nexus/shared";
import type { QualityFinding } from "@nexus/shared";
import { verdictLabel, verdictTone } from "./labels";

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

const {
  ResearchQualityPanel,
  shortId,
  buildIdAliases
} = await import("./research-quality");

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

  it("lays each claim's metrics out as label/value pairs in one definition list", async () => {
    // The claim card's six metrics used to sit in .research-facts — a
    // dt/dd grid — as bundled divs, so each label+value pair collapsed
    // into ONE grid cell: odd rows were squeezed into the 96px label
    // track and even rows stretched across the full width. The card now
    // uses the deflist pattern (the one agent-ops already uses), where
    // the wrapper dissolves and every label takes a max-content track at
    // 390px as much as at 1440px.
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId(`quality-claim-${CLAIM_ID}`)).toBeTruthy()
    );
    const metrics = screen
      .getByTestId(`quality-claim-${CLAIM_ID}`)
      .querySelector("dl.research-deflist");
    expect(metrics).toBeTruthy();
    // One dt/dd pair per metric — not one grid cell per bundled div.
    expect(metrics?.querySelectorAll("dt").length).toBe(6);
    expect(metrics?.querySelectorAll("dd").length).toBe(6);
    // Label first, then its value, and the values are the real ones.
    const pairs = Array.from(metrics?.querySelectorAll("dt") ?? []).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent
    ]);
    expect(pairs).toEqual([
      ["材料（已核实 / 未核实）", "0 / 0"],
      ["支持 / 反对", "0 / 0"],
      ["独立信息源", "无法判断"],
      ["未解决冲突 / 未回应质询", "0 / 0"],
      ["缺口（阻断）", "0（0）"],
      ["来源变化风险", "无"]
    ]);
  });

  it("colours a claim verdict with the shared verdictTone mapping, in words too", async () => {
    // The claim card used to hardcode a neutral pill, so the same verdict
    // read green in the review panel and grey here. Both surfaces now go
    // through labels.ts verdictTone — the single mapping — so the colour
    // cannot drift again. Every status is walked, including the default
    // branch, so no verdict can fall through to an undefined class.
    const statuses = [
      "supported",
      "refuted",
      "mixed_evidence",
      "inconclusive",
      "insufficient_evidence",
      "context_only",
      "unsupported"
    ] as const;
    for (const status of statuses) {
      const claimFindings = [
        {
          ...assessmentFixture().claimFindings[0],
          verdictStatus: status
        }
      ];
      getResearchQuality.mockResolvedValue(assessmentFixture({ claimFindings }));
      const view = render(
        <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
      );
      await waitFor(() =>
        expect(screen.getByTestId(`quality-claim-${CLAIM_ID}`)).toBeTruthy()
      );
      const pill = screen
        .getByTestId(`quality-claim-${CLAIM_ID}`)
        .querySelector(".research-pill");
      // The pill carries exactly the shared mapping's class, nothing else.
      expect(pill?.className).toContain(`research-pill ${verdictTone(status)}`);
      // The colour never travels alone: the verdict stays spelled out.
      expect(pill?.textContent).toBe(verdictLabel(status));
      view.unmount();
    }
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
    // recommendations are notes about that claim, so the list stays
    // countable — one item per claim. Task03B-2 moved the actionable
    // direction out of the claim card: the advice text used to be printed
    // here a third time (claim card, findings, recommendations), and now
    // the card carries a pointer while the advice lives once below.
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
    // The card points at the one actionable layer instead of reprinting it.
    expect(items[0]?.textContent).toContain("改进建议");
    expect(items[0]?.textContent).not.toContain("补充该主张的证据材料");
    // The advice itself is still on screen — once, in the recommendations
    // section, with a button that goes somewhere real.
    expect(
      screen.getByTestId("quality-recommendations").textContent
    ).toContain("补充证据材料");
    // The claim list came from the same single assessment as everything else.
    expect(getResearchQuality).toHaveBeenCalledTimes(1);
    expect(getResearchQualityClaims).not.toHaveBeenCalled();
  });
});

describe("ResearchQualityPanel · in-page navigation (Task03B-3)", () => {
  it("lists one entry per section that is really on screen", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-section-nav-verdict")).toBeTruthy()
    );
    // The fixture carries claims, findings and recommendations, so all
    // five sections are listed.
    const links = screen
      .getByRole("navigation", { name: "研究质量区块导航" })
      .querySelectorAll("a");
    expect(links).toHaveLength(5);
    for (const link of links) {
      // A native anchor: the browser's own keyboard path applies, the name
      // is the visible label, and the href resolves to a block that exists.
      const href = link.getAttribute("href") ?? "";
      expect(href.startsWith("#")).toBe(true);
      expect(document.getElementById(href.slice(1))).toBeTruthy();
      expect((link.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("drops the entries whose sections this assessment did not produce", async () => {
    getResearchQuality.mockResolvedValue(
      assessmentFixture({
        claimFindings: [],
        findings: [],
        recommendations: []
      })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-section-nav-verdict")).toBeTruthy()
    );
    // The conclusion and the dimensions are always on screen; the other
    // three sections are not, so their entries do not exist either.
    expect(screen.getByTestId("quality-section-nav-dimensions")).toBeTruthy();
    expect(screen.queryByTestId("quality-section-nav-claims")).toBeNull();
    expect(screen.queryByTestId("quality-section-nav-findings")).toBeNull();
    expect(
      screen.queryByTestId("quality-section-nav-recommendations")
    ).toBeNull();
  });

  it("sends the reader to the section a link names", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-section-nav-claims")).toBeTruthy()
    );
    const link = screen.getByTestId(
      "quality-section-nav-claims"
    ) as HTMLAnchorElement;
    // A native fragment link the browser acts on itself: the href names a
    // section that exists on screen, and nothing intercepts the click (no
    // handler, no target) — so the default behaviour (jump to the id,
    // honouring the CSS offset) is what runs. jsdom cannot scroll, so the
    // visual landing itself is a CSS mechanism, recorded in the report.
    expect(link.getAttribute("href")).toBe("#quality-section-claims");
    expect(link.getAttribute("target")).toBeNull();
    const target = document.getElementById("quality-section-claims");
    expect(target).toBeTruthy();
    // The claims entry lands on the section heading itself.
    expect(target?.tagName).toBe("H3");
    // The findings entry lands on the severity statistics — the filter row
    // with the per-severity counts — with the list right underneath.
    const findingsTarget = document.getElementById("quality-section-findings");
    expect(findingsTarget?.getAttribute("data-testid")).toBe("quality-filters");
  });

  it("marks the section the reader is in, and skips the missing ones", async () => {
    // No claims, findings or recommendations: the scroll-spy walks the two
    // sections that exist and never touches an id that is not on screen.
    getResearchQuality.mockResolvedValue(
      assessmentFixture({
        claimFindings: [],
        findings: [],
        recommendations: []
      })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-section-nav-verdict")).toBeTruthy()
    );
    // jsdom reports every rect as 0, so the last section on screen counts
    // as the current one — deterministic, and it proves the walk finishes
    // without throwing on the sections that are absent.
    window.dispatchEvent(new Event("scroll"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId("quality-section-nav-dimensions")
          .getAttribute("aria-current")
      ).toBe("true")
    );
    expect(
      screen
        .getByTestId("quality-section-nav-verdict")
        .getAttribute("aria-current")
    ).toBeNull();
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

describe("ResearchQualityPanel · finding id aliases (Task03B-3)", () => {
  /** A finding to override, built explicitly from the fixture's own row. */
  function findingWith(overrides: {
    id: string;
    entityId: string;
    evidenceReferences?: string[];
  }): QualityFinding {
    const base = assessmentFixture().findings[2];
    if (!base) throw new Error("the fixture must carry a third finding");
    return {
      id: overrides.id,
      scope: base.scope,
      entityId: overrides.entityId,
      category: base.category,
      severity: base.severity,
      reason: base.reason,
      ruleId: base.ruleId,
      evidenceReferences: overrides.evidenceReferences ?? [],
      claimId: base.claimId,
      recommendation: base.recommendation
    };
  }

  /** An id that shares nothing with the fixture's ids past the version nibble. */
  const OTHER_ID = "0199e6d1-0000-7000-8000-000000000001";

  it("shortens an id that nothing else on screen shares to eight characters", () => {
    // The project's established display convention (id.slice(0, 8)) kept as
    // the floor, so an unambiguous id reads the same here as everywhere else.
    expect(shortId(EVIDENCE_ID, [OTHER_ID])).toBe("0199e6d0");
  });

  it("grows the prefix when another id on screen shares it", () => {
    // Two ids that agree on the first eight characters: each alias has to
    // grow until it no longer stands for both — and each still starts with
    // the real id, so the title keeps the trace exact.
    const shared = "0199e6d0-0000-7000-8000-0000000000";
    const first = `${shared}ab`;
    const second = `${shared}ba`;
    const siblings = [first, second];
    const aliases = siblings.map((id) => shortId(id, siblings));
    expect(aliases[0]).not.toBe(aliases[1]);
    expect(first.startsWith(aliases[0]!)).toBe(true);
    expect(second.startsWith(aliases[1]!)).toBe(true);
    // They diverge at the ninth character, so nine is all it takes.
    expect(aliases[0]).toBe(`${shared}a`);
    expect(aliases[1]).toBe(`${shared}b`);
  });

  it("falls back to the full id when every shorter prefix would collide", () => {
    // One id is a prefix of the other: no shorter form separates them, so
    // the honest answer is the full id — never an ambiguous alias, and
    // never a silently truncated one.
    const shorter = "0199e6d0-0000-7000-8000-0000000000ab";
    const longer = `${shorter}c`;
    const siblings = [shorter, longer];
    expect(shortId(shorter, siblings)).toBe(shorter);
    expect(shortId(longer, siblings)).toBe(longer);
  });

  it("treats an empty id as an empty alias instead of inventing one", () => {
    expect(shortId("", [EVIDENCE_ID])).toBe("");
  });

  it("collects entity ids and evidence references into one alias map", () => {
    const aliases = buildIdAliases([
      findingWith({
        id: "stale_source:x",
        entityId: EVIDENCE_ID,
        evidenceReferences: [OTHER_ID]
      })
    ]);
    expect(aliases.get(EVIDENCE_ID)).toBe(EVIDENCE_ID.slice(0, 8));
    expect(aliases.get(OTHER_ID)).toBe(OTHER_ID.slice(0, 8));
    // A finding with nothing referenced contributes only its entity id.
    const solo = buildIdAliases([
      findingWith({ id: "stale_source:y", entityId: EVIDENCE_ID })
    ]);
    expect(solo.get(EVIDENCE_ID)).toBe(EVIDENCE_ID.slice(0, 8));
  });

  it("shows a finding's ids as short aliases that carry the full id", async () => {
    // Ids that diverge early: each gets the eight-character floor, and the
    // full uuid lives in the title — never as the visible text.
    const entityId = "0199e6d1-0000-7000-8000-000000000004";
    const evidenceId = "0199e6d2-0000-7000-8000-000000000001";
    getResearchQuality.mockResolvedValue(
      assessmentFixture({
        findings: assessmentFixture().findings.map((finding) =>
          finding.id === `stale_source:${EVIDENCE_ID}`
            ? { ...finding, entityId, evidenceReferences: [evidenceId] }
            : finding
        )
      })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(`quality-finding-stale_source:${EVIDENCE_ID}`)
      ).toBeTruthy()
    );
    const row = screen.getByTestId(`quality-finding-stale_source:${EVIDENCE_ID}`);
    const shownEntity = row.querySelector(`[title="${entityId}"]`);
    expect(shownEntity?.textContent).toBe(entityId.slice(0, 8));
    // The raw uuid no longer occupies the line — but nothing is lost: the
    // scope label, the reason and the rule stay the content of the row.
    expect(row.textContent).not.toContain(entityId);
    expect(row.textContent).toContain(
      "命中规则：monitoring.evidence_reconfirmation"
    );
  });

  it("lists the evidence a finding references as traceable aliases", async () => {
    const entityId = "0199e6d1-0000-7000-8000-000000000004";
    const evidenceId = "0199e6d2-0000-7000-8000-000000000001";
    getResearchQuality.mockResolvedValue(
      assessmentFixture({
        findings: assessmentFixture().findings.map((finding) =>
          finding.id === `stale_source:${EVIDENCE_ID}`
            ? { ...finding, entityId, evidenceReferences: [evidenceId] }
            : finding
        )
      })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(`quality-finding-stale_source:${EVIDENCE_ID}`)
      ).toBeTruthy()
    );
    const row = screen.getByTestId(`quality-finding-stale_source:${EVIDENCE_ID}`);
    expect(row.textContent).toContain("涉及材料");
    const reference = row.querySelector(`[title="${evidenceId}"]`);
    expect(reference?.textContent).toBe(evidenceId.slice(0, 8));
    expect(row.textContent).not.toContain(evidenceId);
  });

  it("keeps the full id when the ids on screen differ only in their last characters", async () => {
    // The fixture's own ids (…002 / …003 / …004) share every character but
    // the last, so the shortest unambiguous alias IS the full id. Shortening
    // past the point of ambiguity would be a lying alias; the row shows the
    // real id instead, and still keeps the scope label and the reason.
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(`quality-finding-stale_source:${EVIDENCE_ID}`)
      ).toBeTruthy()
    );
    const row = screen.getByTestId(`quality-finding-stale_source:${EVIDENCE_ID}`);
    const shown = row.querySelector(`[title="${EVIDENCE_ID}"]`);
    expect(shown?.textContent).toBe(EVIDENCE_ID);
    expect(shown?.getAttribute("title")).toBe(EVIDENCE_ID);
    expect(row.textContent).toContain("命中规则");
  });

  it("renders a finding that references no evidence without fabricating one", async () => {
    // The schema guarantees a real UUIDv7 entity id, so an "empty id" row
    // cannot arrive from the API; what can happen is a finding with nothing
    // referenced — and then nothing is listed, no placeholder invented.
    const entityId = "0199e6d1-0000-7000-8000-000000000004";
    const findings = [findingWith({ id: "stale_source:solo", entityId })];
    getResearchQuality.mockResolvedValue(assessmentFixture({ findings }));
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-finding-stale_source:solo")).toBeTruthy()
    );
    const row = screen.getByTestId("quality-finding-stale_source:solo");
    expect(row.querySelector(`[title="${entityId}"]`)?.textContent).toBe(
      entityId.slice(0, 8)
    );
    expect(row.textContent).not.toContain("涉及材料");
  });

  it("keeps the same alias for the same id across re-renders", async () => {
    // The alias is a pure function of the rows on screen, computed once per
    // assessment — a re-render must not shuffle it.
    const first = render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(`quality-finding-stale_source:${EVIDENCE_ID}`)
      ).toBeTruthy()
    );
    const before = first.container.querySelector(`[title="${EVIDENCE_ID}"]`)
      ?.textContent;
    first.rerender(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    const after = first.container.querySelector(`[title="${EVIDENCE_ID}"]`)
      ?.textContent;
    expect(after).toBe(before);
  });

  it("separates the aliases of two ids that share a prefix on screen", async () => {
    const shared = "0199e6d0-0000-7000-8000-0000000000";
    const firstId = `${shared}ab`;
    const secondId = `${shared}ba`;
    const findings = [
      findingWith({ id: `stale_source:${firstId}`, entityId: firstId }),
      findingWith({ id: `stale_source:${secondId}`, entityId: secondId })
    ];
    getResearchQuality.mockResolvedValue(assessmentFixture({ findings }));
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId(`quality-finding-stale_source:${firstId}`)).toBeTruthy()
    );
    const aliases = [
      screen
        .getByTestId(`quality-finding-stale_source:${firstId}`)
        .querySelector(`[title="${firstId}"]`)?.textContent,
      screen
        .getByTestId(`quality-finding-stale_source:${secondId}`)
        .querySelector(`[title="${secondId}"]`)?.textContent
    ];
    // Two different ids, two different aliases, both traceable by title.
    expect(aliases[0]).not.toBe(aliases[1]);
    expect(firstId.startsWith(aliases[0] ?? "\0")).toBe(true);
    expect(secondId.startsWith(aliases[1] ?? "\0")).toBe(true);
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

/**
 * P0-1 — the conclusion area.
 *
 * The answer leads: score, status, the rules' own explanation, and the risks
 * that need action, all read off the one assessment that was loaded. The
 * tests pin the honesty rules the redesign must not break: an uncomputable
 * score stays 无法计算 (never 0, never a number), a partial evaluation keeps
 * its caveat, metadata stays reachable, and no risk is invented where the
 * findings list is empty.
 */
describe("ResearchQualityPanel · the conclusion area (P0-1)", () => {
  it("leads with a computed score, the status and the risks that need action", async () => {
    getResearchQuality.mockResolvedValue(
      assessmentFixture({
        overall: {
          score: 62,
          status: "adequate",
          explanation: "综合分 62：五个维度可计算，权重覆盖 85%。",
          assessedDimensions: 5,
          coverage: 0.85,
          ruleVersion: RULE_VERSION
        }
      })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-verdict")).toBeTruthy()
    );
    // The score is the anchor, spelled the same way the rules spell it.
    expect(screen.getByTestId("quality-overall-score").textContent).toBe(
      "62 / 100"
    );
    // Status is words, not colour alone.
    expect(screen.getByTestId("quality-verdict").textContent).toContain(
      "基本满足"
    );
    // The rules' own explanation, reused verbatim.
    expect(
      screen.getByTestId("quality-overall-explanation").textContent
    ).toContain("综合分 62");
    // The risk note names the critical finding that actually fired, quoting
    // its reason rather than inventing one.
    expect(screen.getByTestId("quality-verdict-risks").textContent).toContain(
      "1 条严重问题待处理"
    );
    expect(screen.getByTestId("quality-verdict-risks").textContent).toContain(
      "没有任何关联材料"
    );
  });

  it("refuses to dress an uncomputable score up as a number", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-verdict")).toBeTruthy()
    );
    // The default fixture cannot compute an overall score: the conclusion
    // says so, at the same size a number would get — not 0, not 100.
    expect(screen.getByTestId("quality-overall-score").textContent).toBe(
      "无法计算"
    );
    expect(screen.getByTestId("quality-verdict").textContent).toContain(
      "数据不足，无法评估"
    );
  });

  it("keeps the partial-evaluation caveat when dimensions cannot be computed", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-verdict")).toBeTruthy()
    );
    // Four of the six dimensions cannot be computed in the fixture: the
    // conclusion must not read as a complete evaluation.
    expect(screen.getByTestId("quality-coverage").textContent).toContain("45%");
    expect(screen.getByTestId("quality-coverage").textContent).toContain("2/6");
    expect(screen.getByTestId("quality-verdict-risks").textContent).toContain(
      "4/6 个维度无法计算"
    );
    // The standing limitation text is still on screen.
    expect(screen.getByTestId("quality-limitations").textContent).toContain(
      "只读投影"
    );
  });

  it("says so when there is nothing to warn about", async () => {
    // Every dimension computable, no rule fired: the risk area must state
    // that plainly instead of inventing a risk or going silent.
    const dimensions = assessmentFixture().dimensions.map((item) => ({
      ...item,
      score: 80,
      status: "adequate"
    }));
    getResearchQuality.mockResolvedValue(
      assessmentFixture({
        overall: {
          score: 80,
          status: "adequate",
          explanation: "综合分 80：六个维度均可计算。",
          assessedDimensions: 6,
          coverage: 1,
          ruleVersion: RULE_VERSION
        },
        dimensions,
        findings: []
      })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-verdict")).toBeTruthy()
    );
    expect(screen.getByTestId("quality-verdict-risks").textContent).toContain(
      "没有规则命中的质量问题"
    );
    expect(screen.getByTestId("quality-verdict-risks").textContent).not.toContain(
      "严重问题"
    );
  });

  it("keeps the metadata reachable, demoted under the conclusion", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-meta")).toBeTruthy()
    );
    // When it ran, under which rules, over which material — all still one
    // read away, just no longer competing with the answer.
    expect(screen.getByTestId("quality-meta").textContent).toContain(
      ASSESSED_AT.slice(0, 10)
    );
    expect(screen.getByTestId("quality-meta").textContent).toContain(
      "研究质量-v1"
    );
    expect(screen.getByTestId("quality-meta").textContent).toContain(
      "0123456789abcdef"
    );
  });
});

/**
 * P0-2 — the severity count summary.
 *
 * Every count is read off the assessment already in state: the full
 * assessment carries the complete finding set (the 500-row cap belongs to
 * the findings endpoint, not to this payload), so the totals are honest
 * totals and the summary says so when the display is capped. A filter pick
 * never triggers a second request.
 */
describe("ResearchQualityPanel · severity counts (P0-2)", () => {
  it("counts every severity from the loaded assessment", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-severity-summary")).toBeTruthy()
    );
    // The fixture carries three findings: one critical, one info, one warning.
    expect(
      screen.getByTestId("quality-severity-summary").textContent
    ).toContain("全部问题 3 条：严重 1 · 警告 1 · 提示 1");
    expect(screen.getByTestId("quality-filter-critical").textContent).toContain(
      "1"
    );
    expect(screen.getByTestId("quality-filter-all").textContent).toContain("3");
  });

  it("updates the current-filter count without a second request", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-severity-summary")).toBeTruthy()
    );
    fireEvent.click(screen.getByTestId("quality-filter-critical"));
    // The list heading owns the filter result count (Task03B-2 dedup: the
    // summary line no longer repeats it).
    await waitFor(() =>
      expect(screen.getByText(/质量问题（筛选后 1 条，共 1 条）/)).toBeTruthy()
    );
    // Still exactly one request: the counts came from the assessment in
    // state, not from a re-read.
    expect(getResearchQuality).toHaveBeenCalledTimes(1);
    expect(getResearchQualityClaims).not.toHaveBeenCalled();
    expect(getResearchQualityFindings).not.toHaveBeenCalled();
  });

  it("states a zero result plainly", async () => {
    // Only a critical finding on record: the 警告 filter matches nothing,
    // and the summary must say 0 rather than falling silent.
    getResearchQuality.mockResolvedValue(
      assessmentFixture({
        findings: [assessmentFixture().findings[0]]
      })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-severity-summary")).toBeTruthy()
    );
    fireEvent.click(screen.getByTestId("quality-filter-warning"));
    await waitFor(() =>
      expect(screen.getByTestId("quality-findings-empty")).toBeTruthy()
    );
    // The heading says 0 plainly rather than falling silent.
    expect(screen.getByText(/质量问题（筛选后 0 条，共 0 条）/)).toBeTruthy();
    expect(screen.getByTestId("quality-filter-warning").textContent).toContain(
      "0"
    );
  });

  it("caps the display at 500 rows and still reports the full hit count", async () => {
    // 501 warning findings: the display shows the first 500, while the hit
    // count stays the honest 501 — the two numbers must not be conflated.
    const manyFindings = Array.from({ length: 501 }, (_, index) => ({
      ...assessmentFixture().findings[0],
      id: `missing_evidence:capped-${index}`,
      severity: "warning",
      scope: "claim",
      entityId: CLAIM_ID,
      claimId: CLAIM_ID,
      recommendation: "open_claim_detail"
    }));
    getResearchQuality.mockResolvedValue(
      assessmentFixture({ findings: manyFindings })
    );
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-severity-summary")).toBeTruthy()
    );
    expect(
      screen.getByTestId("quality-severity-summary").textContent
    ).toContain("全部问题 501 条");
    // The heading separates the two numbers: 500 displayed, 501 matched.
    expect(screen.getByText(/质量问题（筛选后 500 条，共 501 条）/)).toBeTruthy();
    expect(
      screen.getByTestId("quality-findings").querySelectorAll("li")
    ).toHaveLength(500);
  });

  it("keeps one assessedAt and fingerprint across filter switches", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-severity-summary")).toBeTruthy()
    );
    const before = screen.getByTestId("quality-meta").textContent;
    fireEvent.click(screen.getByTestId("quality-filter-info"));
    await waitFor(() =>
      expect(screen.getByText(/质量问题（筛选后 1 条，共 1 条）/)).toBeTruthy()
    );
    // The reading did not move: same timestamp, same fingerprint, one read.
    expect(screen.getByTestId("quality-meta").textContent).toBe(before);
    expect(getResearchQuality).toHaveBeenCalledTimes(1);
  });
});

/**
 * Task03B-2 — the recommendations section as the one actionable layer.
 *
 * The button goes to a surface the workspace already has (through the same
 * navigation wiring the findings use); with nothing wired there is no
 * button at all. And the section no longer reprints the finding reasons —
 * those live once, in the findings list.
 */
describe("ResearchQualityPanel · the recommendation actions (Task03B-2)", () => {
  function wiredNavigation() {
    return {
      onOpenClaim: vi.fn(),
      onOpenEvidence: vi.fn(),
      onOpenSource: vi.fn(),
      onOpenReader: vi.fn(),
      onOpenPlan: vi.fn()
    };
  }

  it("gives a recommendation a button that acts on the claim it names", async () => {
    const navigation = wiredNavigation();
    render(
      <ResearchQualityPanel
        sessionId={SESSION_ID}
        navigation={navigation as never}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-recommendations")).toBeTruthy()
    );
    // The fixture's recommendation answers the claim's missing evidence, so
    // the button leads to that claim's detail surface.
    const button = screen.getByTestId(
      `quality-recommendation-action-recommendation:claim:${CLAIM_ID}:missing_evidence`
    );
    expect(button.textContent).toBe("补充支持证据");
    fireEvent.click(button);
    expect(navigation.onOpenClaim).toHaveBeenCalledWith(CLAIM_ID);
  });

  it("sends a plan-shaped recommendation to the research plan", async () => {
    const navigation = wiredNavigation();
    getResearchQuality.mockResolvedValue(
      assessmentFixture({
        recommendations: [
          {
            id: "recommendation:session:session:research_completeness",
            title: "把研究缺口纳入计划",
            detail: "当前规则诊断出未闭环的研究缺口。",
            action: "open_research_plan",
            claimId: null,
            evidenceIds: [],
            sourceIds: [],
            findingIds: ["gap:1"]
          }
        ]
      })
    );
    render(
      <ResearchQualityPanel
        sessionId={SESSION_ID}
        navigation={navigation as never}
      />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-recommendations")).toBeTruthy()
    );
    const button = screen.getByTestId(
      "quality-recommendation-action-recommendation:session:session:research_completeness"
    );
    expect(button.textContent).toBe("加入研究计划");
    fireEvent.click(button);
    expect(navigation.onOpenPlan).toHaveBeenCalledTimes(1);
  });

  it("renders no recommendation button when no surface can act", async () => {
    // Same honesty rule as a finding: a control that cannot act is worse
    // than no control, so an unwired navigation leaves the advice without
    // a button rather than with a dead one.
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-recommendations")).toBeTruthy()
    );
    expect(
      screen.queryByTestId(
        `quality-recommendation-action-recommendation:claim:${CLAIM_ID}:missing_evidence`
      )
    ).toBeNull();
    // The advice itself is still readable — only the button is absent.
    expect(
      screen.getByTestId("quality-recommendations").textContent
    ).toContain("补充证据材料");
  });

  it("counts the rule hits it covers instead of reprinting their reasons", async () => {
    // The finding reasons used to be rejoined verbatim into the
    // recommendation's detail; they stay in the findings list, and this
    // section says how many it answers.
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-recommendations")).toBeTruthy()
    );
    const recommendations = screen.getByTestId("quality-recommendations");
    expect(recommendations.textContent).toContain("覆盖 1 条规则命中项");
    // The reason text is NOT duplicated here; it lives in the findings list.
    expect(recommendations.textContent).not.toContain("没有任何关联材料");
    expect(screen.getByTestId("quality-findings").textContent).toContain(
      "没有任何关联材料"
    );
  });

  it("keeps the read-only promise once, in the limitations, not twice", async () => {
    render(
      <ResearchQualityPanel sessionId={SESSION_ID} navigation={noNavigation} />
    );
    await waitFor(() =>
      expect(screen.getByTestId("quality-limitations")).toBeTruthy()
    );
    // The full enumeration lives in the assessment's own limitations; the
    // footer keeps a short promise plus the rule version, and stops
    // repeating the enumeration item by item.
    expect(screen.getByTestId("quality-limitations").textContent).toContain(
      "不修改主张状态"
    );
    expect(screen.getByTestId("quality-footer").textContent).toContain("只读");
    expect(screen.getByTestId("quality-footer").textContent).toContain(
      RULE_VERSION
    );
    expect(screen.getByTestId("quality-footer").textContent).not.toContain(
      "人工裁定或已保存的报告"
    );
  });
});
