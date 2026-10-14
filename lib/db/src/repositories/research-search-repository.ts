import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  type ExecutionEvent,
  type ResearchSearchTask,
  ResearchSearchTaskSchema,
  type SearchCandidate,
  SearchCandidateSchema
} from "@nexus/shared";
import type { Database } from "../client";
import { researchPlanItems, researchSearchTasks, searchCandidates } from "../schema";
import { appendEvent, type AppendEventInput, type DbExecutor, type ReadExecutor } from "./append-event";
import { iso } from "./domain-mapper";

export class ResearchSearchTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Research search task not found: ${taskId}`);
    this.name = "ResearchSearchTaskNotFoundError";
  }
}

export class ResearchSearchPlanItemNotFoundError extends Error {
  constructor(planItemId: string) {
    super(`Research plan item not found for search task: ${planItemId}`);
    this.name = "ResearchSearchPlanItemNotFoundError";
  }
}

/**
 * A search task about to be stored. The server fills in the lifecycle columns.
 */
export type NewResearchSearchTask = Omit<
  ResearchSearchTask,
  "createdAt" | "updatedAt" | "finishedAt"
>;

function mapSearchTask(row: typeof researchSearchTasks.$inferSelect): ResearchSearchTask {
  // `timestamptz` reads back as Postgres text (or a Date); normalize through `iso()`.
  return ResearchSearchTaskSchema.parse({
    ...row,
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    failureReason: row.failureReason ?? null,
    rejectedAt: row.rejectedAt ? iso(row.rejectedAt) : null,
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

function mapCandidate(row: typeof searchCandidates.$inferSelect): SearchCandidate {
  return SearchCandidateSchema.parse({
    ...row,
    note: row.note ?? null,
    approvedAt: row.approvedAt ? iso(row.approvedAt) : null,
    retrievedAt: iso(row.retrievedAt),
    createdAt: iso(row.createdAt)
  });
}

/**
 * The only writer of controlled-search rows.
 *
 * The hard line this repository enforces: it stores *tasks* and *candidates*.
 * It never writes `evidence`, never writes `evidence.verification_status`, and
 * never turns a candidate into anything more than a `sources` row when a person
 * approves one. The approve transfer itself lives in the service layer (which
 * holds the evidence repository) so the boundary stays visible: a candidate
 * becomes a source only through an explicit human decision, and a source
 * becomes evidence only through the existing, unchanged evidence path.
 */
export class ResearchSearchRepository {
  constructor(private readonly database: Database) {}

  /**
   * Creates a search task in the `queued` state and records its creation.
   *
   * The plan item must belong to the session; a task answers a real gap, not a
   * free-floating request.
   */
  async createSearchTask(input: {
    sessionId: string;
    task: NewResearchSearchTask;
    event: AppendEventInput;
  }): Promise<{ task: ResearchSearchTask; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const [planItem] = await transaction
        .select({ id: researchPlanItems.id })
        .from(researchPlanItems)
        .where(
          and(
            eq(researchPlanItems.sessionId, input.sessionId),
            eq(researchPlanItems.id, input.task.planItemId),
            eq(researchPlanItems.isCurrent, true)
          )
        )
        .limit(1);
      if (!planItem) {
        throw new ResearchSearchPlanItemNotFoundError(input.task.planItemId);
      }

      const now = new Date().toISOString();
      await transaction.insert(researchSearchTasks).values({
        ...input.task,
        keywords: input.task.keywords,
        status: input.task.status,
        failureReason: input.task.failureReason ?? null,
        rejectedAt: null,
        rejectedBy: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null
      });
      const [row] = await transaction
        .select()
        .from(researchSearchTasks)
        .where(eq(researchSearchTasks.id, input.task.id));
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { task: mapSearchTask(row!), event };
    });
  }

  async getSearchTask(
    sessionId: string,
    taskId: string
  ): Promise<ResearchSearchTask> {
    const [row] = await this.database
      .select()
      .from(researchSearchTasks)
      .where(
        and(
          eq(researchSearchTasks.sessionId, sessionId),
          eq(researchSearchTasks.id, taskId)
        )
      )
      .limit(1);
    if (!row) throw new ResearchSearchTaskNotFoundError(taskId);
    return mapSearchTask(row);
  }

  async listSearchTasks(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<ResearchSearchTask[]> {
    const rows = await executor
      .select()
      .from(researchSearchTasks)
      .where(eq(researchSearchTasks.sessionId, sessionId))
      .orderBy(desc(researchSearchTasks.createdAt));
    return rows.map(mapSearchTask);
  }

  async listSearchTasksByPlanItem(
    sessionId: string,
    planItemId: string
  ): Promise<ResearchSearchTask[]> {
    const rows = await this.database
      .select()
      .from(researchSearchTasks)
      .where(
        and(
          eq(researchSearchTasks.sessionId, sessionId),
          eq(researchSearchTasks.planItemId, planItemId)
        )
      )
      .orderBy(desc(researchSearchTasks.createdAt));
    return rows.map(mapSearchTask);
  }

  /**
   * All tasks for a session, each with how many candidates it surfaced.
   *
   * The count rides along so the list view can show "候选来源数量" without a
   * fetch per row. Candidates themselves are only loaded on demand (when a
   * person expands a task to inspect them).
   */
  async listSearchTasksWithCounts(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<Array<ResearchSearchTask & { candidateCount: number }>> {
    const tasks = await this.listSearchTasks(sessionId, executor);
    if (tasks.length === 0) return [];
    const rows = await executor
      .select({
        taskId: searchCandidates.taskId,
        count: sql<number>`count(*)::int`
      })
      .from(searchCandidates)
      .where(eq(searchCandidates.sessionId, sessionId))
      .groupBy(searchCandidates.taskId);
    const byTask = new Map(rows.map((row) => [row.taskId, Number(row.count)]));
    return tasks.map((task) => ({
      ...task,
      candidateCount: byTask.get(task.id) ?? 0
    }));
  }

  /**
   * Moves a queued task into `searching`. No result is produced here — that
   * happens in `completeSearch` / `failSearch`.
   */
  async startSearch(input: {
    sessionId: string;
    taskId: string;
  }): Promise<ResearchSearchTask> {
    const now = new Date().toISOString();
    const [row] = await this.database
      .update(researchSearchTasks)
      .set({ status: "searching", updatedAt: now })
      .where(
        and(
          eq(researchSearchTasks.sessionId, input.sessionId),
          eq(researchSearchTasks.id, input.taskId)
        )
      )
      .returning();
    if (!row) throw new ResearchSearchTaskNotFoundError(input.taskId);
    return mapSearchTask(row);
  }

  /**
   * Settles a search that produced candidates.
   *
   * Everything lands in one transaction: the task flips to `completed`, the
   * candidates are inserted, and `SEARCH_COMPLETED` plus one
   * `SOURCE_CANDIDATE_FOUND` per candidate are recorded so the audit trail
   * cannot omit a lead.
   */
  async completeSearch(input: {
    sessionId: string;
    taskId: string;
    candidates: SearchCandidate[];
    event: AppendEventInput;
  }): Promise<{ task: ResearchSearchTask; events: ExecutionEvent[] }> {
    return this.database.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const [row] = await transaction
        .update(researchSearchTasks)
        .set({ status: "completed", updatedAt: now, finishedAt: now })
        .where(
          and(
            eq(researchSearchTasks.sessionId, input.sessionId),
            eq(researchSearchTasks.id, input.taskId)
          )
        )
        .returning();
      if (!row) throw new ResearchSearchTaskNotFoundError(input.taskId);

      if (input.candidates.length > 0) {
        await transaction.insert(searchCandidates).values(
          input.candidates.map((candidate) => ({
            id: candidate.id,
            taskId: candidate.taskId,
            sessionId: candidate.sessionId,
            url: candidate.url,
            title: candidate.title,
            publisher: candidate.publisher,
            retrievedAt: candidate.retrievedAt,
            sourceType: candidate.sourceType,
            note: candidate.note ?? null,
            approvedAt: null,
            registeredSourceId: null,
            createdAt: now
          }))
        );
      }

      const events: ExecutionEvent[] = [];
      events.push(
        await appendEvent(transaction, input.sessionId, input.event)
      );
      for (const candidate of input.candidates) {
        events.push(
          await appendEvent(transaction, input.sessionId, {
            correlationId: input.event.correlationId,
            type: "SOURCE_CANDIDATE_FOUND",
            payload: {
              taskId: candidate.taskId,
              candidateId: candidate.id,
              url: candidate.url,
              title: candidate.title,
              sourceType: candidate.sourceType
            }
          })
        );
      }
      return { task: mapSearchTask(row), events };
    });
  }

  /**
   * Settles a search that did not produce anything.
   *
   * `failureReason` is mandatory — a failed search that explains itself is the
   * honest path, distinct from an unexpected internal error.
   */
  async failSearch(input: {
    sessionId: string;
    taskId: string;
    failureReason: string;
    event: AppendEventInput;
  }): Promise<{ task: ResearchSearchTask; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const [row] = await transaction
        .update(researchSearchTasks)
        .set({
          status: "failed",
          failureReason: input.failureReason,
          updatedAt: now,
          finishedAt: now
        })
        .where(
          and(
            eq(researchSearchTasks.sessionId, input.sessionId),
            eq(researchSearchTasks.id, input.taskId)
          )
        )
        .returning();
      if (!row) throw new ResearchSearchTaskNotFoundError(input.taskId);
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { task: mapSearchTask(row), event };
    });
  }

  /** Records a person's decision to reject a task's candidates. */
  async rejectTask(input: {
    sessionId: string;
    taskId: string;
    actor: string;
    now: string;
  }): Promise<ResearchSearchTask> {
    const [row] = await this.database
      .update(researchSearchTasks)
      .set({
        rejectedAt: input.now,
        rejectedBy: input.actor,
        updatedAt: input.now
      })
      .where(
        and(
          eq(researchSearchTasks.sessionId, input.sessionId),
          eq(researchSearchTasks.id, input.taskId)
        )
      )
      .returning();
    if (!row) throw new ResearchSearchTaskNotFoundError(input.taskId);
    return mapSearchTask(row);
  }

  /** Stamps a candidate as approved and links the source it became. */
  async markCandidateApproved(input: {
    candidateId: string;
    sourceId: string;
    now: string;
  }): Promise<void> {
    await this.database
      .update(searchCandidates)
      .set({ approvedAt: input.now, registeredSourceId: input.sourceId })
      .where(eq(searchCandidates.id, input.candidateId));
  }

  async listCandidates(
    sessionId: string,
    taskId: string
  ): Promise<SearchCandidate[]> {
    const rows = await this.database
      .select()
      .from(searchCandidates)
      .where(
        and(
          eq(searchCandidates.sessionId, sessionId),
          eq(searchCandidates.taskId, taskId)
        )
      )
      .orderBy(asc(searchCandidates.createdAt));
    return rows.map(mapCandidate);
  }
}
