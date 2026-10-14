import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";
import type { Claim } from "../domain/claim";
import { LanguageCodeSchema } from "../research/multilingual";
import {
  EvidenceGapKindSchema,
  EvidenceGapSeveritySchema,
  type EvidenceGap,
  type EvidenceGapKind,
  type EvidenceGapSeverity
} from "./evidence-gaps";

/*
 * Research plan — the step between "something is missing" and "here is what
 * came back".
 *
 * A gap diagnosis is *derived*: it is recomputed from persisted state on every
 * read and nobody owns it. A plan item is a different kind of thing — a person
 * decided to go after it, so it is stored, attributed, and carries its own
 * lifecycle. Keeping the two apart is what lets the workspace say "this gap is
 * still open" without inventing progress.
 *
 * The status vocabulary is the part that must never be fudged. `queued` means
 * nobody has started. Only a real search run may move an item to `running`,
 * `completed` or `failed`. When no search capability is wired up — as in this
 * build, where 受控网页搜索 is a separate piece of work — the item stays
 * `queued` and the surfaces say 尚未执行. A paragraph of model prose is not a
 * search result, and no amount of it may be displayed as one.
 */

/* ------------------------------------------------------------------ *
 * Vocabularies
 * ------------------------------------------------------------------ */

export const ResearchPlanStatusSchema = z.enum([
  /** Added to the plan. Nothing has been executed. */
  "queued",
  /** A real search is in flight. */
  "running",
  /** Real results came back and were recorded against the item. */
  "completed",
  /** A search ran and did not succeed. */
  "failed",
  /** Cannot proceed automatically; a person has to decide. */
  "needs_human",
  /** A person judged the gap does not apply to this research task. */
  "not_applicable",
  /** A person closed the gap with a stated reason. */
  "closed"
]);

export type ResearchPlanStatus = z.infer<typeof ResearchPlanStatusSchema>;

/** Statuses that prove something actually ran. `queued` deliberately is not one. */
export const EXECUTED_PLAN_STATUSES: readonly ResearchPlanStatus[] = [
  "running",
  "completed",
  "failed"
];

export const ResearchPlanActionSchema = z.enum([
  "add_to_plan",
  "edit_query",
  "mark_not_applicable",
  "start_search",
  "add_manual_source",
  "record_outcome",
  "retry",
  "close"
]);

export type ResearchPlanAction = z.infer<typeof ResearchPlanActionSchema>;

/*
 * Priority is a person's ordering, not a computed score. It is seeded from the
 * gap severity (blocking first) so the default order is defensible, and a
 * researcher can move it afterwards.
 */
export const RESEARCH_PLAN_PRIORITY_BY_SEVERITY: Readonly<
  Record<EvidenceGapSeverity, number>
> = {
  blocking: 1,
  important: 3,
  advisory: 5
};

/* ------------------------------------------------------------------ *
 * Persisted shape
 * ------------------------------------------------------------------ */

/**
 * What to look for. Written by the plan builder as a starting skeleton and
 * freely editable by a person — but it stays a *query description*, not a
 * result. Nothing here says anything was found.
 */
export const ResearchQuerySchema = z.object({
  /** What kind of material would close the gap. */
  neededEvidenceKind: z.string().min(1).max(400),
  /** Source types worth trying, e.g. 原始数据集 / 监管公告. */
  sourceTypes: z.array(z.string().min(1).max(160)).max(8).default([]),
  /** Search terms. A starting point a person can rewrite. */
  terms: z.array(z.string().min(1).max(200)).max(12).default([]),
  /**
   * The language the terms are written in, when the researcher declared one.
   *
   * A person may run the same question in several languages — Chinese terms,
   * English terms, Japanese terms — as separate plan items, and each records
   * its own language so the reading is never ambiguous. Absent means nobody
   * declared one; it is never guessed here. Stored inside the `query` jsonb,
   * so no migration is needed and old rows simply lack the key.
   */
  queryLanguage: LanguageCodeSchema.optional(),
  /** Optional window. Null means "no window has been decided". */
  timeRange: z
    .object({
      from: z.string().max(40).nullable(),
      to: z.string().max(40).nullable()
    })
    .nullable()
    .default(null),
  notes: z.string().max(2000).nullable().default(null)
});

export type ResearchQuery = z.infer<typeof ResearchQuerySchema>;

/** What actually came back. Only a real search or a person may produce this. */
export const ResearchPlanOutcomeSchema = z.object({
  summary: z.string().min(1).max(2000),
  /** Sources registered as a result. Still sources — not yet evidence. */
  sourceIds: z.array(IdSchema).default([]),
  evidenceIds: z.array(IdSchema).default([]),
  /** Who is accountable for the result being real. */
  recordedBy: z.string().min(1).max(160),
  recordedAt: TimestampSchema
});

export type ResearchPlanOutcome = z.infer<typeof ResearchPlanOutcomeSchema>;

export const ResearchPlanItemSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  /** The derived gap this item answers. Stable for a given state. */
  gapId: z.string().min(1),
  claimId: IdSchema,
  gapKind: EvidenceGapKindSchema,
  severity: EvidenceGapSeveritySchema,
  /** 1 = highest. Seeded from severity, then a person's call. */
  priority: z.number().int().min(1).max(5),
  title: z.string().min(1).max(240),
  /** The question a researcher is trying to answer. */
  question: z.string().min(1).max(600),
  /** Why the current material is not enough, quoted from the diagnosis. */
  whyInsufficient: z.array(z.string()).default([]),
  query: ResearchQuerySchema,
  status: ResearchPlanStatusSchema,
  /** Present only once something real came back. */
  outcome: ResearchPlanOutcomeSchema.nullable(),
  /** Why it was marked not applicable or closed. Required for both. */
  decisionReason: z.string().min(1).max(2000).nullable(),
  decidedBy: z.string().min(1).max(160).nullable(),
  /** Why a search failed, when it did. */
  failureReason: z.string().min(1).max(2000).nullable(),
  supersedesId: IdSchema.nullable(),
  isCurrent: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type ResearchPlanItem = z.infer<typeof ResearchPlanItemSchema>;

/* ------------------------------------------------------------------ *
 * Drafts accepted from the API
 * ------------------------------------------------------------------ */

/** Adding a gap to the plan. The query skeleton may be adjusted first. */
export const ResearchPlanItemDraftSchema = z.object({
  gapId: z.string().trim().min(1).max(300),
  /** Optional overrides for the derived skeleton. */
  query: ResearchQuerySchema.partial().optional(),
  priority: z.number().int().min(1).max(5).optional()
});

export type ResearchPlanItemDraft = z.infer<typeof ResearchPlanItemDraftSchema>;

export const ResearchQueryEditSchema = z.object({
  neededEvidenceKind: z.string().trim().min(1).max(400).optional(),
  sourceTypes: z.array(z.string().trim().min(1).max(160)).max(8).optional(),
  terms: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  /**
   * The language the (edited) terms are written in. The researcher's own
   * declaration — the same question may be pursued in several languages as
   * separate items. Omitted means "leave whatever was recorded".
   */
  queryLanguage: LanguageCodeSchema.optional(),
  timeRange: z
    .object({ from: z.string().max(40).nullable(), to: z.string().max(40).nullable() })
    .nullable()
    .optional(),
  notes: z.string().max(2000).nullable().optional(),
  priority: z.number().int().min(1).max(5).optional()
});

export type ResearchQueryEdit = z.infer<typeof ResearchQueryEditSchema>;

/** Closing a gap, or declaring it does not apply. A reason is mandatory. */
export const ResearchPlanDecisionSchema = z.object({
  reason: z.string().trim().min(10).max(2000)
});

export type ResearchPlanDecision = z.infer<typeof ResearchPlanDecisionSchema>;

/** Recording what a person found by hand, without any search. */
export const ResearchPlanOutcomeDraftSchema = z.object({
  summary: z.string().trim().min(10).max(2000),
  sourceIds: z.array(IdSchema).max(50).default([]),
  evidenceIds: z.array(IdSchema).max(50).default([])
});

export type ResearchPlanOutcomeDraft = z.infer<
  typeof ResearchPlanOutcomeDraftSchema
>;

/* ------------------------------------------------------------------ *
 * Derivation: gap -> research direction
 * ------------------------------------------------------------------ */

type ResearchDirection = {
  /** What would close it. */
  neededEvidenceKind: string;
  /** Types of source worth trying. Suggestions, not findings. */
  sourceTypes: string[];
  /** The question the researcher is answering. */
  question: string;
  /** Whether a recency window is the point of the exercise. */
  lookForward: boolean;
};

/*
 * One direction per gap kind. This table is the whole reason a diagnosis turns
 * into something a person can act on: without it, "缺少反方证据" is a complaint
 * rather than a task.
 */
const RESEARCH_DIRECTIONS: Readonly<Record<EvidenceGapKind, ResearchDirection>> = {
  no_verified_support: {
    neededEvidenceKind: "能直接支持该表述的一手材料或原始数据",
    sourceTypes: ["原始报告", "官方统计", "数据集"],
    question: "哪一份可核对的原始材料能直接支持这条表述？",
    lookForward: false
  },
  unverified_material: {
    neededEvidenceKind: "对已有材料逐条完成的核实记录（对照来源原文）",
    sourceTypes: ["已登记来源的原文"],
    question: "这些已登记的材料，逐条对照原文后是否成立？",
    lookForward: false
  },
  no_counter_check: {
    neededEvidenceKind: "与该主张相反的结论、案例或数据",
    sourceTypes: ["同行评议研究", "监管处罚记录", "反例报道"],
    question: "是否存在与该主张相反的结论或反例？",
    lookForward: false
  },
  missing_primary_source: {
    neededEvidenceKind: "发布该数字或结论的原始来源",
    sourceTypes: ["原始报告", "数据集", "机构公告"],
    question: "这个数字最初由谁发布，原文在哪里？",
    lookForward: false
  },
  source_expired: {
    neededEvidenceKind: "覆盖当前时间范围的更新版本",
    sourceTypes: ["最新统计公报", "更新后的数据集", "年度报告"],
    question: "有没有覆盖当前时间范围的新版本可以替换过期材料？",
    lookForward: true
  },
  source_not_yet_effective: {
    neededEvidenceKind: "已生效的版本，或说明生效时间与适用范围的正式文件",
    sourceTypes: ["生效文件", "实施公告"],
    question: "该材料何时生效？生效前是否有可用的替代依据？",
    lookForward: false
  },
  unknown_publication_date: {
    neededEvidenceKind: "补齐来源的发布时间或版本号",
    sourceTypes: ["来源页面", "版本说明", "存档快照"],
    question: "这份来源发布于什么时候，属于哪个版本？",
    lookForward: false
  },
  source_independence_unverified: {
    neededEvidenceKind: "确认这些材料是否同源，并补充真正独立的来源",
    sourceTypes: ["独立媒体", "原始发布方", "行业数据"],
    question: "这些材料是否引用同一个上游出处？有没有独立来源可以补充？",
    lookForward: false
  },
  excerpt_not_locatable: {
    neededEvidenceKind: "可重新定位的摘录（页码 / 段落 / 表行号）",
    sourceTypes: ["已保存的原文快照"],
    question: "这条摘录在原文的哪个位置，是否还能重新定位？",
    lookForward: false
  },
  unresolved_dispute: {
    neededEvidenceKind: "能直接回应争议点的材料",
    sourceTypes: ["争议方回应", "第三方评估", "原始数据"],
    question: "哪份材料能直接回应尚未解决的争议？",
    lookForward: false
  },
  unmapped_reference: {
    neededEvidenceKind: "被提到但尚未登记的材料",
    sourceTypes: ["原始报告", "数据集"],
    question: "挑战者提到的这些材料是否真实存在？能否登记为证据？",
    lookForward: false
  },
  review_requires_more_evidence: {
    neededEvidenceKind: "人工复核点名要求补充的材料",
    sourceTypes: ["按复核意见指定的来源类型"],
    question: "复核要求补充的是什么材料？",
    lookForward: false
  },
  overbroad_claim: {
    neededEvidenceKind: "限定条件、反例，或能支撑该范围的完整数据",
    sourceTypes: ["全量数据", "反例报道", "条件说明"],
    question: "这条表述的范围是否过宽？有没有反例或适用条件？",
    lookForward: false
  },
  insufficient_time_or_scope_evidence: {
    neededEvidenceKind: "覆盖该时间范围、范围口径或因果链条的材料",
    sourceTypes: ["时间序列数据", "口径说明", "因果推断研究"],
    question: "现有材料是否真的覆盖了该时间范围、范围与因果关系？",
    lookForward: true
  }
};

/** The direction this gap kind implies. Exported so the UI can explain itself. */
export function researchDirectionFor(gapKind: EvidenceGapKind): ResearchDirection {
  return RESEARCH_DIRECTIONS[gapKind];
}

function shiftYears(reference: Date, years: number): string {
  const shifted = new Date(reference.getTime());
  shifted.setUTCFullYear(shifted.getUTCFullYear() - years);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Builds the stored plan item for one gap.
 *
 * Everything structural comes from persisted data: the claim, the severity the
 * diagnosis assigned, and the direction table. The only thing derived from the
 * claim's own wording is the initial search term, which is just the statement —
 * a starting point a person is expected to rewrite, not a query the system
 * claims to have run.
 */
export function planItemFromGap(input: {
  gap: EvidenceGap;
  claim: Pick<Claim, "id" | "statement">;
  /** Owner of the item. A plan without an owner is a wish. */
  actor: string;
  /** Reference instant, so the derived window is deterministic in tests. */
  asOf: Date;
  priority?: number;
}): Omit<ResearchPlanItem, "id" | "sessionId" | "supersedesId" | "isCurrent" | "createdAt" | "updatedAt"> {
  const { gap, claim } = input;
  const direction = researchDirectionFor(gap.kind);
  const statement = claim.statement.trim();

  return {
    gapId: gap.id,
    claimId: gap.claimId,
    gapKind: gap.kind,
    severity: gap.severity,
    priority: input.priority ?? RESEARCH_PLAN_PRIORITY_BY_SEVERITY[gap.severity],
    title: gap.message,
    question: direction.question,
    whyInsufficient: [...gap.detail],
    query: {
      neededEvidenceKind: direction.neededEvidenceKind,
      sourceTypes: [...direction.sourceTypes],
      terms: statement.length > 0 ? [statement.slice(0, 200)] : [],
      timeRange: direction.lookForward
        ? { from: shiftYears(input.asOf, 1), to: null }
        : null,
      notes: null
    },
    status: "queued",
    outcome: null,
    decisionReason: null,
    decidedBy: null,
    failureReason: null
  };
}

/* ------------------------------------------------------------------ *
 * Building and reading the plan
 * ------------------------------------------------------------------ */

export type ResearchPlanDraft = ReturnType<typeof planItemFromGap> & {
  /** True when the gap already had a current item and was therefore skipped. */
  alreadyPlanned?: boolean;
};

/**
 * Turns a fresh gap diagnosis into the items that are not already on the plan.
 *
 * `existing` holds the current items. A gap that already has one is skipped
 * rather than duplicated: pressing "加入研究计划" twice must not create two
 * tasks, and a gap a person explicitly closed must not silently come back on
 * the next refresh.
 */
export function buildResearchPlan(input: {
  gaps: readonly EvidenceGap[];
  claims: readonly Pick<Claim, "id" | "statement">[];
  existing: readonly Pick<ResearchPlanItem, "gapId">[];
  actor: string;
  asOf: Date;
}): { items: ResearchPlanDraft[]; skippedGapIds: string[] } {
  const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));
  const planned = new Set(input.existing.map((item) => item.gapId));

  const items: ResearchPlanDraft[] = [];
  const skippedGapIds: string[] = [];

  for (const gap of input.gaps) {
    const claim = claimById.get(gap.claimId);
    if (!claim) continue;
    if (planned.has(gap.id)) {
      skippedGapIds.push(gap.id);
      continue;
    }
    items.push(
      planItemFromGap({ gap, claim, actor: input.actor, asOf: input.asOf })
    );
  }

  return { items, skippedGapIds };
}

/**
 * Which actions make sense right now.
 *
 * This is the state machine behind the buttons, and it is where "no faked
 * execution" is enforced: `start_search` is offered only when a search
 * capability is actually available, and a `completed` item cannot be completed
 * again.
 */
export function availablePlanActions(input: {
  status: ResearchPlanStatus;
  searchAvailable: boolean;
}): ResearchPlanAction[] {
  const { status, searchAvailable } = input;
  const actions: ResearchPlanAction[] = [];

  if (status === "queued" || status === "needs_human") {
    if (searchAvailable) actions.push("start_search");
    actions.push("edit_query", "add_manual_source", "mark_not_applicable", "close");
  }
  if (status === "running" || status === "failed") {
    actions.push("record_outcome");
    if (status === "failed" && searchAvailable) actions.push("retry");
    actions.push("close");
  }
  if (status === "completed") {
    actions.push("close");
  }
  if (status === "not_applicable" || status === "closed") {
    actions.push("edit_query");
  }

  return actions;
}

/** True only when something really ran. Used by the UI to decide its wording. */
export function isSearchExecuted(status: ResearchPlanStatus): boolean {
  return EXECUTED_PLAN_STATUSES.includes(status);
}

/**
 * The sentence the workspace, the report and the export all use, so a reader
 * never sees two different progress claims for the same plan.
 */
export function researchPlanHeadline(summary: ResearchPlanSummary): string {
  const { total, completed, notStarted, open } = summary;
  if (total === 0) return "研究计划还没有条目。";
  const executed = total - notStarted;
  if (executed === 0) {
    return `研究计划 ${total} 项，均已加入但尚未执行任何检索。`;
  }
  return `研究计划 ${total} 项：已完成 ${completed} 项、进行中/失败 ${
    executed - completed
  } 项，尚未执行 ${notStarted} 项，仍待解决 ${open} 项。`;
}

export type ResearchPlanSummary = {
  total: number;
  byStatus: Record<ResearchPlanStatus, number>;
  /** Items nobody has started. Shown as 尚未执行, never as in progress. */
  notStarted: number;
  completed: number;
  /** Items that still need work: anything not completed/closed/not_applicable. */
  open: number;
  /** Gaps a person explicitly decided not to pursue. */
  dismissed: number;
};

export function summarizeResearchPlan(input: {
  items: readonly Pick<ResearchPlanItem, "status" | "gapId">[];
}): ResearchPlanSummary {
  const byStatus: Record<ResearchPlanStatus, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    needs_human: 0,
    not_applicable: 0,
    closed: 0
  };
  for (const item of input.items) {
    byStatus[item.status] += 1;
  }

  const dismissed = byStatus.not_applicable + byStatus.closed;
  return {
    total: input.items.length,
    byStatus,
    notStarted: byStatus.queued,
    completed: byStatus.completed,
    open: input.items.length - byStatus.completed - dismissed,
    dismissed
  };
}

/* ------------------------------------------------------------------ *
 * Failure vocabulary
 * ------------------------------------------------------------------ */

/**
 * Why a plan action could not be carried out. Named so the UI can say what to
 * do next — in particular `search_unavailable`, which is the honest answer
 * when nothing is wired up to actually search, rather than a success message.
 */
export const ResearchPlanFailureCodeSchema = z.enum([
  "plan_item_not_found",
  "gap_not_found",
  "invalid_request",
  "invalid_transition",
  "search_unavailable",
  "source_not_found",
  "storage_unavailable"
]);

export type ResearchPlanFailureCode = z.infer<
  typeof ResearchPlanFailureCodeSchema
>;
