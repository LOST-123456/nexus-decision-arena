import { eq, sql } from "drizzle-orm";
import { newId, type ExecutionEvent } from "@nexus/shared";
import type { Database } from "../client";
import { decisionSessions, executionEvents } from "../schema";

export type AppendEventInput = Pick<
  ExecutionEvent,
  "correlationId" | "type" | "payload"
> &
  Partial<Pick<ExecutionEvent, "traceId">>;

/** Everything `appendEvent` needs from a connection or an open transaction. */
export type DbExecutor = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/**
 * The minimal read contract a repository method needs: `select`.
 *
 * Both the database itself and an open transaction satisfy it, which is what
 * lets a read be scoped to one caller's transaction when consistency matters
 * (a saved report version must not mix material from two moments) and default
 * to the plain connection otherwise. Deliberately narrow: a read that needs
 * to write does not take this type.
 */
export type ReadExecutor = Pick<DbExecutor, "select">;

/**
 * Writes an execution event inside an existing transaction, taking the next
 * sequence number from the session row so ordering stays consistent with the
 * state change it describes.
 */
export async function appendEvent(
  transaction: DbExecutor,
  sessionId: string,
  input: AppendEventInput
): Promise<ExecutionEvent> {
  const [sequenceRow] = await transaction
    .update(decisionSessions)
    .set({
      nextEventSequence: sql`${decisionSessions.nextEventSequence} + 1`,
      updatedAt: new Date().toISOString()
    })
    .where(eq(decisionSessions.id, sessionId))
    .returning({ sequence: decisionSessions.nextEventSequence });

  if (!sequenceRow) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const event: ExecutionEvent = {
    id: newId(),
    sessionId,
    sequence: sequenceRow.sequence - 1,
    correlationId: input.correlationId,
    ...(input.traceId ? { traceId: input.traceId } : {}),
    type: input.type,
    payload: input.payload,
    occurredAt: new Date().toISOString()
  };

  await transaction.insert(executionEvents).values({
    id: event.id,
    sessionId: event.sessionId,
    sequence: event.sequence,
    correlationId: event.correlationId,
    traceId: event.traceId,
    type: event.type,
    payload: event.payload,
    occurredAt: event.occurredAt
  });

  return event;
}
