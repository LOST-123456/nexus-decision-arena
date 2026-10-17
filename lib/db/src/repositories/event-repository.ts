import { and, asc, eq, gt, sql } from "drizzle-orm";
import { newId, type ExecutionEvent } from "@nexus/shared";
import type { Database } from "../client";
import type { ReadExecutor } from "./append-event";
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

  /**
   * Execution events after a sequence, oldest first.
   *
   * `limit` is optional: the snapshot writer and the SSE replay pass nothing and
   * get the whole tail (they must reconstruct full history), while the polled
   * `GET /events` endpoint passes a clamped limit to bound memory and latency
   * on large sessions. Passing a limit never changes correctness — it only
   * caps how many rows one call returns.
   */
  async listAfter(
    sessionId: string,
    sequence: number,
    executor: ReadExecutor = this.database,
    options: { limit?: number } = {}
  ) {
    const query = executor
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.sessionId, sessionId),
          gt(executionEvents.sequence, sequence)
        )
      )
      .orderBy(asc(executionEvents.sequence));
    // `limit` is optional. The snapshot writer and the SSE replay pass nothing
    // and get the whole tail (they must reconstruct full history), while the
    // polled `GET /events` endpoint passes a clamped limit to bound memory and
    // latency on large sessions. Passing a limit never changes correctness — it
    // only caps how many rows one call returns. The two branches return the same
    // awaitable builder, so callers (which `await` for rows) are unaffected.
    if (typeof options.limit === "number" && options.limit > 0) {
      return query.limit(options.limit);
    }
    return query;
  }
}
