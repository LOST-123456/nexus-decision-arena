import {
  type EvidenceRepository,
  type ResearchSearchRepository,
  SourceTitleConflictError
} from "@nexus/db";
import {
  newId,
  type ResearchSearchFailureCode,
  type ResearchSearchTask,
  type ResearchSearchTaskDraft,
  type SearchCandidate,
  type Source
} from "@nexus/shared";
import {
  type SearchLead,
  SearchProviderError,
  type SearchProvider
} from "./search-provider";

export class ResearchSearchError extends Error {
  constructor(
    message: string,
    readonly code: ResearchSearchFailureCode,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "ResearchSearchError";
  }
}

/** A task with its surfaced candidates attached — what the UI renders. */
export type ResearchSearchView = ResearchSearchTask & {
  candidates: SearchCandidate[];
};

export type SearchServiceDependencies = {
  search: Pick<
    ResearchSearchRepository,
    | "createSearchTask"
    | "getSearchTask"
    | "startSearch"
    | "completeSearch"
    | "failSearch"
    | "rejectTask"
    | "markCandidateApproved"
    | "listCandidates"
    | "listSearchTasksWithCounts"
  >;
  /** Evidence rows, used only to register approved candidates as Sources. */
  material: Pick<EvidenceRepository, "listSources" | "createSource">;
  provider: SearchProvider;
  now?: () => Date;
};

/**
 * The controlled research search.
 *
 * The single most important property of this service: it never produces
 * evidence. A search surfaces *candidates*; approving a task copies them into
 * `sources` (provenance) and stops. Evidence is a different, human-driven step
 * that cites an already-registered source. Nothing here writes
 * `evidence.verification_status` or calls the evidence verification path, and it
 * never will — that is the line this feature exists to hold.
 */
export class ResearchSearchService {
  constructor(private readonly dependencies: SearchServiceDependencies) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  /**
   * Creates a search task and immediately runs the controlled search.
   *
   * There is no separate "run" endpoint: a task is either completed with
   * candidates or failed with a reason, never left hanging in `queued` because a
   * later step forgot to start it. The search is deterministic and network-free,
   * so completing it inline is honest, not a simulation of latency.
   */
  async createAndRun(input: {
    sessionId: string;
    draft: ResearchSearchTaskDraft;
    taskId: string;
    actor: string;
  }): Promise<{ task: ResearchSearchTask; candidates: SearchCandidate[] }> {
    const now = this.now();
    const iso = now.toISOString();

    let task: ResearchSearchTask;
    try {
      const created = await this.dependencies.search.createSearchTask({
        sessionId: input.sessionId,
        task: {
          id: input.taskId,
          sessionId: input.sessionId,
          planItemId: input.draft.planItemId,
          query: input.draft.query,
          purpose: input.draft.purpose,
          keywords: input.draft.keywords,
          status: "queued",
          failureReason: null
        },
        event: {
          correlationId: input.taskId,
          type: "SEARCH_TASK_CREATED",
          payload: {
            taskId: input.taskId,
            planItemId: input.draft.planItemId,
            query: input.draft.query,
            purpose: input.draft.purpose,
            createdBy: input.actor
          }
        }
      });
      task = created.task;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ResearchSearchPlanItemNotFoundError"
      ) {
        throw new ResearchSearchError(
          error.message,
          "plan_item_not_found",
          404
        );
      }
      throw error;
    }

    await this.dependencies.search.startSearch({
      sessionId: input.sessionId,
      taskId: input.taskId
    });

    try {
      const leads = await this.dependencies.provider.search({
        query: input.draft.query,
        purpose: input.draft.purpose,
        keywords: input.draft.keywords,
        sessionId: input.sessionId,
        taskId: input.taskId,
        now
      });
      const candidates: SearchCandidate[] = leads.map((lead: SearchLead) => ({
        id: newId(),
        taskId: input.taskId,
        sessionId: input.sessionId,
        url: lead.url,
        title: lead.title,
        publisher: lead.publisher,
        retrievedAt: iso,
        sourceType: lead.sourceType,
        note: lead.note,
        approvedAt: null,
        registeredSourceId: null,
        createdAt: iso
      }));
      const completed = await this.dependencies.search.completeSearch({
        sessionId: input.sessionId,
        taskId: input.taskId,
        candidates,
        event: {
          correlationId: input.taskId,
          type: "SEARCH_COMPLETED",
          payload: {
            taskId: input.taskId,
            candidateCount: candidates.length,
            completedBy: input.actor
          }
        }
      });
      return { task: completed.task, candidates };
    } catch (error) {
      if (error instanceof SearchProviderError) {
        const failed = await this.dependencies.search.failSearch({
          sessionId: input.sessionId,
          taskId: input.taskId,
          failureReason: error.message,
          event: {
            correlationId: input.taskId,
            type: "SEARCH_FAILED",
            payload: {
              taskId: input.taskId,
              reason: error.message,
              failedBy: input.actor
            }
          }
        });
        return { task: failed.task, candidates: [] };
      }
      throw error;
    }
  }

  /** Reads a task with its candidates. 404 when the task is unknown. */
  async getSearchTask(input: {
    sessionId: string;
    taskId: string;
  }): Promise<ResearchSearchView> {
    const task = await this.dependencies.search.getSearchTask(
      input.sessionId,
      input.taskId
    );
    const candidates = await this.dependencies.search.listCandidates(
      input.sessionId,
      input.taskId
    );
    return { ...task, candidates };
  }

  /** Lists all tasks for a session with their candidate counts. */
  async listSearchTasks(input: {
    sessionId: string;
  }): Promise<Array<ResearchSearchTask & { candidateCount: number }>> {
    return this.dependencies.search.listSearchTasksWithCounts(
      input.sessionId
    );
  }

  /**
   * Approves a completed task: each unapproved candidate becomes a Source.
   *
   * This is the only place a candidate crosses into the provenance layer, and it
   * stops there — a Source, never an Evidence. Turning a source into verified
   * evidence is a separate, human-driven step that cites an already-registered
   * source; this method never writes evidence or touches verification status.
   */
  async approve(input: {
    sessionId: string;
    taskId: string;
    actor: string;
  }): Promise<{ task: ResearchSearchTask; registeredSourceIds: string[] }> {
    const now = this.now();
    const iso = now.toISOString();
    const task = await this.dependencies.search.getSearchTask(
      input.sessionId,
      input.taskId
    );
    if (task.status !== "completed") {
      throw new ResearchSearchError(
        `只有已完成的检索任务可以核准，当前状态为 ${task.status}。`,
        "invalid_transition",
        409
      );
    }
    const candidates = await this.dependencies.search.listCandidates(
      input.sessionId,
      input.taskId
    );
    const existing = await this.dependencies.material.listSources(input.sessionId);
    const byTitle = new Map(existing.map((source) => [source.title, source.id]));
    const registeredSourceIds: string[] = [];

    for (const candidate of candidates) {
      if (candidate.approvedAt) continue; // Idempotent: already approved.
      const existingId = byTitle.get(candidate.title);
      let sourceId: string;
      if (existingId) {
        sourceId = existingId;
      } else {
        const source: Source = {
          id: newId(),
          sessionId: input.sessionId,
          title: candidate.title,
          kind: candidate.sourceType,
          url: candidate.url,
          publisher: candidate.publisher,
          canonicalUrl: candidate.url,
          retrievedAt: candidate.retrievedAt,
          retrievalStatus: "not_requested",
          retrievalAttempts: 0,
          note: candidate.note ?? undefined,
          createdBy: "human",
          createdAt: iso,
          updatedAt: iso
        };
        try {
          const created = await this.dependencies.material.createSource(source);
          sourceId = created.source.id;
        } catch (error) {
          if (error instanceof SourceTitleConflictError) {
            const match = (
              await this.dependencies.material.listSources(input.sessionId)
            ).find((source) => source.title === candidate.title);
            if (!match) throw error;
            sourceId = match.id;
          } else {
            throw error;
          }
        }
      }
      await this.dependencies.search.markCandidateApproved({
        candidateId: candidate.id,
        sourceId,
        now: iso
      });
      registeredSourceIds.push(sourceId);
      byTitle.set(candidate.title, sourceId);
    }

    const updated = await this.dependencies.search.getSearchTask(
      input.sessionId,
      input.taskId
    );
    return { task: updated, registeredSourceIds };
  }

  /**
   * Rejects a completed or queued task's candidates.
   *
   * Recorded as a decision (rejectedAt / rejectedBy), never silently dropped,
   * and never creates a source. Rejecting says "we looked and chose not to
   * register these" — which is itself a finding worth keeping.
   */
  async reject(input: {
    sessionId: string;
    taskId: string;
    actor: string;
  }): Promise<{ task: ResearchSearchTask }> {
    const task = await this.dependencies.search.getSearchTask(
      input.sessionId,
      input.taskId
    );
    if (task.status !== "completed" && task.status !== "queued") {
      throw new ResearchSearchError(
        `只有已完成或排队中的检索任务可以驳回，当前状态为 ${task.status}。`,
        "invalid_transition",
        409
      );
    }
    const updated = await this.dependencies.search.rejectTask({
      sessionId: input.sessionId,
      taskId: input.taskId,
      actor: input.actor,
      now: this.now().toISOString()
    });
    return { task: updated };
  }
}
