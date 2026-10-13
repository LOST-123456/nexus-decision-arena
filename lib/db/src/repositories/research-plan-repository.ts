import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ResearchPlanItemSchema, type ExecutionEvent, type ResearchPlanItem } from "@nexus/shared";
import type { Database } from "../client";
import { claims, researchPlanItems } from "../schema";
import {
  appendEvent,
  type AppendEventInput,
  type DbExecutor,
  type ReadExecutor
} from "./append-event";
import { iso } from "./domain-mapper";

export class ResearchPlanItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Research plan item not found: ${itemId}`);
    this.name = "ResearchPlanItemNotFoundError";
  }
}

export class ResearchPlanClaimNotFoundError extends Error {
  constructor(claimIds: readonly string[]) {
    super(`Claim(s) not part of this research task: ${claimIds.join(", ")}`);
    this.name = "ResearchPlanClaimNotFoundError";
  }
}

/**
 * Thrown when the gap already has a current item. Carries the existing item so
 * the caller can return it instead of manufacturing a duplicate.
 */
export class ResearchPlanGapAlreadyPlannedError extends Error {
  constructor(
    gapId: string,
    readonly existing: ResearchPlanItem
  ) {
    super(`Gap already has a research plan item: ${gapId}`);
    this.name = "ResearchPlanGapAlreadyPlannedError";
  }
}

/**
 * A plan item about to be stored. The server fills in the lifecycle columns.
 */
export type NewResearchPlanItem = Omit<
  ResearchPlanItem,
  "supersedesId" | "isCurrent" | "createdAt" | "updatedAt"
>;

export type AddPlanItemInput = {
  sessionId: string;
  item: NewResearchPlanItem;
  /** Required for a genuine add; omitted when the add turns out to be a repeat. */
  event: AppendEventInput;
};

export type ReplacePlanItemInput = {
  sessionId: string;
  itemId: string;
  item: NewResearchPlanItem;
  event: AppendEventInput;
};

function mapPlanItem(row: typeof researchPlanItems.$inferSelect): ResearchPlanItem {
  // `timestamptz` reads back as Postgres text (`2026-10-11 03:25:47.123+00`),
  // which zod's `datetime()` rejects — normalize through the shared `iso()` mapper.
  return ResearchPlanItemSchema.parse({
    ...row,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

/**
 * The only writer of research plan rows.
 *
 * Every transition is a **new row**. The previous row keeps its status, its
 * outcome, its author and its timestamp and only loses the `is_current`
 * pointer, so "what did we believe last week and who said it" stays answerable
 * after any number of revisions.
 *
 * Deliberately absent: nothing here writes `sources`, `evidence`,
 * `evidence.verification_status` or any verdict. Recording that material was
 * found is not the same as recording that it was verified, and this repository
 * is not the place where that line gets blurred.
 */
export class ResearchPlanRepository {
  constructor(private readonly database: Database) {}

  /**
   * Adds a gap to the plan.
   *
   * Adding the same gap twice is not an error and not a second task: the
   * second call returns the item that is already there, without emitting a
   * second event, so the audit trail cannot be made to look like two people
   * started the same work.
   */
  async addPlanItem(
    input: AddPlanItemInput
  ): Promise<{ item: ResearchPlanItem; event: ExecutionEvent | null; alreadyPlanned: boolean }> {
    return this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(researchPlanItems)
        .where(
          and(
            eq(researchPlanItems.sessionId, input.sessionId),
            eq(researchPlanItems.gapId, input.item.gapId),
            eq(researchPlanItems.isCurrent, true)
          )
        )
        .limit(1);
      if (existing) {
        return {
          item: mapPlanItem(existing),
          event: null,
          alreadyPlanned: true
        };
      }

      await assertClaimsInSession(transaction, input.sessionId, [
        input.item.claimId
      ]);

      const now = new Date().toISOString();
      await transaction.insert(researchPlanItems).values({
        ...input.item,
        supersedesId: null,
        isCurrent: true,
        createdAt: now,
        updatedAt: now
      });

      const [row] = await transaction
        .select()
        .from(researchPlanItems)
        .where(eq(researchPlanItems.id, input.item.id));
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { item: mapPlanItem(row!), event, alreadyPlanned: false };
    });
  }

  async listCurrentPlanItems(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<ResearchPlanItem[]> {
    const rows = await executor
      .select()
      .from(researchPlanItems)
      .where(
        and(
          eq(researchPlanItems.sessionId, sessionId),
          eq(researchPlanItems.isCurrent, true)
        )
      )
      // Priority 1 first, then oldest: the default order a researcher reads.
      .orderBy(asc(researchPlanItems.priority), asc(researchPlanItems.createdAt));
    return rows.map(mapPlanItem);
  }

  /** Everything ever recorded for one gap, newest first, including superseded. */
  async listPlanItemHistory(
    sessionId: string,
    gapId: string
  ): Promise<ResearchPlanItem[]> {
    const rows = await this.database
      .select()
      .from(researchPlanItems)
      .where(
        and(
          eq(researchPlanItems.sessionId, sessionId),
          eq(researchPlanItems.gapId, gapId)
        )
      )
      .orderBy(desc(researchPlanItems.createdAt));
    return rows.map(mapPlanItem);
  }

  async getPlanItem(
    sessionId: string,
    itemId: string
  ): Promise<ResearchPlanItem> {
    const [row] = await this.database
      .select()
      .from(researchPlanItems)
      .where(
        and(
          eq(researchPlanItems.sessionId, sessionId),
          eq(researchPlanItems.id, itemId),
          eq(researchPlanItems.isCurrent, true)
        )
      )
      .limit(1);
    if (!row) throw new ResearchPlanItemNotFoundError(itemId);
    return mapPlanItem(row);
  }

  /**
   * Records a transition by superseding the current row.
   *
   * The new row carries the full next state, so a transition is not a patch on
   * a mutable record but a fresh statement that says what the state now is and
   * who said so.
   */
  async replacePlanItem(
    input: ReplacePlanItemInput
  ): Promise<{ item: ResearchPlanItem; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const [previous] = await transaction
        .select()
        .from(researchPlanItems)
        .where(
          and(
            eq(researchPlanItems.sessionId, input.sessionId),
            eq(researchPlanItems.id, input.itemId),
            eq(researchPlanItems.isCurrent, true)
          )
        )
        .limit(1);
      if (!previous) {
        throw new ResearchPlanItemNotFoundError(input.itemId);
      }

      await transaction
        .update(researchPlanItems)
        .set({ isCurrent: false })
        .where(eq(researchPlanItems.id, previous.id));

      const now = new Date().toISOString();
      await transaction.insert(researchPlanItems).values({
        ...input.item,
        supersedesId: previous.id,
        isCurrent: true,
        createdAt: now,
        updatedAt: now
      });

      const [row] = await transaction
        .select()
        .from(researchPlanItems)
        .where(eq(researchPlanItems.id, input.item.id));
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { item: mapPlanItem(row!), event };
    });
  }
}

async function assertClaimsInSession(
  transaction: DbExecutor,
  sessionId: string,
  claimIds: readonly string[]
): Promise<void> {
  const unique = [...new Set(claimIds)];
  const rows = await transaction
    .select({ id: claims.id })
    .from(claims)
    .where(and(eq(claims.sessionId, sessionId), inArray(claims.id, unique)));
  const found = new Set(rows.map((row) => row.id));
  const missing = unique.filter((claimId) => !found.has(claimId));
  if (missing.length > 0) {
    throw new ResearchPlanClaimNotFoundError(missing);
  }
}
