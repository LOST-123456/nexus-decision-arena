import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules of the research-plan surface, checked against the real component.
 *
 * Only the data access is faked. What these tests pin down is the honesty
 * contract: a queued item reads 尚未执行 and never 进行中, no search control
 * exists in this build, closing a gap demands a stated reason, and an outcome
 * is recorded as what a person found.
 */

const getResearchPlan = vi.fn();
const addToResearchPlan = vi.fn();
const editPlanItemQuery = vi.fn();
const decidePlanItem = vi.fn();
const recordPlanOutcome = vi.fn();
const listPlanItemHistory = vi.fn();

class ResearchPlanFailedError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "ResearchPlanFailedError";
  }
}

/**
 * The plan panel embeds the controlled-search panel, whose error handlers
 * consult this class from "./api". The mock must export it, or the error
 * path itself throws (unhandled rejection) instead of rendering a message.
 */
class ResearchSearchFailedError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = "ResearchSearchFailedError";
  }
}

vi.mock("./api", () => ({
  ResearchPlanFailedError,
  ResearchSearchFailedError,
  getResearchPlan: (...args: unknown[]) => getResearchPlan(...args),
  addToResearchPlan: (...args: unknown[]) => addToResearchPlan(...args),
  editPlanItemQuery: (...args: unknown[]) => editPlanItemQuery(...args),
  decidePlanItem: (...args: unknown[]) => decidePlanItem(...args),
  recordPlanOutcome: (...args: unknown[]) => recordPlanOutcome(...args),
  listPlanItemHistory: (...args: unknown[]) => listPlanItemHistory(...args)
}));

const { ResearchPlanPanel } = await import("./research-plan");

const SESSION_ID = "0199e6d0-0000-7000-8000-000000000001";
const GAP_ID = "gap-1";
const ITEM_ID = "0199e6d0-0000-7000-8000-000000000002";

function planView(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION_ID,
    generatedAt: "2026-10-11T00:00:00.000Z",
    searchAvailable: false,
    items: [
      {
        id: ITEM_ID,
        sessionId: SESSION_ID,
        gapId: GAP_ID,
        claimId: "claim-1",
        gapKind: "no_verified_support",
        severity: "blocking",
        priority: 1,
        title: "缺少已核实支持材料",
        question: "哪一份可核对的原始材料能直接支持这条表述？",
        whyInsufficient: ["没有已核实的支持性材料。"],
        query: {
          neededEvidenceKind: "能直接支持该表述的一手材料或原始数据",
          sourceTypes: ["原始报告"],
          terms: ["市场规模三年内翻倍"],
          timeRange: null,
          notes: null
        },
        status: "queued",
        outcome: null,
        decisionReason: null,
        decidedBy: null,
        failureReason: null,
        supersedesId: null,
        isCurrent: true,
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
        availableActions: ["edit_query", "add_manual_source", "mark_not_applicable", "close"]
      }
    ],
    availableGaps: [
      {
        id: "gap-2",
        claimId: "claim-1",
        kind: "no_counter_check",
        severity: "important",
        message: "缺少反向核查材料",
        detail: ["尚无与该主张相反的核查。"],
        evidenceIds: [],
        challengeIds: [],
        actions: ["add_opposing_evidence"],
        suggestions: []
      }
    ],
    summary: {
      total: 1,
      byStatus: {
        queued: 1,
        running: 0,
        completed: 0,
        failed: 0,
        needs_human: 0,
        not_applicable: 0,
        closed: 0
      },
      notStarted: 1,
      completed: 0,
      open: 1,
      dismissed: 0
    },
    headline: "研究计划 1 项，均已加入但尚未执行任何检索。",
    ...overrides
  };
}

beforeEach(() => {
  for (const mock of [
    getResearchPlan,
    addToResearchPlan,
    editPlanItemQuery,
    decidePlanItem,
    recordPlanOutcome,
    listPlanItemHistory
  ]) {
    mock.mockReset();
  }
  getResearchPlan.mockResolvedValue(planView());
});

afterEach(() => {
  cleanup();
});

describe("ResearchPlanPanel", () => {
  it("shows a queued item as 尚未执行 with no search control anywhere", async () => {
    render(<ResearchPlanPanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId("plan-headline").textContent).toContain(
        "尚未执行任何检索"
      )
    );
    expect(screen.getByTestId("plan-not-started").textContent).toContain("1");
    expect(screen.getByTestId("plan-search-note").textContent).toContain(
      "未接入受控网页搜索"
    );
    const actions = screen.getByTestId(`plan-actions-${ITEM_ID}`).textContent;
    expect(actions).toContain("编辑检索词");
    expect(actions).toContain("登记人工查找结果");
    expect(actions).not.toContain("开始检索");
    expect(document.body.textContent).not.toContain("检索进行中");
  });

  it("adds a diagnosed gap to the plan and says honestly it has not run", async () => {
    addToResearchPlan.mockResolvedValue({ item: {}, alreadyPlanned: false });
    render(<ResearchPlanPanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`add-gap-gap-2`)).toBeTruthy()
    );
    fireEvent.click(screen.getByTestId("add-gap-gap-2"));
    await waitFor(() => expect(addToResearchPlan).toHaveBeenCalledTimes(1));
    expect(addToResearchPlan).toHaveBeenCalledWith(SESSION_ID, {
      gapId: "gap-2"
    });
    await waitFor(() =>
      expect(screen.getByTestId("plan-notice").textContent).toContain("尚未执行")
    );
  });

  it("requires a reason of at least 10 characters before closing a gap", async () => {
    render(<ResearchPlanPanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`plan-actions-${ITEM_ID}`)).toBeTruthy()
    );
    fireEvent.click(screen.getByText("关闭"));
    fireEvent.change(screen.getByTestId("plan-decision-reason"), {
      target: { value: "太短" }
    });
    fireEvent.click(screen.getByTestId("plan-decision-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("plan-notice").textContent).toContain(
        "至少 10 个字"
      )
    );
    expect(decidePlanItem).not.toHaveBeenCalled();
  });

  it("sends a decision with its result and stated reason", async () => {
    decidePlanItem.mockResolvedValue({ item: {} });
    render(<ResearchPlanPanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`plan-actions-${ITEM_ID}`)).toBeTruthy()
    );
    fireEvent.click(screen.getByText("标记不适用"));
    fireEvent.change(screen.getByTestId("plan-decision-reason"), {
      target: { value: "该主张属于范围外议题，与本研究问题无关。" }
    });
    fireEvent.click(screen.getByTestId("plan-decision-submit"));
    await waitFor(() => expect(decidePlanItem).toHaveBeenCalledTimes(1));
    expect(decidePlanItem).toHaveBeenCalledWith(SESSION_ID, ITEM_ID, {
      result: "not_applicable",
      reason: "该主张属于范围外议题，与本研究问题无关。"
    });
  });

  it("records a manual outcome against a queued item", async () => {
    recordPlanOutcome.mockResolvedValue({ item: {} });
    render(<ResearchPlanPanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`plan-actions-${ITEM_ID}`)).toBeTruthy()
    );
    fireEvent.click(screen.getByText("登记人工查找结果"));
    fireEvent.change(screen.getByTestId("plan-outcome-summary"), {
      target: { value: "在行业年报中找到覆盖同一时期的原始统计表。" }
    });
    fireEvent.click(screen.getByTestId("plan-outcome-submit"));
    await waitFor(() => expect(recordPlanOutcome).toHaveBeenCalledTimes(1));
    expect(recordPlanOutcome).toHaveBeenCalledWith(SESSION_ID, ITEM_ID, {
      summary: "在行业年报中找到覆盖同一时期的原始统计表。"
    });
  });

  it("sends an edited query with the split terms", async () => {
    editPlanItemQuery.mockResolvedValue({ item: {} });
    render(<ResearchPlanPanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId(`plan-actions-${ITEM_ID}`)).toBeTruthy()
    );
    fireEvent.click(screen.getByText("编辑检索词"));
    fireEvent.change(screen.getByTestId("plan-terms-input"), {
      target: { value: "行业年报 出货量、统计公报" }
    });
    fireEvent.click(screen.getByTestId("plan-query-submit"));
    await waitFor(() => expect(editPlanItemQuery).toHaveBeenCalledTimes(1));
    expect(editPlanItemQuery).toHaveBeenCalledWith(SESSION_ID, ITEM_ID, {
      terms: ["行业年报 出货量", "统计公报"],
      notes: null
    });
  });

  it("offers no write controls to a viewer", async () => {
    render(<ResearchPlanPanel sessionId={SESSION_ID} canEdit={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("plan-items")).toBeTruthy()
    );
    expect(screen.queryByTestId(`plan-actions-${ITEM_ID}`)).toBeNull();
    expect(screen.queryByTestId("add-gap-gap-2")).toBeNull();
  });

  it("surfaces a failed read with a retry instead of an empty success", async () => {
    getResearchPlan.mockRejectedValueOnce(
      new ResearchPlanFailedError("boom", "storage_unavailable")
    );
    render(<ResearchPlanPanel sessionId={SESSION_ID} canEdit />);
    await waitFor(() =>
      expect(screen.getByTestId("plan-error")).toBeTruthy()
    );
    expect(screen.getByTestId("plan-error").textContent).toContain(
      "研究计划暂不可用"
    );
    expect(screen.getByTestId("retry-plan")).toBeTruthy();
  });
});
