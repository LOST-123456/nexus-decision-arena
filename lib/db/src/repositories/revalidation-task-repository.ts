import { and, desc, eq, ne } from "drizzle-orm";
import {
  newId,
  type RevalidationTask,
  type RevalidationTaskStatus,
  RevalidationTaskSchema
} from "@nexus/shared";
import type { Database } from "../client";
import { revalidationTasks, revalidationTaskEvents } from "../schema";
import type { ReadExecutor } from "./append-event";
import { iso } from "./domain-mapper";

export class RevalidationTaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Revalidation task not found: ${taskId}`);
    this.name = "RevalidationTaskNotFoundError";
  }
}

/** A task about to be opened, already carrying the version that opened it. */
export type NewRevalidationTask = {
  id: string;
  sessionId: string;
  sourceId: string;
  sourceTitle: string;
  triggerContentHash: string;
  previousSnapshotId: string | null;
  currentSnapshotId: string | null;
  affectedEvidenceIds: string[];
  affectedClaimIds: string[];
  reason: string;
};

/** One appended status change, so the history of a task is inspectable. */
export type RevalidationTaskEvent = {
  id: string;
  taskId: string;
  sessionId: string;
  fromStatus: RevalidationTaskStatus | null;
  toStatus: RevalidationTaskStatus;
  note: string | null;
  actor: string;
  createdAt: string;
};

function mapRevalidationTask(
  row: typeof revalidationTasks.$inferSelect
): RevalidationTask {
  // Every nullable timestamptz goes through `iso()`: Postgres hands back text
  // or a Date, and the shared schema demands a strict ISO string or null. An
  // open task has no closure time, so `resolvedAt` stays null rather than
  // being coerced into a bogus epoch.
  return RevalidationTaskSchema.parse({
    ...row,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    resolvedAt: row.resolvedAt === null ? null : iso(row.resolvedAt),
    resolvedBy: row.resolvedBy ?? null,
    resolutionNote: row.resolutionNote ?? null
  });
}

function mapRevalidationTaskEvent(
  row: typeof revalidationTaskEvents.$inferSelect
): RevalidationTaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    sessionId: row.sessionId,
    fromStatus: (row.fromStatus ?? null) as RevalidationTaskStatus | null,
    toStatus: row.toStatus as RevalidationTaskStatus,
    note: row.note ?? null,
    actor: row.actor,
    createdAt: iso(row.createdAt)
  };
}

/**
 * The only writer of re-check tasks.
 *
 * Two things it refuses to do are the point. It never writes to `claims`,
 * `evidence` or `source_snapshots` — a re-check records that material moved
 * and who is now responsible for looking again. And it never rewrites a
 * status in place without leaving a trace: every transition is appended to
 * `revalidation_task_events`, so "who closed this and why" cannot be edited
 * away.
 */
export class RevalidationTaskRepository {
  constructor(private readonly database: Database) {}

  /**
   * Opens a task for one version of one source.
   *
   * The caller is expected to check `findCurrentByTrigger` first: the unique
   * index makes a second insert for the same trigger hash fail, which is the
   * database refusing to hold two reminders for the same piece of work.
   */
  async insertTask(input: {
    task: NewRevalidationTask;
  }): Promise<RevalidationTask> {
    const now = new Date().toISOString();
    const [row] = await this.database
      .insert(revalidationTasks)
      .values({
        id: input.task.id,
        sessionId: input.task.sessionId,
        sourceId: input.task.sourceId,
        sourceTitle: input.task.sourceTitle,
        triggerContentHash: input.task.triggerContentHash,
        previousSnapshotId: input.task.previousSnapshotId,
        currentSnapshotId: input.task.currentSnapshotId,
        affectedEvidenceIds: input.task.affectedEvidenceIds,
        affectedClaimIds: input.task.affectedClaimIds,
        reason: input.task.reason,
        status: "open",
        createdAt: now,
        updatedAt: now
      })
      .returning();
    const task = mapRevalidationTask(row!);
    await this.appendEvent({
      taskId: task.id,
      sessionId: task.sessionId,
      fromStatus: null,
      toStatus: "open",
      note: task.reason,
      actor: "source-monitoring"
    });
    return task;
  }

  /**
   * The task already open for one version of one source, if any.
   *
   * This is the deduplication read: the same trigger hash resolving to an
   * existing row is what stops a repeated check from opening a second
   * reminder for work that is already on someone's list.
   */
  async findCurrentByTrigger(
    sessionId: string,
    sourceId: string,
    triggerContentHash: string
  ): Promise<RevalidationTask | null> {
    const [row] = await this.database
      .select()
      .from(revalidationTasks)
      .where(
        and(
          eq(revalidationTasks.sessionId, sessionId),
          eq(revalidationTasks.sourceId, sourceId),
          eq(revalidationTasks.triggerContentHash, triggerContentHash)
        )
      )
      .limit(1);
    return row ? mapRevalidationTask(row) : null;
  }

  /** Read scoped to the session: another session's task does not exist here. */
  async getTask(sessionId: string, taskId: string): Promise<RevalidationTask> {
    const [row] = await this.database
      .select()
      .from(revalidationTasks)
      .where(
        and(
          eq(revalidationTasks.sessionId, sessionId),
          eq(revalidationTasks.id, taskId)
        )
      )
      .limit(1);
    if (!row) throw new RevalidationTaskNotFoundError(taskId);
    return mapRevalidationTask(row);
  }

  /** Every task in a session, newest first; `status` narrows it when given. */
  async listTasks(
    sessionId: string,
    options: { status?: RevalidationTaskStatus | undefined } = {},
    executor: ReadExecutor = this.database
  ): Promise<RevalidationTask[]> {
    const filters = [eq(revalidationTasks.sessionId, sessionId)];
    if (options.status) {
      filters.push(eq(revalidationTasks.status, options.status));
    }
    const rows = await executor
      .select()
      .from(revalidationTasks)
      .where(and(...filters))
      .orderBy(desc(revalidationTasks.createdAt));
    return rows.map(mapRevalidationTask);
  }

  /** Every recorded transition of one task, newest first. */
  async listTaskHistory(
    sessionId: string,
    taskId: string
  ): Promise<RevalidationTaskEvent[]> {
    await this.getTask(sessionId, taskId);
    const rows = await this.database
      .select()
      .from(revalidationTaskEvents)
      .where(
        and(
          eq(revalidationTaskEvents.sessionId, sessionId),
          eq(revalidationTaskEvents.taskId, taskId)
        )
      )
      .orderBy(desc(revalidationTaskEvents.createdAt));
    return rows.map(mapRevalidationTaskEvent);
  }

  /**
   * Moves a task to a new status and appends the transition.
   *
   * The closure fields are written by the database rules, not by the caller's
   * good intentions: `resolved` / `dismissed` require a note and an actor,
   * and an open status must not carry a closure it never had. The service
   * supplies both, so the CHECK constraints are a backstop rather than the
   * only thing standing between a task and an anonymous closure.
   */
  async transitionTask(input: {
    sessionId: string;
    taskId: string;
    status: RevalidationTaskStatus;
    actor: string;
    note?: string | undefined;
  }): Promise<RevalidationTask> {
    const current = await this.getTask(input.sessionId, input.taskId);
    const now = new Date().toISOString();
    const closing =
      input.status === "resolved" || input.status === "dismissed";
    const note = input.note?.trim() ? input.note.trim() : null;
    if (closing && (note === null || note.length === 0)) {
      throw new Error(
        "Closing a revalidation task requires a reason (resolutionNote)."
      );
    }

    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(revalidationTasks)
        .set({
          status: input.status,
          updatedAt: now,
          resolvedAt: closing ? (current.resolvedAt ?? now) : null,
          resolvedBy: closing ? input.actor : null,
          resolutionNote: closing ? note : null
        })
        .where(
          and(
            eq(revalidationTasks.sessionId, input.sessionId),
            eq(revalidationTasks.id, input.taskId)
          )
        )
        .returning();
      if (!row) throw new RevalidationTaskNotFoundError(input.taskId);

      await transaction.insert(revalidationTaskEvents).values({
        id: newId(),
        taskId: current.id,
        sessionId: input.sessionId,
        fromStatus: current.status,
        toStatus: input.status,
        note,
        actor: input.actor,
        createdAt: now
      });

      return mapRevalidationTask(row);
    });
  }

  /** Open and in-review tasks in a session, for the workspace badge. */
  async countUnresolved(sessionId: string): Promise<number> {
    const rows = await this.database
      .select({ id: revalidationTasks.id })
      .from(revalidationTasks)
      .where(
        and(
          eq(revalidationTasks.sessionId, sessionId),
          ne(revalidationTasks.status, "resolved"),
          ne(revalidationTasks.status, "dismissed")
        )
      );
    return rows.length;
  }

  private async appendEvent(input: {
    taskId: string;
    sessionId: string;
    fromStatus: RevalidationTaskStatus | null;
    toStatus: RevalidationTaskStatus;
    note: string | null;
    actor: string;
  }): Promise<void> {
    await this.database.insert(revalidationTaskEvents).values({
      id: newId(),
      taskId: input.taskId,
      sessionId: input.sessionId,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      note: input.note,
      actor: input.actor,
      createdAt: new Date().toISOString()
    });
  }
}
