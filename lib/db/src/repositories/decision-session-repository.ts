import { and, eq, sql } from "drizzle-orm";
import {
  newId,
  type ExecutionEvent,
  type HumanDecision,
  type SessionView
} from "@nexus/shared";
import type { Database } from "../client";
import {
  conflicts,
  agentRoles,
  challenges,
  claims,
  decisionSessions,
  evidence,
  executionEvents,
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

export class SupplementRoundLimitError extends Error {
  constructor() {
    super("Only one supplement analysis round is allowed");
    this.name = "SupplementRoundLimitError";
  }
}

export class DecisionSessionRepository {
  constructor(private readonly database: Database) {}

  async createWithProject(project: ProjectInput, session: SessionInput) {
    return this.database.transaction(async (transaction) => {
      await transaction.insert(projects).values({
        id: session.projectId,
        name: project.name,
        input: project,
        locale: session.locale
      });
      const [created] = await transaction
        .insert(decisionSessions)
        .values(session)
        .returning();
      return created ?? null;
    });
  }

  async create(input: SessionInput) {
    const [created] = await this.database
      .insert(decisionSessions)
      .values(input)
      .returning();
    return created ?? null;
  }

  async getById(id: string) {
    const [session] = await this.database
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
        currentSession.supplementRound >= 1
      ) {
        throw new SupplementRoundLimitError();
      }

      const [eligibleConflict] = await transaction
        .select({ id: conflicts.id })
        .from(conflicts)
        .where(
          and(
            eq(conflicts.id, input.decision.conflictId),
            eq(conflicts.sessionId, input.decision.sessionId),
            eq(conflicts.humanDecisionRequired, true)
          )
        )
        .limit(1);

      if (!eligibleConflict) {
        throw new HumanDecisionConflictNotEligibleError();
      }

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

      const eventPayload =
        input.event.payload !== null &&
        typeof input.event.payload === "object" &&
        !Array.isArray(input.event.payload)
          ? {
              ...(input.event.payload as Record<string, unknown>),
              humanDecision: persistedDecision
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
