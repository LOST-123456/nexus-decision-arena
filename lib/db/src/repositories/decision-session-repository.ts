import { and, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  ConflictStatusSchema,
  decisionWritebackPlan,
  DEFAULT_PAGE_LIMIT,
  IdSchema,
  MAX_PAGE_LIMIT,
  newId,
  type ConflictStatus,
  type ExecutionEvent,
  type HumanDecision,
  type SessionView
} from "@nexus/shared";
import type { Database } from "../client";
import type { ReadExecutor } from "./append-event";
import {
  conflicts,
  agentRuns,
  agentRoles,
  challenges,
  claims,
  decisionSessions,
  evidence,
  executionEvents,
  finalReports,
  humanDecisions,
  projects
} from "../schema";
import {
  parseAgentRoles,
  parseChallenges,
  parseClaims,
  parseConflicts,
  parseEvidence,
  parseHumanDecisions
} from "./domain-mapper";
import { evidenceCoversAnyClaim } from "./evidence-link";

type ProjectInput = {
  name: string;
  summary: string;
  targetUsers: string;
  businessModel: string;
  expectedData: string;
};

type SessionInput = {
  id: string;
  projectId: string;
  locale: string;
  phase: string;
  operationalStatus: string;
  currentConclusion: string | null;
  /** The question this research set out to answer. */
  researchQuestion?: string | null;
  /**
   * Who this research belongs to, taken from the server-side login identity.
   * Null for a session created without an authenticated user (or before
   * ownership existed): such a session is a legacy workspace session, and the
   * library restricts grant administration on it to the `owner` role rather
   * than inventing an owner after the fact.
   */
  ownerUserId?: string | null;
};

type HumanDecisionTransition = {
  phase: string;
  operationalStatus: string;
  conclusion: string;
};

type HumanDecisionEventInput = Pick<
  ExecutionEvent,
  "correlationId" | "type" | "payload"
> &
  Partial<Pick<ExecutionEvent, "traceId" | "promptVersionId">>;

export class SessionNotInHumanReviewError extends Error {
  constructor() {
    super("Session is not awaiting human review");
    this.name = "SessionNotInHumanReviewError";
  }
}

export class HumanDecisionConflictNotEligibleError extends Error {
  constructor() {
    super("Conflict is not eligible for a human decision");
    this.name = "HumanDecisionConflictNotEligibleError";
  }
}

/**
 * 补充分析最多跑几轮。
 *
 * 上一版写死成 1 轮，理由是"防止无限重跑烧钱"。代价是一个真实项目永远只能
 * 补一次材料——而一个项目很少一次评审就能定论：第一轮质询说"你拿不出证据"，
 * 补上证据之后理应再被问一遍。上限保留，但从 1 提到 3，并允许部署方用
 * `MAX_SUPPLEMENT_ROUNDS` 调整；调用方拿到的拒绝理由会写明还剩几轮。
 */
export function maxSupplementRounds(): number {
  const configured = Number(process.env.MAX_SUPPLEMENT_ROUNDS ?? 3);
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : 3;
}

export class SupplementRoundLimitError extends Error {
  constructor(readonly limit: number = maxSupplementRounds()) {
    super(
      `补充分析最多 ${limit} 轮，这个项目已经用完了。要再往下推进，请新开一次评审，把这一轮补到的材料一起带上。`
    );
    this.name = "SupplementRoundLimitError";
  }
}

export class DecisionSessionRepository {
  constructor(private readonly database: Database) {}

  async createWithProject(project: ProjectInput, session: SessionInput) {
    return this.database.transaction(async (transaction) => {
      await transaction
        .insert(projects)
        .values({
          id: session.projectId,
          name: project.name,
          input: project,
          locale: session.locale
        })
        .onConflictDoNothing({ target: projects.id });
      const [created] = await transaction
        .insert(decisionSessions)
        .values({
          ...session,
          ...(session.researchQuestion !== undefined
            ? { researchQuestion: session.researchQuestion }
            : {}),
          ...(session.ownerUserId !== undefined
            ? { ownerUserId: session.ownerUserId }
            : {})
        })
        .onConflictDoNothing({ target: decisionSessions.id })
        .returning();
      if (created) {
        return created;
      }

      const [existing] = await transaction
        .select()
        .from(decisionSessions)
        .where(eq(decisionSessions.id, session.id))
        .limit(1);
      return existing ?? null;
    });
  }

  async getProjectBySessionId(sessionId: string) {
    const [row] = await this.database
      .select({
        name: projects.name,
        input: projects.input,
        locale: projects.locale
      })
      .from(decisionSessions)
      .innerJoin(projects, eq(decisionSessions.projectId, projects.id))
      .where(eq(decisionSessions.id, sessionId))
      .limit(1);
    return row ?? null;
  }
  async listSummaries(limit = DEFAULT_PAGE_LIMIT) {
    return this.summarize(limit);
  }

  /**
   * The same summary shape, restricted to sessions the caller may read.
   *
   * The restriction is applied in the query, not after reading everything: a
   * workspace with ten thousand researches must not send its whole history to
   * the process only to drop the rows the caller cannot see.
   *
   * An empty list returns at once. `IN ()` is not valid SQL, and "this caller
   * may see nothing" is an answer, not an error to be discovered by the
   * database.
   */
  async listSummariesForSessions(sessionIds: readonly string[], limit = DEFAULT_PAGE_LIMIT) {
    if (sessionIds.length === 0) return [];
    return this.summarize(limit, [...sessionIds]);
  }

  private async summarize(limit: number, sessionIds?: readonly string[]) {
    // `undefined` means "no restriction": the builder skips the clause, so the
    // filtered and unfiltered shapes come from one query and cannot drift.
    const ids = sessionIds === undefined ? undefined : [...sessionIds];
    const rows = await this.database
      .select({
        id: decisionSessions.id,
        projectId: projects.id,
        projectName: projects.name,
        phase: decisionSessions.phase,
        operationalStatus: decisionSessions.operationalStatus,
        currentConclusion: decisionSessions.currentConclusion,
        createdAt: decisionSessions.createdAt,
        updatedAt: decisionSessions.updatedAt
      })
      .from(decisionSessions)
      .innerJoin(projects, eq(decisionSessions.projectId, projects.id))
      .where(ids ? inArray(decisionSessions.id, ids) : undefined)
      .orderBy(desc(decisionSessions.updatedAt))
      // Clamped to the shared page contract rather than a private number. The
      // old local cap of 100 was invisible to clients, so a caller that asked
      // for 200 got 100 and had no way to tell it had been trimmed — which is
      // how a UI ends up claiming a window it was never given.
      .limit(Math.max(1, Math.min(limit, MAX_PAGE_LIMIT)));
    const counts = await this.database
      .select({ sessionId: conflicts.sessionId, total: count(conflicts.id) })
      .from(conflicts)
      .where(ids ? inArray(conflicts.sessionId, ids) : undefined)
      .groupBy(conflicts.sessionId);
    const bySession = new Map(counts.map((row) => [row.sessionId, Number(row.total)]));
    return rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      projectName: row.projectName,
      phase: row.phase,
      operationalStatus: row.operationalStatus,
      currentConclusion: row.currentConclusion,
      conflictCount: bySession.get(row.id) ?? 0,
      createdAt: new Date(row.createdAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString()
    }));
  }

  /** Session ids recorded as belonging to one account. */
  async listSessionIdsForOwner(userId: string): Promise<string[]> {
    const rows = await this.database
      .select({ id: decisionSessions.id })
      .from(decisionSessions)
      .where(eq(decisionSessions.ownerUserId, userId));
    return rows.map((row) => row.id);
  }

  /**
   * Sessions with no recorded owner.
   *
   * They predate ownership or were created before a login existed, so nothing
   * in the data says whose they are. The library already treats them as the
   * deployment administrator's (see `mayAdministerGrants`); they are listed
   * here for that role rather than handed to every signed-in account.
   */
  async listOwnerlessSessionIds(): Promise<string[]> {
    const rows = await this.database
      .select({ id: decisionSessions.id })
      .from(decisionSessions)
      .where(sql`${decisionSessions.ownerUserId} IS NULL`);
    return rows.map((row) => row.id);
  }

  async deleteById(sessionId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const [session] = await transaction.select().from(decisionSessions).where(eq(decisionSessions.id, sessionId)).limit(1);
      if (!session) return false;
      await transaction.update(claims).set({ respondsToChallengeId: null }).where(eq(claims.sessionId, sessionId));
      await transaction.delete(finalReports).where(eq(finalReports.sessionId, sessionId));
      await transaction.delete(executionEvents).where(eq(executionEvents.sessionId, sessionId));
      await transaction.delete(humanDecisions).where(eq(humanDecisions.sessionId, sessionId));
      await transaction.delete(conflicts).where(eq(conflicts.sessionId, sessionId));
      await transaction.delete(evidence).where(eq(evidence.sessionId, sessionId));
      await transaction.delete(challenges).where(eq(challenges.sessionId, sessionId));
      await transaction.delete(claims).where(eq(claims.sessionId, sessionId));
      await transaction.delete(agentRuns).where(eq(agentRuns.sessionId, sessionId));
      await transaction.delete(decisionSessions).where(eq(decisionSessions.id, sessionId));
      await transaction.delete(projects).where(eq(projects.id, session.projectId));
      return true;
    });
  }
  async create(input: SessionInput) {
    const [created] = await this.database
      .insert(decisionSessions)
      .values(input)
      .returning();
    return created ?? null;
  }

  /**
   * Sets the question a research set out to answer.
   *
   * Only the question: the phase, the status, the conclusion and every claim
   * and verdict are left exactly as they are. Editing what a research asks is
   * not editing what it concluded, and a report that was frozen before the
   * change must keep reading the question it was frozen with.
   */
  async setResearchQuestion(
    id: string,
    researchQuestion: string
  ): Promise<{ sessionId: string; researchQuestion: string | null } | null> {
    const [updated] = await this.database
      .update(decisionSessions)
      .set({ researchQuestion, updatedAt: new Date().toISOString() })
      .where(eq(decisionSessions.id, id))
      .returning({
        sessionId: decisionSessions.id,
        researchQuestion: decisionSessions.researchQuestion
      });
    return updated ?? null;
  }

  async getById(id: string, executor: ReadExecutor = this.database) {
    const [session] = await executor
      .select()
      .from(decisionSessions)
      .where(eq(decisionSessions.id, id))
      .limit(1);
    return session ?? null;
  }

  async getView(id: string): Promise<SessionView | null> {
    const session = await this.getById(id);
    if (!session) {
      return null;
    }

    const [
      roles,
      sessionClaims,
      sessionEvidence,
      sessionChallenges,
      sessionConflicts,
      sessionDecisions
    ] = await Promise.all([
      this.database.select().from(agentRoles),
      this.database.select().from(claims).where(eq(claims.sessionId, id)),
      this.database.select().from(evidence).where(eq(evidence.sessionId, id)),
      this.database
        .select()
        .from(challenges)
        .where(eq(challenges.sessionId, id)),
      this.database
        .select()
        .from(conflicts)
        .where(eq(conflicts.sessionId, id)),
      this.database
        .select()
        .from(humanDecisions)
        .where(eq(humanDecisions.sessionId, id))
    ]);

    return {
      sessionId: session.id,
      phase: session.phase as SessionView["phase"],
      operationalStatus:
        session.operationalStatus as SessionView["operationalStatus"],
      agents: parseAgentRoles(roles),
      claims: parseClaims(sessionClaims),
      evidence: parseEvidence(sessionEvidence),
      challenges: parseChallenges(sessionChallenges),
      conflicts: parseConflicts(sessionConflicts),
      humanDecisions: parseHumanDecisions(sessionDecisions),
      currentConclusion: session.currentConclusion,
      supplementRound: session.supplementRound
    };
  }

  async recordHumanDecision(input: {
    decision: HumanDecision;
    transition: HumanDecisionTransition;
    event: HumanDecisionEventInput;
  }) {
    return this.database.transaction(async (transaction) => {
      const [existingDecision] = await transaction
        .select()
        .from(humanDecisions)
        .where(eq(humanDecisions.id, input.decision.id))
        .limit(1);
      if (existingDecision) {
        const [existingSession] = await transaction
          .select()
          .from(decisionSessions)
          .where(eq(decisionSessions.id, input.decision.sessionId))
          .limit(1);
        const [existingEvent] = await transaction
          .select()
          .from(executionEvents)
          .where(
            and(
              eq(executionEvents.sessionId, input.decision.sessionId),
              eq(executionEvents.correlationId, input.decision.id)
            )
          )
          .limit(1);
        const parsedDecision = parseHumanDecisions([existingDecision])[0];
        if (existingSession && existingEvent && parsedDecision) {
          return {
            session: existingSession,
            decision: parsedDecision,
            event: {
              id: existingEvent.id,
              sessionId: existingEvent.sessionId,
              sequence: existingEvent.sequence,
              correlationId: existingEvent.correlationId,
              ...(existingEvent.traceId
                ? { traceId: existingEvent.traceId }
                : {}),
              type: existingEvent.type as ExecutionEvent["type"],
              payload: existingEvent.payload,
              occurredAt: new Date(existingEvent.occurredAt).toISOString(),
              ...(existingEvent.promptVersionId
                ? { promptVersionId: existingEvent.promptVersionId }
                : {})
            }
          };
        }
      }

      const [currentSession] = await transaction
        .select()
        .from(decisionSessions)
        .where(eq(decisionSessions.id, input.decision.sessionId))
        .limit(1);

      if (!currentSession || currentSession.phase !== "HUMAN_REVIEW") {
        throw new SessionNotInHumanReviewError();
      }

      if (
        input.decision.action === "request_more_analysis" &&
        currentSession.supplementRound >= maxSupplementRounds()
      ) {
        throw new SupplementRoundLimitError();
      }

      const [eligibleConflict] = await transaction
        .select({
          id: conflicts.id,
          status: conflicts.status,
          claimIds: conflicts.claimIds
        })
        .from(conflicts)
        .where(
          and(
            eq(conflicts.id, input.decision.conflictId),
            eq(conflicts.sessionId, input.decision.sessionId),
            eq(conflicts.humanDecisionRequired, true),
            // A terminated conflict cannot be ruled on again; that keeps a
            // decision from silently contradicting an earlier resolution.
            ne(conflicts.status, "resolved")
          )
        )
        .limit(1);

      if (!eligibleConflict) {
        throw new HumanDecisionConflictNotEligibleError();
      }

      const conflictClaimIds = IdSchema.array().parse(
        eligibleConflict.claimIds
      );
      const [conflictClaims, conflictEvidence] =
        conflictClaimIds.length === 0
          ? [[], []]
          : await Promise.all([
              transaction
                .select()
                .from(claims)
                .where(
                  and(
                    eq(claims.sessionId, input.decision.sessionId),
                    inArray(claims.id, conflictClaimIds)
                  )
                ),
              transaction
                .select()
                .from(evidence)
                .where(
                  evidenceCoversAnyClaim(evidence.claimIds, conflictClaimIds)
                )
            ]);

      const writeback = decisionWritebackPlan({
        action: input.decision.action,
        conflict: {
          id: eligibleConflict.id,
          status: ConflictStatusSchema.parse(
            eligibleConflict.status
          ) as ConflictStatus,
          claimIds: conflictClaimIds
        },
        claims: parseClaims(conflictClaims),
        evidence: parseEvidence(conflictEvidence)
      });

      const persistedDecision: HumanDecision = {
        ...input.decision,
        previousConclusion:
          currentSession.currentConclusion ?? "No prior conclusion"
      };

      const [session] = await transaction
        .update(decisionSessions)
        .set({
          phase: input.transition.phase,
          operationalStatus: input.transition.operationalStatus,
          currentConclusion: input.transition.conclusion,
          nextEventSequence: sql`${decisionSessions.nextEventSequence} + 1`,
          ...(input.decision.action === "request_more_analysis"
            ? { supplementRound: currentSession.supplementRound + 1 }
            : {}),
          updatedAt: new Date().toISOString()
        })
        .where(
          and(
            eq(decisionSessions.id, input.decision.sessionId),
            eq(decisionSessions.phase, "HUMAN_REVIEW")
          )
        )
        .returning();

      if (!session) {
        throw new SessionNotInHumanReviewError();
      }

      await transaction.insert(humanDecisions).values({
        id: persistedDecision.id,
        sessionId: persistedDecision.sessionId,
        conflictId: persistedDecision.conflictId,
        action: persistedDecision.action,
        rationale: persistedDecision.rationale,
        affectedClaimIds: persistedDecision.affectedClaimIds,
        affectedAgentRoleIds: persistedDecision.affectedAgentRoleIds,
        previousConclusion: persistedDecision.previousConclusion,
        newConclusion: persistedDecision.newConclusion,
        operatorId: persistedDecision.operatorId,
        createdAt: persistedDecision.createdAt
      });

      const writebackAt = new Date().toISOString();

      await transaction
        .update(conflicts)
        .set({ status: writeback.conflictStatus, updatedAt: writebackAt })
        .where(
          and(
            eq(conflicts.id, writeback.conflictId),
            eq(conflicts.sessionId, input.decision.sessionId)
          )
        );

      for (const update of writeback.claimUpdates) {
        await transaction
          .update(claims)
          .set({ status: update.status, updatedAt: writebackAt })
          .where(
            and(
              eq(claims.id, update.claimId),
              eq(claims.sessionId, input.decision.sessionId)
            )
          );
      }

      const eventPayload =
        input.event.payload !== null &&
        typeof input.event.payload === "object" &&
        !Array.isArray(input.event.payload)
          ? {
              ...(input.event.payload as Record<string, unknown>),
              humanDecision: persistedDecision,
              writeback
            }
          : input.event.payload;

      const event: ExecutionEvent = {
        id: newId(),
        sessionId: persistedDecision.sessionId,
        sequence: session.nextEventSequence - 1,
        correlationId: input.event.correlationId,
        ...(input.event.traceId ? { traceId: input.event.traceId } : {}),
        type: input.event.type,
        payload: eventPayload,
        occurredAt: new Date().toISOString(),
        ...(input.event.promptVersionId
          ? { promptVersionId: input.event.promptVersionId }
          : {})
      };

      await transaction.insert(executionEvents).values({
        id: event.id,
        sessionId: event.sessionId,
        sequence: event.sequence,
        correlationId: event.correlationId,
        traceId: event.traceId,
        type: event.type,
        payload: event.payload,
        occurredAt: event.occurredAt,
        promptVersionId: event.promptVersionId
      });

      return {
        session,
        decision: persistedDecision,
        event
      };
    });
  }
}
