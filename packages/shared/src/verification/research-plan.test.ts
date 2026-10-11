import { describe, expect, it } from "vitest";
import type { Claim } from "../domain/claim";
import {
  EvidenceGapKindSchema,
  type EvidenceGap,
  type EvidenceGapKind
} from "./evidence-gaps";
import {
  availablePlanActions,
  buildResearchPlan,
  isSearchExecuted,
  planItemFromGap,
  researchDirectionFor,
  researchPlanHeadline,
  summarizeResearchPlan,
  type ResearchPlanItem
} from "./research-plan";

/**
 * The research plan is where "something is missing" becomes "someone is going
 * to do something about it". Two properties matter most:
 *
 *   - adding an item must never look like having executed anything, and
 *   - the same gap must not be planned twice, including after a person closed
 *     it — otherwise a refresh silently resurrects work they dismissed.
 */

const AS_OF = new Date("2026-10-11T00:00:00.000Z");

function claim(overrides: Partial<Claim> = {}): Pick<Claim, "id" | "statement"> {
  return {
    id: "claim-1",
    statement: "上半年社会消费品零售总额同比增长百分之五点零。",
    ...overrides
  };
}

function gap(overrides: Partial<EvidenceGap> = {}): EvidenceGap {
  return {
    id: "no_verified_support:claim-1",
    claimId: "claim-1",
    kind: "no_verified_support",
    severity: "blocking",
    message: "尚无已核实的直接支持证据，当前无法得出支持该主张的结论。",
    detail: ["关联材料 2 条，其中已核实 0 条。"],
    evidenceIds: ["evidence-1"],
    challengeIds: [],
    actions: ["record_source"],
    suggestions: [],
    ...overrides
  };
}

function item(overrides: Partial<ResearchPlanItem> = {}): ResearchPlanItem {
  return {
    id: "plan-1",
    sessionId: "session-1",
    gapId: "no_verified_support:claim-1",
    claimId: "claim-1",
    gapKind: "no_verified_support",
    severity: "blocking",
    priority: 1,
    title: "尚无已核实的直接支持证据。",
    question: "哪一份可核对的原始材料能直接支持这条表述？",
    whyInsufficient: [],
    query: {
      neededEvidenceKind: "能直接支持该表述的一手材料或原始数据",
      sourceTypes: [],
      terms: [],
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
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...overrides
  };
}

describe("researchDirectionFor", () => {
  it("has an actionable direction for every gap kind", () => {
    // A kind without a direction would be a complaint the UI cannot turn into
    // a task, so the table has to stay exhaustive as kinds are added.
    for (const kind of EvidenceGapKindSchema.options) {
      const direction = researchDirectionFor(kind as EvidenceGapKind);
      expect(direction.neededEvidenceKind.length).toBeGreaterThan(0);
      expect(direction.question.length).toBeGreaterThan(0);
    }
  });
});

describe("planItemFromGap", () => {
  it("starts every item as queued, never as executed", () => {
    const built = planItemFromGap({
      gap: gap(),
      claim: claim(),
      actor: "Researcher (researcher)",
      asOf: AS_OF
    });
    expect(built.status).toBe("queued");
    expect(built.outcome).toBeNull();
    expect(isSearchExecuted(built.status)).toBe(false);
  });

  it("seeds priority from the severity the diagnosis assigned", () => {
    const blocking = planItemFromGap({
      gap: gap({ severity: "blocking" }),
      claim: claim(),
      actor: "a",
      asOf: AS_OF
    });
    const advisory = planItemFromGap({
      gap: gap({ severity: "advisory" }),
      claim: claim(),
      actor: "a",
      asOf: AS_OF
    });
    expect(blocking.priority).toBe(1);
    expect(advisory.priority).toBe(5);
    expect(blocking.priority).toBeLessThan(advisory.priority);
  });

  it("carries the diagnosis detail through so the why stays checkable", () => {
    const built = planItemFromGap({
      gap: gap({ detail: ["关联材料 3 条，其中已核实 0 条。", "命中的规则：unverified。"] }),
      claim: claim(),
      actor: "a",
      asOf: AS_OF
    });
    expect(built.whyInsufficient).toEqual([
      "关联材料 3 条，其中已核实 0 条。",
      "命中的规则：unverified。"
    ]);
    expect(built.title).toBe(gap().message);
  });

  it("asks for opposing material when the gap is a missing counter-check", () => {
    const built = planItemFromGap({
      gap: gap({ kind: "no_counter_check", id: "no_counter_check:claim-1" }),
      claim: claim(),
      actor: "a",
      asOf: AS_OF
    });
    expect(built.query.neededEvidenceKind).toContain("相反");
    expect(built.query.sourceTypes.join()).toContain("反例");
  });

  it("only opens a date window for gaps that are about recency", () => {
    const expired = planItemFromGap({
      gap: gap({ kind: "source_expired", id: "source_expired:claim-1" }),
      claim: claim(),
      actor: "a",
      asOf: AS_OF
    });
    // One year back from the reference instant, and an open upper bound: the
    // point of the task is to beat the stale material, not to bound it.
    expect(expired.query.timeRange).toEqual({ from: "2025-10-11", to: null });

    const noSupport = planItemFromGap({
      gap: gap(),
      claim: claim(),
      actor: "a",
      asOf: AS_OF
    });
    expect(noSupport.query.timeRange).toBeNull();
  });

  it("uses the claim's own wording as a starting term instead of inventing one", () => {
    const built = planItemFromGap({
      gap: gap(),
      claim: claim({ statement: "  出口连续三个季度下滑。  " }),
      actor: "a",
      asOf: AS_OF
    });
    expect(built.query.terms).toEqual(["出口连续三个季度下滑。"]);
  });
});

describe("buildResearchPlan", () => {
  it("plans a gap that is not on the plan yet", () => {
    const built = buildResearchPlan({
      gaps: [gap()],
      claims: [claim()],
      existing: [],
      actor: "a",
      asOf: AS_OF
    });
    expect(built.items).toHaveLength(1);
    expect(built.skippedGapIds).toHaveLength(0);
  });

  it("does not plan the same gap twice", () => {
    const built = buildResearchPlan({
      gaps: [gap()],
      claims: [claim()],
      existing: [{ gapId: gap().id }],
      actor: "a",
      asOf: AS_OF
    });
    expect(built.items).toHaveLength(0);
    expect(built.skippedGapIds).toEqual([gap().id]);
  });

  it("skips a gap whose claim is not in this research task", () => {
    const built = buildResearchPlan({
      gaps: [gap({ claimId: "claim-elsewhere" })],
      claims: [claim()],
      existing: [],
      actor: "a",
      asOf: AS_OF
    });
    expect(built.items).toHaveLength(0);
  });
});

describe("availablePlanActions", () => {
  it("refuses to start a search when nothing is wired up to search", () => {
    const withoutSearch = availablePlanActions({
      status: "queued",
      searchAvailable: false
    });
    // The honest answer: this build cannot search, so it must not offer a
    // button that would end in a paragraph of prose presented as a result.
    expect(withoutSearch).not.toContain("start_search");
    expect(withoutSearch).toContain("add_manual_source");
    expect(withoutSearch).toContain("mark_not_applicable");
    expect(withoutSearch).toContain("close");

    expect(
      availablePlanActions({ status: "queued", searchAvailable: true })
    ).toContain("start_search");
  });

  it("offers a retry only after a search actually failed", () => {
    expect(
      availablePlanActions({ status: "failed", searchAvailable: true })
    ).toContain("retry");
    expect(
      availablePlanActions({ status: "queued", searchAvailable: true })
    ).not.toContain("retry");
    expect(
      availablePlanActions({ status: "completed", searchAvailable: true })
    ).not.toContain("retry");
  });

  it("does not let a running item be started or completed twice", () => {
    const running = availablePlanActions({
      status: "running",
      searchAvailable: true
    });
    expect(running).not.toContain("start_search");
    expect(running).not.toContain("retry");
    expect(running).toContain("record_outcome");
  });

  it("leaves a person a way out of every open state", () => {
    for (const status of ["queued", "running", "failed", "needs_human"] as const) {
      expect(
        availablePlanActions({ status, searchAvailable: false })
      ).toContain("close");
    }
  });
});

describe("summarizeResearchPlan", () => {
  it("keeps 尚未执行 apart from work in flight", () => {
    const summary = summarizeResearchPlan({
      items: [
        item({ id: "a", status: "queued" }),
        item({ id: "b", status: "queued" }),
        item({ id: "c", status: "running" }),
        item({ id: "d", status: "completed" }),
        item({ id: "e", status: "not_applicable" })
      ]
    });
    expect(summary.total).toBe(5);
    expect(summary.notStarted).toBe(2);
    expect(summary.completed).toBe(1);
    // Open = still needs work: the two queued ones plus the one in flight.
    expect(summary.open).toBe(3);
    expect(summary.dismissed).toBe(1);
    // Crucially, "not started" is a subset of open and is reported on its own,
    // so a plan nobody has touched cannot read as a plan in progress.
    expect(summary.notStarted).toBeLessThan(summary.open);
  });
});

describe("researchPlanHeadline", () => {
  it("says nothing has run rather than implying progress", () => {
    const summary = summarizeResearchPlan({
      items: [item({ id: "a", status: "queued" }), item({ id: "b", status: "queued" })]
    });
    const headline = researchPlanHeadline(summary);
    expect(headline).toContain("2 项");
    expect(headline).toContain("尚未执行");
    expect(headline).not.toContain("已完成 0");
  });

  it("reports the mix once something actually ran", () => {
    const summary = summarizeResearchPlan({
      items: [
        item({ id: "a", status: "completed" }),
        item({ id: "b", status: "queued" })
      ]
    });
    const headline = researchPlanHeadline(summary);
    expect(headline).toContain("已完成 1 项");
    expect(headline).toContain("尚未执行 1 项");
  });

  it("handles an empty plan", () => {
    expect(researchPlanHeadline(summarizeResearchPlan({ items: [] }))).toContain(
      "还没有条目"
    );
  });
});
