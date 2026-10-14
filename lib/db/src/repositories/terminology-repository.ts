import { and, asc, eq } from "drizzle-orm";
import { type ExecutionEvent, newId, type TerminologyEntry } from "@nexus/shared";
import type { Database } from "../client";
import { terminology } from "../schema";
import { appendEvent, type AppendEventInput, type ReadExecutor } from "./append-event";
import { parseTerminology } from "./domain-mapper";

export type UpsertTerminologyInput = {
  sessionId: string;
  sourceTerm: string;
  suggestedTranslation?: string | null | undefined;
  confirmedTranslation?: string | null | undefined;
  language: string;
  context?: string | null | undefined;
  reviewedBy?: string | null | undefined;
  event: AppendEventInput;
};

/**
 * A session-scoped terminology glossary.
 *
 * Deliberately light and session-bound: one source term maps to a suggested
 * and/or a user-confirmed translation. We do NOT collapse similar terms into a
 * single business concept — the same word may need different translations in
 * different contexts, and the glossary records them per (session, source term)
 * without inferring equivalence.
 *
 * This is an upsert on `(session_id, source_term)`: re-registering the same term
 * updates its suggestion/confirmation rather than forking a second row. It
 * writes nothing outside `terminology` and never touches evidence or verdicts.
 */
export class TerminologyRepository {
  constructor(private readonly database: Database) {}

  async upsertTerminology(
    input: UpsertTerminologyInput
  ): Promise<{ entry: TerminologyEntry; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(terminology)
        .where(
          and(
            eq(terminology.sessionId, input.sessionId),
            eq(terminology.sourceTerm, input.sourceTerm)
          )
        )
        .limit(1);

      const confirmed = input.confirmedTranslation ?? null;
      const reviewedAt = confirmed ? new Date().toISOString() : null;
      const reviewedBy = confirmed ? (input.reviewedBy ?? null) : null;

      if (existing) {
        await transaction
          .update(terminology)
          .set({
            ...(input.suggestedTranslation !== undefined
              ? { suggestedTranslation: input.suggestedTranslation ?? null }
              : {}),
            ...(input.confirmedTranslation !== undefined
              ? { confirmedTranslation: confirmed }
              : {}),
            ...(input.context !== undefined ? { context: input.context ?? null } : {}),
            reviewedAt,
            reviewedBy,
            updatedAt: new Date().toISOString()
          })
          .where(eq(terminology.id, existing.id));
        const [row] = await transaction
          .select()
          .from(terminology)
          .where(eq(terminology.id, existing.id));
        const event = await appendEvent(transaction, input.sessionId, input.event);
        return { entry: parseTerminology([row!])[0]!, event };
      }

      const entryId = newId();
      await transaction.insert(terminology).values({
        id: entryId,
        sessionId: input.sessionId,
        sourceTerm: input.sourceTerm,
        suggestedTranslation: input.suggestedTranslation ?? null,
        confirmedTranslation: confirmed,
        language: input.language,
        context: input.context ?? null,
        reviewedAt,
        reviewedBy,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      const [row] = await transaction
        .select()
        .from(terminology)
        .where(eq(terminology.id, entryId));
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { entry: parseTerminology([row!])[0]!, event };
    });
  }

  async listTerminology(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<TerminologyEntry[]> {
    const rows = await executor
      .select()
      .from(terminology)
      .where(eq(terminology.sessionId, sessionId))
      .orderBy(asc(terminology.sourceTerm));
    return parseTerminology(rows);
  }
}
