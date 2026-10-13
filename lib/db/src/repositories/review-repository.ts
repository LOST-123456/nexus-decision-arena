import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  type AgentRun,
  type AgentRunStatus,
  type ClaimReview,
  type ExecutionEvent
} from "@nexus/shared";
import type { Database } from "../client";
import {
  agentRuns,
  claimReviews,
  claims,
  evidence,
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
    ...(targetClaimId ? { targetClaimId } : {}),
    ...(row.error ? { error: row.error } : {}),
    startedAt: new Date(row.startedAt).toISOString(),
    ...(row.completedAt
      ? { completedAt: new Date(row.completedAt).toISOString() }
      : {})
  };
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
        completedAt: new Date().toISOString()
      })
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.status, "running")));
  }

  async failCrossReviewRun(input: {
    runId: string;
    error: string;
  }): Promise<void> {
    await this.database
      .update(agentRuns)
      .set({
        status: "failed",
        error: input.error,
        completedAt: new Date().toISOString()
      })
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.status, "running")));
  }
}
