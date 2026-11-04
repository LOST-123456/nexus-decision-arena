import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import {
  IdSchema,
  resolvePageLimit,
  type CursorPage,
  type PageRequest
} from "@nexus/shared";
import type { Database } from "../client";
import { conflicts, decisionSessions, projects } from "../schema";

/**
 * The session list, one page at a time.
 *
 * Sessions are ordered by `(updated_at, id)` — a composite key, because
 * `updated_at` is not unique: two researches created by one script share a
 * timestamp, and a cursor on a non-unique column either repeats a row or skips
 * one at the page boundary.
 *
 * The timestamp half of the cursor is the database's own epoch **microseconds**,
 * not a JavaScript `Date`. The driver parses `timestamptz` into a `Date`, which
 * keeps milliseconds; a millisecond-rounded cursor silently drops every row
 * that shares the cursor's millisecond. Microseconds travel as a string so
 * nothing is lost to float precision on the way back in.
 *
 * This lives beside the repository rather than inside it only because the
 * repository file was temporarily read-only in this working copy; the two
 * `listSummaries*` methods it supersedes should be removed once that file is
 * writable again (see the delivery report, "待清理").
 */

export type SessionSummaryRecord = {
  id: string;
  projectId: string;
  projectName: string;
  phase: typeof decisionSessions.$inferSelect.phase;
  operationalStatus: typeof decisionSessions.$inferSelect.operationalStatus;
  currentConclusion: string | null;
  conflictCount: number;
  createdAt: string;
  updatedAt: string;
};

/**
 * The sort key, read out of the database rather than out of the driver.
 *
 * `timestamptz` arrives in JavaScript as a `Date`, which holds milliseconds —
 * a cursor rounded to the millisecond drops every row that shares that
 * millisecond with the page boundary. Asking Postgres for the epoch in
 * microseconds keeps the precision the column actually stores, and it arrives
 * as a string because that is how the driver hands back `bigint`.
 */
const CURSOR_MICROS = sql<string>`(extract(epoch from ${decisionSessions.updatedAt}) * 1000000)::bigint`;

const CURSOR_SEPARATOR = "|";

export function encodeSessionCursor(micros: string, id: string): string {
  return `${micros}${CURSOR_SEPARATOR}${id}`;
}

/**
 * `null` means "not a cursor this endpoint issued". The route turns that into
 * a 400 rather than quietly serving the first page — a caller that thinks it
 * is paging and is actually re-reading page one has no way to notice.
 */
export function parseSessionCursor(
  raw: unknown
): { micros: string; id: string } | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(CURSOR_SEPARATOR);
  if (parts.length !== 2) return null;
  const [micros, id] = parts;
  if (micros === undefined || id === undefined) return null;
  if (!/^\d+$/.test(micros)) return null;
  if (!IdSchema.safeParse(id).success) return null;
  return { micros, id };
}

/**
 * @param sessionIds `undefined` means "no restriction"; an empty array means
 *                   "this caller may read nothing" and returns at once, because
 *                   `IN ()` is not valid SQL and an empty result is an answer.
 */
export async function listSessionPage(
  database: Database,
  page: PageRequest,
  sessionIds?: readonly string[]
): Promise<CursorPage<SessionSummaryRecord>> {
  if (sessionIds !== undefined && sessionIds.length === 0) {
    return { items: [], nextCursor: null, hasNextPage: false };
  }

  const limit = resolvePageLimit(page.limit);
  const after =
    page.after === null || page.after === undefined
      ? null
      : parseSessionCursor(String(page.after));
  if (page.after !== null && page.after !== undefined && after === null) {
    throw new InvalidSessionCursorError();
  }

  const rows = await database
    .select({
      id: decisionSessions.id,
      projectId: projects.id,
      projectName: projects.name,
      phase: decisionSessions.phase,
      operationalStatus: decisionSessions.operationalStatus,
      currentConclusion: decisionSessions.currentConclusion,
      createdAt: decisionSessions.createdAt,
      updatedAt: decisionSessions.updatedAt,
      cursorMicros: CURSOR_MICROS
    })
    .from(decisionSessions)
    .innerJoin(projects, eq(decisionSessions.projectId, projects.id))
    .where(
      and(
        // A JS array is never expanded into parameters by the `sql` template,
        // so the id list has to go through `inArray`.
        sessionIds === undefined ? undefined : inArray(decisionSessions.id, [...sessionIds]),
        after
          ? sql`(${CURSOR_MICROS}, ${decisionSessions.id}) < (${after.micros}::bigint, ${after.id}::uuid)`
          : undefined
      )
    )
    // Matches the tuple order above: epoch microseconds rise with the
    // timestamp, so the two orderings cannot disagree.
    .orderBy(desc(decisionSessions.updatedAt), desc(decisionSessions.id))
    // One extra row is the cheapest way to answer "is there another page".
    .limit(limit + 1);

  const hasNextPage = rows.length > limit;
  const kept = hasNextPage ? rows.slice(0, limit) : rows;

  // Conflicts are counted for the returned rows only: grouping the whole
  // conflicts table on every page load was work nobody asked for.
  const pageIds = kept.map((row) => row.id);
  const counts =
    pageIds.length === 0
      ? []
      : await database
          .select({ sessionId: conflicts.sessionId, total: count(conflicts.id) })
          .from(conflicts)
          .where(inArray(conflicts.sessionId, pageIds))
          .groupBy(conflicts.sessionId);
  const bySession = new Map(counts.map((row) => [row.sessionId, Number(row.total)]));

  const items: SessionSummaryRecord[] = kept.map((row) => ({
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

  const last = kept[kept.length - 1];
  return {
    items,
    hasNextPage,
    nextCursor:
      hasNextPage && last ? encodeSessionCursor(last.cursorMicros, last.id) : null
  };
}

export class InvalidSessionCursorError extends Error {
  constructor() {
    super("Session cursor is not one this endpoint issued");
    this.name = "InvalidSessionCursorError";
  }
}
