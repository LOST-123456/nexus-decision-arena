import type { EvidenceRepository, ResearchPlanRepository } from "@nexus/db";
import {
  availablePlanActions,
  planItemFromGap,
  researchPlanHeadline,
  summarizeResearchPlan,
  type EvidenceGap,
  type ResearchPlanAction,
  type ResearchPlanFailureCode,
  type ResearchPlanItem,
  type ResearchPlanItemDraft,
  type ResearchPlanOutcomeDraft,
  type ResearchPlanSummary,
  type ResearchQuery,
  type ResearchQueryEdit
} from "@nexus/shared";
import type { ResearchWorkspace } from "./workspace-service";

/** The shape a partial query edit takes at this boundary (zod's `.partial()`). */
type QueryEditInput = {
  neededEvidenceKind?: string | undefined;
  sourceTypes?: string[] | undefined;
  terms?: string[] | undefined;
  timeRange?: ResearchQuery["timeRange"] | undefined;
  notes?: string | null | undefined;
};

/**
 * Merges a partial edit into a query. Written field by field on purpose: a
 * spread of a partial object leaves `undefined` in place of untouched fields
 * under `exactOptionalPropertyTypes`, which would silently corrupt the query.
 */
function mergeQuery(
  base: ResearchQuery,
  edit: QueryEditInput | undefined
): ResearchQuery {
  if (!edit) return base;
  return {
    neededEvidenceKind: edit.neededEvidenceKind ?? base.neededEvidenceKind,
    sourceTypes: edit.sourceTypes ?? base.sourceTypes,
    terms: edit.terms ?? base.terms,
    timeRange: edit.timeRange !== undefined ? edit.timeRange : base.timeRange,
    notes: edit.notes !== undefined ? edit.notes : base.notes
  };
}

/**
 * The research plan: the step between "a diagnosis says something is missing"
 * and "here is what a person decided to do about it".
 *
 * Two different kinds of thing stay apart on purpose:
 *   - a **gap** is derived. It is recomputed from the persisted research state
 *     on every read (here: through the same workspace projection the UI
 *     already shows, so the two can never disagree), it has no owner and no
 *     lifecycle.
 *   - a **plan item** is a person's decision. It is stored, attributed and
 *     carries its own status lifecycle.
 *
 * The honesty rule this service enforces: nothing here claims a search ran
 * when none did. This build has no controlled web-search integration, so
 * `searchAvailable` is false, `start_search` is offered nowhere, and every
 * item stays `queued` — displayed as 尚未执行 — until real results exist.
 */
export class ResearchPlanError extends Error {
  constructor(
    message: string,
    readonly code: ResearchPlanFailureCode,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "ResearchPlanError";
  }
}

export type ResearchPlanViewItem = ResearchPlanItem & {
  /** The state machine behind the buttons, computed server-side. */
  availableActions: ResearchPlanAction[];
};

export type ResearchPlanView = {
  sessionId: string;
  generatedAt: string;
  /** False in this build: no controlled search is wired up. Stated, not hidden. */
  searchAvailable: boolean;
  items: ResearchPlanViewItem[];
  /** Derived gaps that have not been added to the plan yet. */
  availableGaps: EvidenceGap[];
  summary: ResearchPlanSummary;
  headline: string;
};

export type PlanDependencies = {
  plan: Pick<
    ResearchPlanRepository,
    | "addPlanItem"
    | "listCurrentPlanItems"
    | "listPlanItemHistory"
    | "getPlanItem"
    | "replacePlanItem"
  >;
  /**
   * The same workspace projection the research UI renders, so gap diagnoses
   * shown here can never contradict the ones shown there.
   */
  workspace: (sessionId: string) => Promise<ResearchWorkspace | null>;
  /** Evidence rows, so a recorded outcome may only cite rows of this session. */
  material?: Pick<EvidenceRepository, "listEvidence" | "listSources">;
  searchAvailable: boolean;
  now?: () => Date;
};

export class ResearchPlanService {
  constructor(private readonly dependencies: PlanDependencies) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  /** Passthrough for the report builder. */
  listCurrentPlanItems(sessionId: string): Promise<ResearchPlanItem[]> {
    return this.dependencies.plan.listCurrentPlanItems(sessionId);
  }

  /** The full history of one gap's plan items, newest first. */
  listPlanItemHistory(sessionId: string, gapId: string): Promise<ResearchPlanItem[]> {
    return this.dependencies.plan.listPlanItemHistory(sessionId, gapId);
  }

  /**
   * Reads the plan and the still-unplanned gaps.
   *
   * An empty plan is a valid answer, not an error: the workspace still has to
   * render, and "nothing has been planned" is a real state.
   */
  async getPlan(sessionId: string): Promise<ResearchPlanView | null> {
    const workspace = await this.dependencies.workspace(sessionId);
    if (!workspace) {
      return null;
    }
    const items = await this.dependencies.plan.listCurrentPlanItems(sessionId);
    const plannedGapIds = new Set(items.map((item) => item.gapId));
    const availableGaps = workspace.gaps.filter(
      (gap) => !plannedGapIds.has(gap.id)
    );

    return {
      sessionId,
      generatedAt: this.now().toISOString(),
      searchAvailable: this.dependencies.searchAvailable,
      items: items.map((item) => ({
        ...item,
        availableActions: availablePlanActions({
          status: item.status,
          searchAvailable: this.dependencies.searchAvailable
        })
      })),
      availableGaps,
      summary: summarizeResearchPlan({ items }),
      headline: researchPlanHeadline(summarizeResearchPlan({ items }))
    };
  }

  /**
   * Adds one derived gap to the plan as a queued item owned by `actor`.
   *
   * The gap must come from the current diagnosis — an invented gap id is a
   * 404, not a stored row. The query skeleton is derived server-side from the
   * direction table; the draft may override parts of it before storing.
   */
  async addToPlan(input: {
    sessionId: string;
    draft: ResearchPlanItemDraft;
    itemId: string;
    actor: string;
  }): Promise<{ item: ResearchPlanItem; alreadyPlanned: boolean } | null> {
    const workspace = await this.dependencies.workspace(input.sessionId);
    if (!workspace) {
      return null;
    }
    const gap = workspace.gaps.find((item) => item.id === input.draft.gapId);
    if (!gap) {
      throw new ResearchPlanError(
        `Gap not found in this research task's current diagnosis: ${input.draft.gapId}`,
        "gap_not_found",
        404
      );
    }
    const claim = workspace.claims.find((item) => item.id === gap.claimId);
    if (!claim) {
      throw new ResearchPlanError(
        `The gap's claim is not part of this research task: ${gap.claimId}`,
        "gap_not_found",
        404
      );
    }

    const derived = planItemFromGap({
      gap,
      claim,
      actor: input.actor,
      asOf: this.now(),
      ...(input.draft.priority !== undefined
        ? { priority: input.draft.priority }
        : {})
    });
    const item = {
      id: input.itemId,
      sessionId: input.sessionId,
      ...derived,
      query: mergeQuery(derived.query, input.draft.query)
    };

    const result = await this.dependencies.plan.addPlanItem({
      sessionId: input.sessionId,
      item,
      event: {
        correlationId: input.itemId,
        type: "RESEARCH_PLAN_ITEM_ADDED",
        payload: {
          itemId: input.itemId,
          gapId: gap.id,
          gapKind: gap.kind,
          claimId: gap.claimId,
          status: "queued",
          addedBy: input.actor
        }
      }
    });
    return { item: result.item, alreadyPlanned: result.alreadyPlanned };
  }

  /** Rewrites the query skeleton (or the priority). The status never changes here. */
  async editQuery(input: {
    sessionId: string;
    itemId: string;
    edit: ResearchQueryEdit;
    actor: string;
    replacementId: string;
  }): Promise<{ item: ResearchPlanItem } | null> {
    const current = await this.currentItem(input.sessionId, input.itemId);
    const mergedQuery = mergeQuery(current.query, input.edit);

    const result = await this.dependencies.plan.replacePlanItem({
      sessionId: input.sessionId,
      itemId: input.itemId,
      item: {
        id: input.replacementId,
        sessionId: input.sessionId,
        gapId: current.gapId,
        claimId: current.claimId,
        gapKind: current.gapKind,
        severity: current.severity,
        priority: input.edit.priority ?? current.priority,
        title: current.title,
        question: current.question,
        whyInsufficient: current.whyInsufficient,
        query: mergedQuery,
        status: current.status,
        outcome: current.outcome,
        decisionReason: current.decisionReason,
        decidedBy: current.decidedBy,
        failureReason: current.failureReason
      },
      event: {
        correlationId: input.replacementId,
        type: "RESEARCH_PLAN_QUERY_EDITED",
        payload: {
          itemId: input.replacementId,
          supersedesId: current.id,
          gapId: current.gapId,
          editedBy: input.actor
        }
      }
    });
    return { item: result.item };
  }

  /**
   * Records a person's decision that the gap does not apply, or is closed.
   * Both require a stated reason and are attributed — the database refuses
   * either without one.
   */
  async decide(input: {
    sessionId: string;
    itemId: string;
    result: "not_applicable" | "closed";
    reason: string;
    actor: string;
    replacementId: string;
  }): Promise<{ item: ResearchPlanItem } | null> {
    const current = await this.currentItem(input.sessionId, input.itemId);

    const action = input.result === "not_applicable"
      ? "mark_not_applicable"
      : "close";
    // `close` is offered in every open state, `mark_not_applicable` only
    // before anything ran; the state machine decides, not the route.
    if (!availablePlanActions({ status: current.status, searchAvailable: true }).includes(action)) {
      throw new ResearchPlanError(
        `A ${current.status} item cannot be marked ${input.result}`,
        "invalid_transition",
        409
      );
    }

    const result = await this.dependencies.plan.replacePlanItem({
      sessionId: input.sessionId,
      itemId: input.itemId,
      item: {
        id: input.replacementId,
        sessionId: input.sessionId,
        gapId: current.gapId,
        claimId: current.claimId,
        gapKind: current.gapKind,
        severity: current.severity,
        priority: current.priority,
        title: current.title,
        question: current.question,
        whyInsufficient: current.whyInsufficient,
        query: current.query,
        status: input.result,
        outcome: current.outcome,
        decisionReason: input.reason,
        decidedBy: input.actor,
        failureReason: current.failureReason
      },
      event: {
        correlationId: input.replacementId,
        type: "RESEARCH_PLAN_ITEM_CLOSED",
        payload: {
          itemId: input.replacementId,
          supersedesId: current.id,
          gapId: current.gapId,
          result: input.result,
          reason: input.reason,
          decidedBy: input.actor
        }
      }
    });
    return { item: result.item };
  }

  /**
   * Records what a person actually found — by hand, or after a search ran.
   *
   * The outcome is a human statement attributed to `actor`, and every source
   * or evidence id it cites must already be registered in this session: an
   * outcome that points at material nobody can read is not an outcome.
   */
  async recordOutcome(input: {
    sessionId: string;
    itemId: string;
    draft: ResearchPlanOutcomeDraft;
    actor: string;
    replacementId: string;
  }): Promise<{ item: ResearchPlanItem } | null> {
    const current = await this.currentItem(input.sessionId, input.itemId);

    const actionable = availablePlanActions({
      status: current.status,
      searchAvailable: this.dependencies.searchAvailable
    });
    // Manual recording (`add_manual_source`) covers queued/needs_human;
    // `record_outcome` covers running/failed. `completed` cannot complete again.
    const viaManual = actionable.includes("add_manual_source");
    if (!viaManual && !actionable.includes("record_outcome")) {
      throw new ResearchPlanError(
        `A ${current.status} item cannot record an outcome`,
        "invalid_transition",
        409
      );
    }

    await this.assertMaterialInSession(input.sessionId, input.draft);

    const now = this.now().toISOString();
    const result = await this.dependencies.plan.replacePlanItem({
      sessionId: input.sessionId,
      itemId: input.itemId,
      item: {
        id: input.replacementId,
        sessionId: input.sessionId,
        gapId: current.gapId,
        claimId: current.claimId,
        gapKind: current.gapKind,
        severity: current.severity,
        priority: current.priority,
        title: current.title,
        question: current.question,
        whyInsufficient: current.whyInsufficient,
        query: current.query,
        status: "completed",
        outcome: {
          summary: input.draft.summary,
          sourceIds: input.draft.sourceIds,
          evidenceIds: input.draft.evidenceIds,
          recordedBy: input.actor,
          recordedAt: now
        },
        decisionReason: null,
        decidedBy: null,
        failureReason: null
      },
      event: {
        correlationId: input.replacementId,
        type: "RESEARCH_PLAN_OUTCOME_RECORDED",
        payload: {
          itemId: input.replacementId,
          supersedesId: current.id,
          gapId: current.gapId,
          via: viaManual ? "manual" : "after_search",
          sourceIds: input.draft.sourceIds,
          evidenceIds: input.draft.evidenceIds,
          recordedBy: input.actor
        }
      }
    });
    return { item: result.item };
  }

  /**
   * The honest answer to "start a search": this build has no controlled
   * web-search integration (a separate piece of work), so no code path here
   * can move an item to `running` or claim results. When the search
   * integration lands, this is where it plugs in.
   */
  async startSearch(): Promise<never> {
    throw new ResearchPlanError(
      "本构建未接入受控网页搜索，无法执行检索；条目保持「尚未执行」状态。",
      "search_unavailable",
      501
    );
  }

  private async currentItem(
    sessionId: string,
    itemId: string
  ): Promise<ResearchPlanItem> {
    const workspaceExists = await this.dependencies.workspace(sessionId);
    if (!workspaceExists) {
      throw new ResearchPlanError(
        `Session not found: ${sessionId}`,
        "plan_item_not_found",
        404
      );
    }
    try {
      return await this.dependencies.plan.getPlanItem(sessionId, itemId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ResearchPlanItemNotFoundError"
      ) {
        throw new ResearchPlanError(
          error.message,
          "plan_item_not_found",
          404
        );
      }
      throw error;
    }
  }

  private async assertMaterialInSession(
    sessionId: string,
    draft: ResearchPlanOutcomeDraft
  ): Promise<void> {
    if (!this.dependencies.material) return;
    if (draft.sourceIds.length === 0 && draft.evidenceIds.length === 0) return;

    const [sources, evidence] = await Promise.all([
      this.dependencies.material.listSources(sessionId),
      this.dependencies.material.listEvidence(sessionId)
    ]);
    const knownSources = new Set(sources.map((item) => item.id));
    const knownEvidence = new Set(evidence.map((item) => item.id));
    const unknownSources = draft.sourceIds.filter((id) => !knownSources.has(id));
    const unknownEvidence = draft.evidenceIds.filter(
      (id) => !knownEvidence.has(id)
    );
    if (unknownSources.length > 0 || unknownEvidence.length > 0) {
      throw new ResearchPlanError(
        `Outcome cites material that is not registered in this research task: ` +
          [
            ...unknownSources.map((id) => `source ${id}`),
            ...unknownEvidence.map((id) => `evidence ${id}`)
          ].join(", "),
        "invalid_request",
        400
      );
    }
  }
}

/**
 * Convenience wrapper used by the report builder: which gaps already have a
 * current plan item. Kept here so the report never re-derives plan state from
 * event logs or guesswork.
 */
export async function planStatusByGapId(
  dependencies: Pick<PlanDependencies, "plan">,
  sessionId: string
): Promise<Map<string, ResearchPlanItem>> {
  const items = await dependencies.plan.listCurrentPlanItems(sessionId);
  return new Map(items.map((item) => [item.gapId, item]));
}
