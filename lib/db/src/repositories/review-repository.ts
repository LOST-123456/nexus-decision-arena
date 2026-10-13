import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  type AgentRun,
  type AgentRunEvent,
  type AgentRunStatus,
  type AgentRunTokenUsage,
  type AgentRunView,
  type ClaimReview,
  type ExecutionEvent
} from "@nexus/shared";
import type { Database } from "../client";
import {
  agentRuns,
  agentRoles,
  claimReviews,
  claims,
  evidence,
  executionEvents,
  sources
} from "../schema";
import {
  appendEvent,
  type AppendEventInput,
  type ReadExecutor
} from "./append-event";
import { parseClaimReviews } from "./domain-mapper";

export class ReviewClaimNotFoundError extends Error {
  constructor(claimId: string) {
    super(`Claim not found in this session: ${claimId}`);
    this.name = "ReviewClaimNotFoundError";
  }
}

/** A review may only cite material that belongs to the same research task. */
export class ReviewReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewReferenceError";
  }
}

type AgentRunRow = typeof agentRuns.$inferSelect;

/**
 * Reads the run's purpose/target back out of its `input` payload, which is
 * where cross-review runs record what they were aimed at. Keeping this here
 * means `agent_runs` needs no extra columns to support the new flow.
 */
function toAgentRun(row: AgentRunRow): AgentRun {
  const input =
    row.input !== null && typeof row.input === "object" && !Array.isArray(row.input)
      ? (row.input as Record<string, unknown>)
      : {};
  const purpose = input.kind === "cross_review" ? "cross_review" : "analysis";
  const targetClaimId =
    typeof input.targetClaimId === "string" ? input.targetClaimId : undefined;

  return {
    id: row.id,
    sessionId: row.sessionId,
    roleId: row.roleId,
    promptVersionId: row.promptVersionId,
    status: row.status as AgentRunStatus,
    purpose,
    taskType: row.taskType ?? "unknown",
    ...(targetClaimId ? { targetClaimId } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.errorCode ? { errorCode: row.errorCode as AgentRun["errorCode"] } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    attempt: row.attempt ?? 1,
    ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
    tokenUsage: (row.tokenUsage as AgentRunTokenUsage | null) ?? null,
    createdAt: new Date(row.createdAt).toISOString(),
    startedAt: new Date(row.startedAt).toISOString(),
    ...(row.completedAt
      ? { completedAt: new Date(row.completedAt).toISOString() }
      : {}),
    ...(typeof row.durationMs === "number" ? { durationMs: row.durationMs } : {})
  };
}

/** The operations-center view: the run plus its role's human-readable name. */
function toAgentRunView(row: AgentRunRow, roleName: string): AgentRunView {
  return { ...toAgentRun(row), roleName };
}

/**
 * Cross-examination run records and human fact-check rulings.
 *
 * Reviews are append-only: `createReview` only ever inserts. Nothing here
 * updates or deletes a ruling, so a later decision can never erase the
 * reasoning behind an earlier one.
 */
export class ReviewRepository {
  constructor(private readonly database: Database) {}

  async createReview(input: {
    review: ClaimReview;
    event: AppendEventInput;
  }): Promise<{ review: ClaimReview; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const [claim] = await transaction
        .select({ id: claims.id })
        .from(claims)
        .where(
          and(
            eq(claims.id, input.review.claimId),
            eq(claims.sessionId, input.review.sessionId)
          )
        )
        .limit(1);
      if (!claim) {
        throw new ReviewClaimNotFoundError(input.review.claimId);
      }

      // evidence_ids / source_ids are jsonb, so they carry no foreign key. The
      // membership check is what stops a ruling from citing another research
      // task's material, or ids that do not exist at all.
      if (input.review.evidenceIds.length > 0) {
        const found = await transaction
          .select({ id: evidence.id })
          .from(evidence)
          .where(
            and(
              eq(evidence.sessionId, input.review.sessionId),
              inArray(evidence.id, [...input.review.evidenceIds])
            )
          );
        if (found.length !== new Set(input.review.evidenceIds).size) {
          throw new ReviewReferenceError(
            "Every cited evidence item must belong to this research task"
          );
        }
      }

      if (input.review.sourceIds.length > 0) {
        const found = await transaction
          .select({ id: sources.id })
          .from(sources)
          .where(
            and(
              eq(sources.sessionId, input.review.sessionId),
              inArray(sources.id, [...input.review.sourceIds])
            )
          );
        if (found.length !== new Set(input.review.sourceIds).size) {
          throw new ReviewReferenceError(
            "Every cited source must belong to this research task"
          );
        }
      }

      const [created] = await transaction
        .insert(claimReviews)
        .values({
          id: input.review.id,
          sessionId: input.review.sessionId,
          claimId: input.review.claimId,
          outcome: input.review.outcome,
          rationale: input.review.rationale,
          reviewer: input.review.reviewer,
          evidenceIds: [...input.review.evidenceIds],
          sourceIds: [...input.review.sourceIds],
          verdictStatusAtReview: input.review.verdictStatusAtReview,
          verdictConfidenceAtReview: input.review.verdictConfidenceAtReview,
          createdAt: input.review.createdAt
        })
        .returning();

      const event = await appendEvent(
        transaction,
        input.review.sessionId,
        input.event
      );

      return { review: parseClaimReviews([created!])[0]!, event };
    });
  }

  async listReviews(
    sessionId: string,
    filter: { claimId?: string } = {},
    executor: ReadExecutor = this.database
  ): Promise<ClaimReview[]> {
    const rows = await executor
      .select()
      .from(claimReviews)
      .where(
        filter.claimId
          ? and(
              eq(claimReviews.sessionId, sessionId),
              eq(claimReviews.claimId, filter.claimId)
            )
          : eq(claimReviews.sessionId, sessionId)
      )
      .orderBy(asc(claimReviews.createdAt));
    return parseClaimReviews(rows);
  }

  /** Full ruling history for a claim, newest first. */
  async listReviewHistory(
    sessionId: string,
    claimId: string
  ): Promise<ClaimReview[]> {
    const rows = await this.listReviews(sessionId, { claimId });
    return [...rows].reverse();
  }

  async listAgentRuns(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<AgentRun[]> {
    const rows = await executor
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, sessionId))
      .orderBy(asc(agentRuns.startedAt));
    return rows.map(toAgentRun);
  }

  /**
   * The operations-center list: the same rows, newest first, joined with the
   * role name so the dashboard never has to resolve `roleId` client-side.
   */
  async listAgentRunsDetailed(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<AgentRunView[]> {
    const rows = await executor
      .select({
        run: agentRuns,
        roleName: agentRoles.name
      })
      .from(agentRuns)
      .leftJoin(agentRoles, eq(agentRoles.id, agentRuns.roleId))
      .where(eq(agentRuns.sessionId, sessionId))
      .orderBy(desc(agentRuns.createdAt));
    return rows.map((row) =>
      toAgentRunView(row.run, row.roleName ?? "未知角色")
    );
  }

  /** One run by id, scoped to the session, or null. Never crosses sessions. */
  async getAgentRunById(
    sessionId: string,
    runId: string,
    executor: ReadExecutor = this.database
  ): Promise<AgentRunView | null> {
    const rows = await executor
      .select({
        run: agentRuns,
        roleName: agentRoles.name
      })
      .from(agentRuns)
      .leftJoin(agentRoles, eq(agentRoles.id, agentRuns.roleId))
      .where(and(eq(agentRuns.sessionId, sessionId), eq(agentRuns.id, runId)))
      .limit(1);
    if (rows.length === 0) return null;
    return toAgentRunView(rows[0]!.run, rows[0]!.roleName ?? "未知角色");
  }

  /**
   * A run's event timeline, read from the session's execution log by the run's
   * correlation id. Cross-review emits `AGENT_RUN_STARTED` / `_COMPLETED` /
   * `_FAILED` with the run id as correlation id, so this is the same ledger the
   * rest of the app uses — no second timeline is minted here.
   */
  async listAgentRunEvents(
    sessionId: string,
    runId: string,
    executor: ReadExecutor = this.database
  ): Promise<AgentRunEvent[]> {
    const rows = await executor
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.sessionId, sessionId),
          eq(executionEvents.correlationId, runId)
        )
      )
      .orderBy(asc(executionEvents.sequence));
    return rows.map((row) => ({
      sequence: row.sequence,
      type: row.type,
      occurredAt: row.occurredAt,
      payload: row.payload
    }));
  }

  /**
   * Marks a run cancelled. The guard is the where-clause: only a `queued` or
   * `running` run can be cancelled, so a terminal run (or a missing one) leaves
   * the row untouched and the caller sees `null`. `cancelled_by_user` is the
   * only failure code this writes, and `completedAt` is set so the duration is
   * honest about how long the run was alive before cancellation.
   */
  async cancelAgentRun(
    sessionId: string,
    runId: string
  ): Promise<AgentRunView | null> {
    const now = new Date().toISOString();
    const [row] = await this.database
      .update(agentRuns)
      .set({
        status: "cancelled",
        errorCode: "cancelled_by_user",
        completedAt: now,
        durationMs: sql`EXTRACT(EPOCH FROM (${now}::timestamptz - ${agentRuns.startedAt}))::integer * 1000`
      })
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          eq(agentRuns.id, runId),
          inArray(agentRuns.status, ["queued", "running"])
        )
      )
      .returning();
    if (!row) return null;
    const role = await this.database
      .select({ name: agentRoles.name })
      .from(agentRoles)
      .where(eq(agentRoles.id, row.roleId))
      .limit(1);
    return toAgentRunView(row, role[0]?.name ?? "未知角色");
  }

  /** Records retry metadata on a freshly started run (attempt + parent). */
  async setRunRetryMeta(
    runId: string,
    meta: { attempt: number; parentRunId: string }
  ): Promise<void> {
    await this.database
      .update(agentRuns)
      .set({ attempt: meta.attempt, parentRunId: meta.parentRunId })
      .where(eq(agentRuns.id, runId));
  }

  /**
   * How many runs already target this claim, for the retry cap. Counts every
   * run whose `input` names this claim as its cross-review target.
   */
  async countRunsForTarget(
    sessionId: string,
    targetClaimId: string,
    executor: ReadExecutor = this.database
  ): Promise<number> {
    const rows = await executor
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          sql`${agentRuns.input} ->> 'kind' = 'cross_review'`,
          sql`${agentRuns.input} ->> 'targetClaimId' = ${targetClaimId}`
        )
      );
    return rows.length;
  }

  /**
   * A cross-review run that is still going for this claim. Two reviewers
   * pressing "run" at once must not spawn two competing examinations.
   */
  async findRunningCrossReview(
    sessionId: string,
    claimId: string
  ): Promise<AgentRun | null> {
    const rows = await this.database
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.sessionId, sessionId),
          eq(agentRuns.status, "running"),
          sql`${agentRuns.input} ->> 'kind' = 'cross_review'`,
          sql`${agentRuns.input} ->> 'targetClaimId' = ${claimId}`
        )
      )
      .limit(1);
    return rows.length > 0 ? toAgentRun(rows[0]!) : null;
  }

  async startCrossReviewRun(input: {
    id: string;
    sessionId: string;
    roleId: string;
    promptVersionId: string;
    targetClaimId: string;
    requestedBy: string;
    correlationId: string;
    /** Retries carry the attempt number and the run they re-attempted. */
    attempt?: number;
    parentRunId?: string;
    /** Optional failure category recorded up front (e.g. for retries). */
    errorCode?: AgentRun["errorCode"];
    provider?: string;
    model?: string;
  }): Promise<AgentRun> {
    const [row] = await this.database
      .insert(agentRuns)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        roleId: input.roleId,
        promptVersionId: input.promptVersionId,
        status: "running",
        correlationId: input.correlationId,
        input: {
          kind: "cross_review",
          targetClaimId: input.targetClaimId,
          requestedBy: input.requestedBy
        },
        taskType: "cross_review",
        attempt: input.attempt ?? 1,
        ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        startedAt: new Date().toISOString()
      })
      .returning();
    return toAgentRun(row!);
  }

  async completeCrossReviewRun(input: {
    runId: string;
    output: unknown;
  }): Promise<void> {
    await this.database
      .update(agentRuns)
      .set({
        status: "completed",
        output: input.output,
        completedAt: new Date().toISOString(),
        durationMs: sql`EXTRACT(EPOCH FROM (now() - ${agentRuns.startedAt}))::integer * 1000`
      })
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.status, "running")));
  }

  async failCrossReviewRun(input: {
    runId: string;
    error: string;
    errorCode?: AgentRun["errorCode"];
  }): Promise<void> {
    await this.database
      .update(agentRuns)
      .set({
        status: "failed",
        error: input.error,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        completedAt: new Date().toISOString(),
        durationMs: sql`EXTRACT(EPOCH FROM (now() - ${agentRuns.startedAt}))::integer * 1000`
      })
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.status, "running")));
  }
}
