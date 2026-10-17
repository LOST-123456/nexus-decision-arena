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

/** The transaction handle drizzle hands to `database.transaction`. */
type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/** Everything a cross-review run row needs at insert time. */
export type StartCrossReviewRunInput = {
  id: string;
  sessionId: string;
  roleId: string;
  promptVersionId: string;
  targetClaimId: string;
  requestedBy: string;
  correlationId: string;
  /**
   * Retries carry the attempt number and the run they re-attempted. Both are
   * decided by `startRetryGeneration`; a run opened directly is attempt 1 with
   * no parent.
   */
  attempt?: number;
  parentRunId?: string;
  /** Optional failure category recorded up front (e.g. for retries). */
  errorCode?: AgentRun["errorCode"];
  provider?: string;
  model?: string;
};

/**
 * Why a retry generation did or did not open. A discriminated result rather
 * than exceptions: "the budget is spent" and "someone already retried this" are
 * answers about a real chain, and the caller has to tell them apart to say
 * anything useful to the operator.
 */
export type RetryGenerationResult =
  | { outcome: "started"; attempt: number; runs: AgentRun[] }
  | {
      outcome: "already_retried";
      deepestAttempt: number;
      childRunId: string | null;
    }
  | { outcome: "limit_reached"; attempt: number; ceiling: number }
  | { outcome: "not_found" };

function toInsertRow(input: StartCrossReviewRunInput) {
  return {
    id: input.id,
    sessionId: input.sessionId,
    roleId: input.roleId,
    promptVersionId: input.promptVersionId,
    status: "running" as const,
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
  };
}

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

  /**
   * Opens one cross-review generation: every challenger's run row, written in
   * a single transaction.
   *
   * Inserting them together rather than one by one is not a micro-optimisation.
   * A generation is either fully opened or not opened at all — a half-written
   * generation would leave runs that no executor will ever settle, and the
   * operator would see "运行中" rows for work nobody is doing.
   */
  async startCrossReviewRuns(
    inputs: ReadonlyArray<StartCrossReviewRunInput>
  ): Promise<AgentRun[]> {
    if (inputs.length === 0) return [];
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .insert(agentRuns)
        .values(inputs.map((input) => toInsertRow(input)))
        .returning();
      return rows.map((row) => toAgentRun(row));
    });
  }

  /** One run on its own. Kept for callers that open a single row. */
  async startCrossReviewRun(input: StartCrossReviewRunInput): Promise<AgentRun> {
    const [run] = await this.startCrossReviewRuns([input]);
    return run!;
  }

  /**
   * Opens the next generation of a retry chain, with the budget and the
   * parent pointer decided **inside** one transaction.
   *
   * The order matters, and it is the whole point of this method:
   *
   * 1. The chain's root row is locked `FOR UPDATE`. Every retry of this lineage
   *    therefore serialises against every other retry of it — including ones
   *    aimed at a sibling run of the same generation.
   * 2. Under that lock the deepest attempt in the chain is read, and the new
   *    attempt is that plus one. A request can no longer base its budget on
   *    "the run I was looking at", which is what allowed the same failed run to
   *    be retried repeatedly and produce siblings that all claimed attempt 2.
   * 3. A run that is not the deepest is refused: the chain grows one
   *    generation at a time, so `parent_run_id` always names a real, immediate
   *    ancestor and no generation is ever skipped or duplicated.
   * 4. The rows are inserted with `attempt` and `parent_run_id` already set.
   *    They are never written after the fact, so a crash mid-execution cannot
   *    leave a run whose lineage is unknown.
   *
   * Nothing here calls a provider: the transaction ends before any execution
   * starts, so no row lock is held across a network call.
   */
  async startRetryGeneration(input: {
    sessionId: string;
    /** The run the operator chose to retry. Becomes the children's parent. */
    parentRunId: string;
    /** Highest attempt this chain may reach. */
    ceiling: number;
    runs: ReadonlyArray<Omit<StartCrossReviewRunInput, "attempt" | "parentRunId">>;
  }): Promise<RetryGenerationResult> {
    return this.database.transaction(async (transaction) => {
      const rootId = await this.findLineageRoot(
        transaction,
        input.sessionId,
        input.parentRunId
      );
      if (!rootId) return { outcome: "not_found" };

      // Serialises every retry of this chain. The lock is on the root, not on
      // the chosen parent, because two operators may retry two different
      // challenger runs of the same generation.
      const [root] = await transaction
        .select({ id: agentRuns.id, attempt: agentRuns.attempt })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, input.sessionId),
            eq(agentRuns.id, rootId)
          )
        )
        .for("update");
      if (!root) return { outcome: "not_found" };

      const [parent] = await transaction
        .select({ attempt: agentRuns.attempt })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, input.sessionId),
            eq(agentRuns.id, input.parentRunId)
          )
        )
        .limit(1);
      if (!parent) return { outcome: "not_found" };

      const deepestAttempt = await this.deepestAttempt(
        transaction,
        input.sessionId,
        root.id,
        root.attempt ?? 1
      );

      const parentAttempt = parent.attempt ?? 1;
      if (parentAttempt < deepestAttempt) {
        // A sibling of this generation already opened the next one. Returning
        // the child makes the refusal actionable instead of a dead end.
        const [child] = await transaction
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.sessionId, input.sessionId),
              eq(agentRuns.parentRunId, input.parentRunId)
            )
          )
          .limit(1);
        return {
          outcome: "already_retried",
          deepestAttempt,
          childRunId: child?.id ?? null
        };
      }

      const attempt = deepestAttempt + 1;
      if (attempt > input.ceiling) {
        return { outcome: "limit_reached", attempt, ceiling: input.ceiling };
      }

      const rows = await transaction
        .insert(agentRuns)
        .values(
          input.runs.map((run) =>
            toInsertRow({ ...run, attempt, parentRunId: input.parentRunId })
          )
        )
        .returning();

      return { outcome: "started", attempt, runs: rows.map(toAgentRun) };
    });
  }

  /**
   * Walks up to the run that started this chain, or null when the run is not
   * in this session. Bounded rather than recursive: a chain that deep is not a
   * retry chain any more, and an unbounded walk is how a cycle becomes a hang.
   */
  private async findLineageRoot(
    transaction: DatabaseTransaction,
    sessionId: string,
    runId: string,
    maxHops = 64
  ): Promise<string | null> {
    let current: string | null = runId;
    for (let hop = 0; hop < maxHops; hop += 1) {
      if (!current) return null;
      const [row] = await transaction
        .select({ id: agentRuns.id, parentRunId: agentRuns.parentRunId })
        .from(agentRuns)
        .where(
          and(eq(agentRuns.sessionId, sessionId), eq(agentRuns.id, current))
        )
        .limit(1);
      if (!row) return hop === 0 ? null : current;
      if (!row.parentRunId) return row.id;
      current = row.parentRunId;
    }
    return current;
  }

  /**
   * The deepest attempt reachable from `rootId` by following `parent_run_id`
   * downwards, level by level. Bounded breadth-first rather than one raw
   * recursive query so the walk is portable and cannot loop on bad data.
   */
  private async deepestAttempt(
    transaction: DatabaseTransaction,
    sessionId: string,
    rootId: string,
    rootAttempt: number,
    maxDepth = 64
  ): Promise<number> {
    let deepest = rootAttempt;
    let level: string[] = [rootId];
    const seen = new Set<string>(level);
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const rows = await transaction
        .select({ id: agentRuns.id, attempt: agentRuns.attempt })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.sessionId, sessionId),
            inArray(agentRuns.parentRunId, level)
          )
        );
      const next: string[] = [];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        next.push(row.id);
        deepest = Math.max(deepest, row.attempt ?? 1);
      }
      if (next.length === 0) break;
      level = next;
    }
    return deepest;
  }

  /**
   * Marks a running cross-review run completed. Returns whether the row
   * actually moved: `false` means it was no longer `running` (cancelled or
   * already settled), and the caller must not report success for it.
   */
  async completeCrossReviewRun(input: {
    runId: string;
    output: unknown;
  }): Promise<boolean> {
    const rows = await this.database
      .update(agentRuns)
      .set({
        status: "completed",
        output: input.output,
        completedAt: new Date().toISOString(),
        durationMs: sql`EXTRACT(EPOCH FROM (now() - ${agentRuns.startedAt}))::integer * 1000`
      })
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.status, "running")))
      .returning({ id: agentRuns.id });
    return rows.length > 0;
  }

  /** Same conditional transition for failure; `false` means it was cancelled first. */
  async failCrossReviewRun(input: {
    runId: string;
    error: string;
    errorCode?: AgentRun["errorCode"];
  }): Promise<boolean> {
    const rows = await this.database
      .update(agentRuns)
      .set({
        status: "failed",
        error: input.error,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        completedAt: new Date().toISOString(),
        durationMs: sql`EXTRACT(EPOCH FROM (now() - ${agentRuns.startedAt}))::integer * 1000`
      })
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.status, "running")))
      .returning({ id: agentRuns.id });
    return rows.length > 0;
  }

  /**
   * Gives up on a run that was opened but never settled.
   *
   * A process that dies between "the run row exists" and "the executor settles
   * it" leaves a `running` row nobody will ever finish. It cannot be marked
   * completed — we do not know whether any work happened — and it must not stay
   * `running` forever, because a retry chain whose tip never ends is a chain
   * that can never be retried again.
   *
   * So it is marked failed with an honest reason, and only when it is genuinely
   * old: the cutoff is passed in, the transition is conditional, and `false`
   * means the run settled on its own in the meantime (which is the good case).
   */
  async abandonStaleRun(input: {
    sessionId: string;
    runId: string;
    /** Only a run that started before this instant is abandoned. */
    startedBefore: string;
    error: string;
    errorCode?: AgentRun["errorCode"];
  }): Promise<boolean> {
    const rows = await this.database
      .update(agentRuns)
      .set({
        status: "failed",
        error: input.error,
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        completedAt: new Date().toISOString(),
        durationMs: sql`EXTRACT(EPOCH FROM (now() - ${agentRuns.startedAt}))::integer * 1000`
      })
      .where(
        and(
          eq(agentRuns.sessionId, input.sessionId),
          eq(agentRuns.id, input.runId),
          eq(agentRuns.status, "running"),
          sql`${agentRuns.startedAt} < ${input.startedBefore}::timestamptz`
        )
      )
      .returning({ id: agentRuns.id });
    return rows.length > 0;
  }

  /**
   * The run's durable status, read on its own. Used by the executor to decide
   * whether to keep going; correctness of writes never rests on this read —
   * that is `writeWhileRunActive`'s job in the arena repository.
   */
  async getRunStatus(runId: string): Promise<AgentRun["status"] | null> {
    const rows = await this.database
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    const row = rows[0];
    return row ? (row.status as AgentRun["status"]) : null;
  }
}
