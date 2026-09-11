import { and, asc, eq, gt, sql } from "drizzle-orm";
import { newId, type ExecutionEvent } from "@nexus/shared";
import type { Database } from "../client";
import { decisionSessions, executionEvents } from "../schema";

type AppendEventInput = Pick<
  ExecutionEvent,
  "sessionId" | "correlationId" | "type" | "payload"
> &
  Partial<Pick<ExecutionEvent, "traceId" | "promptVersionId">>;

export class EventRepository {
  constructor(private readonly database: Database) {}

  async append(input: AppendEventInput): Promise<ExecutionEvent> {
    return this.database.transaction(async (transaction) => {
      const [sequenceRow] = await transaction
        .update(decisionSessions)
        .set({
          nextEventSequence: sql`${decisionSessions.nextEventSequence} + 1`
        })
        .where(eq(decisionSessions.id, input.sessionId))
        .returning({ sequence: decisionSessions.nextEventSequence });

      if (!sequenceRow) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }

      const event: ExecutionEvent = {
        id: newId(),
        sessionId: input.sessionId,
        sequence: sequenceRow.sequence - 1,
        correlationId: input.correlationId,
        ...(input.traceId ? { traceId: input.traceId } : {}),
        type: input.type,
        payload: input.payload,
        occurredAt: new Date().toISOString(),
        ...(input.promptVersionId
          ? { promptVersionId: input.promptVersionId }
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
      return event;
    });
  }

  async listAfter(sessionId: string, sequence: number) {
    return this.database
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.sessionId, sessionId),
          gt(executionEvents.sequence, sequence)
        )
      )
      .orderBy(asc(executionEvents.sequence));
  }
}
