import { describe, expect, it } from "vitest";
import {
  newId,
  type Claim,
  type Evidence,
  type EvidenceGap,
  type ResearchPlanItem,
  type Source
} from "@nexus/shared";
import type {
  EvidenceRepository,
  ResearchPlanRepository
} from "@nexus/db";
import {
  ResearchPlanError,
  ResearchPlanService
} from "./research-plan-service";
import type { ResearchWorkspace } from "./workspace-service";

/**
 * Behaviour of the research plan service with the repositories faked.
 *
 * The boundary under test: a plan item is a person's decision derived from a
 * real gap diagnosis; nothing here can claim a search ran; an outcome may only
 * cite material that actually exists in the session.
 */

const SESSION_ID = newId();

let counter = 0;

function claim(overrides: Partial<Claim> = {}): Claim {
  counter += 1;
  return {
    id: newId(),
    sessionId: SESSION_ID,
    lens: "evidence",
    statement: `Claim ${counter}: 市场规模三年内翻倍`,
    type: "fact",
    stance: "support",
    importance: 4,
    confidence: 0.8,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: "",
    revision: 1,
    relations: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

function gap(claimId: string, overrides: Partial<EvidenceGap> = {}): EvidenceGap {
  counter += 1;
  return {
    id: `gap-${counter}`,
    claimId,
    kind: "no_verified_support",
    severity: "blocking",
    message: `缺少已核实支持材料 ${counter}`,
    detail: ["没有已核实的支持性材料。"],
    evidenceIds: [],
    challengeIds: [],
    actions: ["add_supporting_evidence"],
    suggestions: [],
    ...overrides
  };
}

function workspace(input: {
  claims: Claim[];
  gaps: EvidenceGap[];
}): ResearchWorkspace {
  return {
    session: {
      id: SESSION_ID,
      phase: "EVIDENCE",
      operationalStatus: "running",
      researchQuestion: null,
      currentConclusion: null
    },
    claims: input.claims,
    evidence: [],
    sources: [],
    conflicts: [],
    challenges: [],
    agentRuns: [],
    reviews: [],
    verdicts: [],
    gaps: input.gaps,
    openReviewRequests: [],
    summary: {
      claims: input.claims.length,
      evidence: 0,
      sources: 0,
      challenges: 0,
      unresolvedChallenges: 0,
      reviews: 0,
      failedRuns: 0,
      verified: 0,
      unverified: 0,
      rejected: 0,
      openVerdicts: 0,
      needsMoreEvidence: 0,
      blockingGaps: input.gaps.filter((item) => item.severity === "blocking")
        .length
    }
  };
}

/**
 * An in-memory stand-in for `ResearchPlanRepository` that follows the same
 * contract: every add is a queued row, every transition supersedes.
 */
function fakePlanRepo() {
  const rows = new Map<string, ResearchPlanItem>();
  let sequence = 0;

  function store(item: Omit<ResearchPlanItem, "supersedesId" | "isCurrent" | "createdAt" | "updatedAt"> & { supersedesId?: string | null }): ResearchPlanItem {
    const now = new Date().toISOString();
    const row: ResearchPlanItem = {
      ...item,
      supersedesId: item.supersedesId ?? null,
      isCurrent: true,
      createdAt: now,
      updatedAt: now
    };
    rows.set(row.id, row);
    return row;
  }

  return {
    rows,
    async addPlanItem(payload: {
      sessionId: string;
      item: Omit<ResearchPlanItem, "supersedesId" | "isCurrent" | "createdAt" | "updatedAt">;
      event: unknown;
    }) {
      if (payload.item.claimId === "missing-claim") {
        throw new Error("Claim(s) not part of this research task");
      }
      const existing = [...rows.values()].find(
        (row) => row.gapId === payload.item.gapId && row.isCurrent
      );
      if (existing) {
        return { item: existing, event: null, alreadyPlanned: true };
      }
      sequence += 1;
      return {
        item: store(payload.item),
        event: { sequence } as never,
        alreadyPlanned: false
      };
    },
    async listCurrentPlanItems() {
      return [...rows.values()]
        .filter((row) => row.isCurrent)
        .sort((left, right) => left.priority - right.priority);
    },
    async listPlanItemHistory() {
      return [...rows.values()];
    },
    async getPlanItem(_sessionId: string, itemId: string) {
      const row = rows.get(itemId);
      if (!row || !row.isCurrent) {
        const error = new Error(`Research plan item not found: ${itemId}`);
        error.name = "ResearchPlanItemNotFoundError";
        throw error;
      }
      return row;
    },
    async replacePlanItem(payload: {
      sessionId: string;
      itemId: string;
      item: Omit<ResearchPlanItem, "supersedesId" | "isCurrent" | "createdAt" | "updatedAt">;
      event: unknown;
    }) {
      const previous = rows.get(payload.itemId);
      if (!previous || !previous.isCurrent) {
        const error = new Error(
          `Research plan item not found: ${payload.itemId}`
        );
        error.name = "ResearchPlanItemNotFoundError";
        throw error;
      }
      rows.set(previous.id, { ...previous, isCurrent: false });
      sequence += 1;
      return {
        item: store({ ...payload.item, supersedesId: previous.id }),
        event: { sequence } as never
      };
    }
  } as unknown as Pick<
    ResearchPlanRepository,
    | "addPlanItem"
    | "listCurrentPlanItems"
    | "listPlanItemHistory"
    | "getPlanItem"
    | "replacePlanItem"
  >;
}

function fakeMaterial(input: {
  sources?: Source[];
  evidence?: Evidence[];
}): Pick<EvidenceRepository, "listEvidence" | "listSources"> {
  return {
    listSources: async () => input.sources ?? [],
    listEvidence: async () => input.evidence ?? []
  };
}

function buildService(input: {
  claims: Claim[];
  gaps: EvidenceGap[];
  plan?: ReturnType<typeof fakePlanRepo>;
  material?: Pick<EvidenceRepository, "listEvidence" | "listSources">;
}) {
  const plan = input.plan ?? fakePlanRepo();
  return new ResearchPlanService({
    plan,
    workspace: async (sessionId) =>
      sessionId === SESSION_ID ? workspace({ claims: input.claims, gaps: input.gaps }) : null,
    ...(input.material ? { material: input.material } : {}),
    searchAvailable: false
  });
}

describe("ResearchPlanService", () => {
  it("shows queued items with no start_search and states search is unavailable", async () => {
    const claimRow = claim();
    const gapRow = gap(claimRow.id);
    const service = buildService({ claims: [claimRow], gaps: [gapRow] });
    const { item } = (await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员甲"
    }))!;

    expect(item.status).toBe("queued");
    expect(item.query.terms).toContain(claimRow.statement);

    const view = await service.getPlan(SESSION_ID);
    expect(view).not.toBeNull();
    expect(view!.searchAvailable).toBe(false);
    expect(view!.items[0]!.availableActions).not.toContain("start_search");
    expect(view!.items[0]!.availableActions).toContain("edit_query");
    expect(view!.items[0]!.availableActions).toContain("close");
    expect(view!.summary.notStarted).toBe(1);
    expect(view!.headline).toContain("尚未执行任何检索");
  });

  it("refuses to add an unknown gap and returns 404-shaped error", async () => {
    const service = buildService({ claims: [claim()], gaps: [] });
    await expect(
      service.addToPlan({
        sessionId: SESSION_ID,
        draft: { gapId: "gap-does-not-exist" },
        itemId: newId(),
        actor: "研究员甲"
      })
    ).rejects.toMatchObject({
      code: "gap_not_found",
      httpStatus: 404
    } satisfies Partial<ResearchPlanError>);
  });

  it("returns the existing item instead of duplicating when a gap is added twice", async () => {
    const claimRow = claim();
    const gapRow = gap(claimRow.id);
    const service = buildService({ claims: [claimRow], gaps: [gapRow] });
    const first = await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员甲"
    });
    const second = await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员乙"
    });
    expect(second!.alreadyPlanned).toBe(true);
    expect(second!.item.id).toBe(first!.item.id);
  });

  it("derives the query skeleton from the gap's direction table", async () => {
    const claimRow = claim();
    const gapRow = gap(claimRow.id, { kind: "no_counter_check" });
    const service = buildService({ claims: [claimRow], gaps: [gapRow] });
    const { item } = (await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员甲"
    }))!;
    expect(item.gapKind).toBe("no_counter_check");
    expect(item.query.neededEvidenceKind).toContain("相反");
    expect(item.priority).toBe(1); // blocking -> 1
  });

  it("edits the query without changing status or priority unless asked", async () => {
    const claimRow = claim();
    const gapRow = gap(claimRow.id);
    const plan = fakePlanRepo();
    const service = buildService({ claims: [claimRow], gaps: [gapRow], plan });
    const added = await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员甲"
    });
    const { item } = (await service.editQuery({
      sessionId: SESSION_ID,
      itemId: added!.item.id,
      edit: { terms: ["新检索词"], notes: "先查行业协会数据" },
      actor: "研究员甲",
      replacementId: newId()
    }))!;
    expect(item.status).toBe("queued");
    expect(item.query.terms).toEqual(["新检索词"]);
    expect(item.query.notes).toBe("先查行业协会数据");
    expect(item.priority).toBe(added!.item.priority);
  });

  it("records the declared query language and never guesses one", async () => {
    const claimRow = claim();
    const gapRow = gap(claimRow.id);
    const plan = fakePlanRepo();
    const service = buildService({ claims: [claimRow], gaps: [gapRow], plan });
    const added = await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员甲"
    });
    // The derived skeleton declares no language: a person may pursue the same
    // question in several languages as separate items, and each records its
    // own — nothing here invents one.
    expect(added!.item.query.queryLanguage).toBeUndefined();

    const declared = (await service.editQuery({
      sessionId: SESSION_ID,
      itemId: added!.item.id,
      edit: { terms: ["gross margin"], queryLanguage: "en" },
      actor: "研究员甲",
      replacementId: newId()
    }))!;
    expect(declared.item.query.queryLanguage).toBe("en");

    // A later edit that says nothing about the language keeps the recorded one.
    const kept = (await service.editQuery({
      sessionId: SESSION_ID,
      itemId: declared.item.id,
      edit: { notes: "补充说明" },
      actor: "研究员甲",
      replacementId: newId()
    }))!;
    expect(kept.item.query.queryLanguage).toBe("en");
  });

  it("marks a queued item not applicable with the required reason", async () => {
    const claimRow = claim();
    const gapRow = gap(claimRow.id);
    const service = buildService({ claims: [claimRow], gaps: [gapRow] });
    const added = await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员甲"
    });
    const { item } = (await service.decide({
      sessionId: SESSION_ID,
      itemId: added!.item.id,
      result: "not_applicable",
      reason: "该主张属于范围外议题，与本研究问题无关。",
      actor: "研究员甲",
      replacementId: newId()
    }))!;
    expect(item.status).toBe("not_applicable");
    expect(item.decisionReason).toContain("范围外");
    expect(item.decidedBy).toBe("研究员甲");
  });

  it("refuses an invalid transition, e.g. closing a not_applicable item again", async () => {
    const claimRow = claim();
    const gapRow = gap(claimRow.id);
    const service = buildService({ claims: [claimRow], gaps: [gapRow] });
    const added = await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员甲"
    });
    // A transition supersedes the row, so the current id is the new one.
    const superseded = await service.decide({
      sessionId: SESSION_ID,
      itemId: added!.item.id,
      result: "not_applicable",
      reason: "范围外。",
      actor: "研究员甲",
      replacementId: newId()
    });
    // not_applicable only offers edit_query afterwards.
    await expect(
      service.decide({
        sessionId: SESSION_ID,
        itemId: superseded!.item.id,
        result: "closed",
        reason: "再次关闭同一项。",
        actor: "研究员乙",
        replacementId: newId()
      })
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  it("records a manual outcome on a queued item and completes it", async () => {
    const claimRow = claim();
    const gapRow = gap(claimRow.id);
    const sourceRow = {
      id: newId(),
      sessionId: SESSION_ID,
      title: "行业协会统计",
      kind: "url",
      createdBy: "human",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z"
    } satisfies Source;
    const service = buildService({
      claims: [claimRow],
      gaps: [gapRow],
      material: fakeMaterial({ sources: [sourceRow as Source] })
    });
    const added = await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员甲"
    });
    const { item } = (await service.recordOutcome({
      sessionId: SESSION_ID,
      itemId: added!.item.id,
      draft: {
        summary: "在行业协会年报中找到了覆盖同一时期的原始统计表。",
        sourceIds: [sourceRow.id],
        evidenceIds: []
      },
      actor: "研究员甲",
      replacementId: newId()
    }))!;
    expect(item.status).toBe("completed");
    expect(item.outcome).not.toBeNull();
    expect(item.outcome!.recordedBy).toBe("研究员甲");
    expect(item.outcome!.sourceIds).toEqual([sourceRow.id]);
  });

  it("refuses an outcome that cites material from another research task", async () => {
    const claimRow = claim();
    const gapRow = gap(claimRow.id);
    const service = buildService({
      claims: [claimRow],
      gaps: [gapRow],
      material: fakeMaterial({})
    });
    const added = await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: gapRow.id },
      itemId: newId(),
      actor: "研究员甲"
    });
    await expect(
      service.recordOutcome({
        sessionId: SESSION_ID,
        itemId: added!.item.id,
        draft: {
          summary: "引用了另一个研究会话里的来源，必须被拒绝。",
          sourceIds: [newId()],
          evidenceIds: []
        },
        actor: "研究员甲",
        replacementId: newId()
      })
    ).rejects.toMatchObject({ code: "invalid_request", httpStatus: 400 });
  });

  it("answers every start_search attempt with search_unavailable", async () => {
    const service = buildService({ claims: [], gaps: [] });
    await expect(service.startSearch()).rejects.toMatchObject({
      code: "search_unavailable",
      httpStatus: 501
    });
  });

  it("returns 404 for plan operations on an unknown session", async () => {
    const service = buildService({ claims: [claim()], gaps: [] });
    const view = await service.getPlan("no-such-session");
    expect(view).toBeNull();
    await expect(
      service.editQuery({
        sessionId: "no-such-session",
        itemId: newId(),
        edit: { terms: ["x"] },
        actor: "研究员甲",
        replacementId: newId()
      })
    ).rejects.toMatchObject({ code: "plan_item_not_found", httpStatus: 404 });
  });

  it("excludes planned gaps from availableGaps and keeps the headline honest", async () => {
    const claimRow = claim();
    const plannedGap = gap(claimRow.id);
    const openGap = gap(claimRow.id, { severity: "advisory" });
    const service = buildService({
      claims: [claimRow],
      gaps: [plannedGap, openGap]
    });
    await service.addToPlan({
      sessionId: SESSION_ID,
      draft: { gapId: plannedGap.id },
      itemId: newId(),
      actor: "研究员甲"
    });
    const view = await service.getPlan(SESSION_ID);
    expect(view!.availableGaps.map((item) => item.id)).toEqual([openGap.id]);
    expect(view!.summary.total).toBe(1);
  });
});
