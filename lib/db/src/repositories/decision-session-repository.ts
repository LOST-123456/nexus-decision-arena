import { eq, sql } from "drizzle-orm";
import {
  newId,
  type ExecutionEvent,
  type HumanDecision
} from "@nexus/shared";
import type { Database } from "../client";
import {
  decisionSessions,
  executionEvents,
  humanDecisions,
  projects
} from "../schema";

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

  async recordHumanDecision(input: {
    decision: HumanDecision;
    transition: HumanDecisionTransition;
    event: HumanDecisionEventInput;
  }) {
    return this.database.transaction(async (transaction) => {
      const [session] = await transaction
        .update(decisionSessions)
        .set({
          phase: input.transition.phase,
          operationalStatus: input.transition.operationalStatus,
          currentConclusion: input.transition.conclusion,
          nextEventSequence: sql`${decisionSessions.nextEventSequence} + 1`,
          updatedAt: new Date().toISOString()
        })
        .where(eq(decisionSessions.id, input.decision.sessionId))
        .returning();

      if (!session) {
        throw new Error(`Session not found: ${input.decision.sessionId}`);
      }

      await transaction.insert(humanDecisions).values({
        id: input.decision.id,
        sessionId: input.decision.sessionId,
        conflictId: input.decision.conflictId,
        action: input.decision.action,
        rationale: input.decision.rationale,
        affectedClaimIds: input.decision.affectedClaimIds,
        affectedAgentRoleIds: input.decision.affectedAgentRoleIds,
        previousConclusion: input.decision.previousConclusion,
        newConclusion: input.decision.newConclusion,
        operatorId: input.decision.operatorId,
        createdAt: input.decision.createdAt
      });

      const event: ExecutionEvent = {
        id: newId(),
        sessionId: input.decision.sessionId,
        sequence: session.nextEventSequence - 1,
        correlationId: input.event.correlationId,
        ...(input.event.traceId ? { traceId: input.event.traceId } : {}),
        type: input.event.type,
        payload: input.event.payload,
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
        decision: input.decision,
        event
      };
    });
  }
}
