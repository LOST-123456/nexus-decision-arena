import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import type {
  ExecutionEvent,
  SourceProfileOverride,
  SourceRelation
} from "@nexus/shared";
import type { Database } from "../client";
import { sourceProfileOverrides, sourceRelations, sources } from "../schema";
import { appendEvent, type AppendEventInput, type DbExecutor, type ReadExecutor } from "./append-event";
import {
  parseSourceProfileOverrides,
  parseSourceRelations
} from "./domain-mapper";

export class SourceRelationNotFoundError extends Error {
  constructor(relationId: string) {
    super(`Source relation not found: ${relationId}`);
    this.name = "SourceRelationNotFoundError";
  }
}

export class SourceProfileOverrideNotFoundError extends Error {
  constructor(overrideId: string) {
    super(`Source profile override not found: ${overrideId}`);
    this.name = "SourceProfileOverrideNotFoundError";
  }
}

export class SourcePairInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourcePairInvalidError";
  }
}

/** A relation a person is asserting, before the server fills in the rest. */
export type NewSourceRelation = Omit<
  SourceRelation,
  "supersedesId" | "isCurrent" | "createdAt"
>;

/** A profile override a person is asserting. */
export type NewSourceProfileOverride = Omit<
  SourceProfileOverride,
  "supersedesId" | "isCurrent" | "createdAt"
>;

export type RecordRelationInput = {
  sessionId: string;
  relation: NewSourceRelation;
  event: AppendEventInput;
};

export type RecordProfileOverrideInput = {
  sessionId: string;
  override: NewSourceProfileOverride;
  event: AppendEventInput;
};

/**
 * Human statements about source independence.
 *
 * The only writer here is a person. Automated detection is computed from the
 * source rows on every read and is deliberately not persisted, so this table
 * holds exactly the part a machine cannot derive: a ruling about a pair, or an
 * override of one source's provenance kind.
 *
 * The rule both tables share: **a statement is never edited**. A correction
 * inserts a new row pointing back at the one it replaced; the earlier row keeps
 * its content, author and timestamp and only loses its `is_current` pointer.
 *
 * What is deliberately absent: nothing here writes `sources`, `evidence` or
 * `evidence.verification_status`. This repository can describe how sources
 * relate; it cannot promote one, and it cannot change a verdict.
 */
export class SourceIndependenceRepository {
  constructor(private readonly database: Database) {}

  /* ---------------- relations (a pair of sources) ---------------- */

  /**
   * Stores a person's ruling about a pair of sources.
   *
   * The pair is normalized (`from < to`) before writing, so asserting (b, a)
   * after (a, b) replaces the same row rather than adding a contradictory
   * second one. The partial unique index enforces this at the database level as
   * well, so a bug in the caller cannot create two current statements.
   */
  async recordRelation(
    input: RecordRelationInput
  ): Promise<{ relation: SourceRelation; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const { fromSourceId, toSourceId } = input.relation;
      if (fromSourceId === toSourceId) {
        throw new SourcePairInvalidError(
          "A source cannot be related to itself."
        );
      }
      await assertSourcesInSession(transaction, input.sessionId, [
        fromSourceId,
        toSourceId
      ]);

      // The statement is about the pair, so a reversed assertion replaces the
      // same statement. The row keeps the direction it was given, which is what
      // makes a reprint or quote chain readable.
      const [previous] = await transaction
        .select()
        .from(sourceRelations)
        .where(
          and(
            eq(sourceRelations.sessionId, input.sessionId),
            eq(sourceRelations.isCurrent, true),
            or(
              and(
                eq(sourceRelations.fromSourceId, fromSourceId),
                eq(sourceRelations.toSourceId, toSourceId)
              ),
              and(
                eq(sourceRelations.fromSourceId, toSourceId),
                eq(sourceRelations.toSourceId, fromSourceId)
              )
            )
          )
        )
        .limit(1);
      if (previous) {
        await transaction
          .update(sourceRelations)
          .set({ isCurrent: false })
          .where(eq(sourceRelations.id, previous.id));
      }

      await transaction.insert(sourceRelations).values({
        id: input.relation.id,
        sessionId: input.sessionId,
        fromSourceId,
        toSourceId,
        kind: input.relation.kind,
        basis: input.relation.basis,
        ...(input.relation.similarity === null ||
        input.relation.similarity === undefined
          ? {}
          : { similarity: String(input.relation.similarity) }),
        reason: input.relation.reason,
        origin: input.relation.origin,
        actor: input.relation.actor,
        ...(previous ? { supersedesId: previous.id } : {}),
        isCurrent: true,
        createdAt: new Date().toISOString()
      });

      const [row] = await transaction
        .select()
        .from(sourceRelations)
        .where(eq(sourceRelations.id, input.relation.id));
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { relation: parseSourceRelations([row!])[0]!, event };
    });
  }

  /** Every current human statement in a session. */
  async listCurrentRelations(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<SourceRelation[]> {
    const rows = await executor
      .select()
      .from(sourceRelations)
      .where(
        and(
          eq(sourceRelations.sessionId, sessionId),
          eq(sourceRelations.isCurrent, true)
        )
      )
      .orderBy(asc(sourceRelations.createdAt));
    return parseSourceRelations(rows);
  }

  /** Current statements touching one source, on either side of the pair. */
  async listRelationsForSource(
    sessionId: string,
    sourceId: string
  ): Promise<SourceRelation[]> {
    const rows = await this.database
      .select()
      .from(sourceRelations)
      .where(
        and(
          eq(sourceRelations.sessionId, sessionId),
          eq(sourceRelations.isCurrent, true),
          or(
            eq(sourceRelations.fromSourceId, sourceId),
            eq(sourceRelations.toSourceId, sourceId)
          )
        )
      )
      .orderBy(asc(sourceRelations.createdAt));
    return parseSourceRelations(rows);
  }

  /** Everything ever stated about a pair, oldest first, including superseded. */
  async listRelationHistory(
    sessionId: string,
    firstSourceId: string,
    secondSourceId: string
  ): Promise<SourceRelation[]> {
    const rows = await this.database
      .select()
      .from(sourceRelations)
      .where(
        and(
          eq(sourceRelations.sessionId, sessionId),
          or(
            and(
              eq(sourceRelations.fromSourceId, firstSourceId),
              eq(sourceRelations.toSourceId, secondSourceId)
            ),
            and(
              eq(sourceRelations.fromSourceId, secondSourceId),
              eq(sourceRelations.toSourceId, firstSourceId)
            )
          )
        )
      )
      .orderBy(asc(sourceRelations.createdAt));
    return parseSourceRelations(rows);
  }

  /* ---------------- profile overrides (one source) ---------------- */

  async recordProfileOverride(
    input: RecordProfileOverrideInput
  ): Promise<{ override: SourceProfileOverride; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      await assertSourcesInSession(transaction, input.sessionId, [
        input.override.sourceId
      ]);

      const [previous] = await transaction
        .select()
        .from(sourceProfileOverrides)
        .where(
          and(
            eq(sourceProfileOverrides.sessionId, input.sessionId),
            eq(sourceProfileOverrides.sourceId, input.override.sourceId),
            eq(sourceProfileOverrides.isCurrent, true)
          )
        )
        .limit(1);
      if (previous) {
        await transaction
          .update(sourceProfileOverrides)
          .set({ isCurrent: false })
          .where(eq(sourceProfileOverrides.id, previous.id));
      }

      await transaction.insert(sourceProfileOverrides).values({
        id: input.override.id,
        sessionId: input.sessionId,
        sourceId: input.override.sourceId,
        provenanceKind: input.override.provenanceKind,
        note: input.override.note,
        origin: input.override.origin,
        actor: input.override.actor,
        ...(previous ? { supersedesId: previous.id } : {}),
        isCurrent: true,
        createdAt: new Date().toISOString()
      });

      const [row] = await transaction
        .select()
        .from(sourceProfileOverrides)
        .where(eq(sourceProfileOverrides.id, input.override.id));
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { override: parseSourceProfileOverrides([row!])[0]!, event };
    });
  }

  async listCurrentProfileOverrides(
    sessionId: string
  ): Promise<SourceProfileOverride[]> {
    const rows = await this.database
      .select()
      .from(sourceProfileOverrides)
      .where(
        and(
          eq(sourceProfileOverrides.sessionId, sessionId),
          eq(sourceProfileOverrides.isCurrent, true)
        )
      )
      .orderBy(asc(sourceProfileOverrides.createdAt));
    return parseSourceProfileOverrides(rows);
  }

  async listProfileOverrideHistory(
    sessionId: string,
    sourceId: string
  ): Promise<SourceProfileOverride[]> {
    const rows = await this.database
      .select()
      .from(sourceProfileOverrides)
      .where(
        and(
          eq(sourceProfileOverrides.sessionId, sessionId),
          eq(sourceProfileOverrides.sourceId, sourceId)
        )
      )
      .orderBy(desc(sourceProfileOverrides.createdAt));
    return parseSourceProfileOverrides(rows);
  }
}

async function assertSourcesInSession(
  transaction: DbExecutor,
  sessionId: string,
  sourceIds: readonly string[]
): Promise<void> {
  const unique = [...new Set(sourceIds)];
  const rows = await transaction
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.sessionId, sessionId), inArray(sources.id, unique)));
  const found = new Set(rows.map((row) => row.id));
  const missing = unique.filter((sourceId) => !found.has(sourceId));
  if (missing.length > 0) {
    throw new SourcePairInvalidError(
      `Source(s) not part of this research: ${missing.join(", ")}`
    );
  }
}
