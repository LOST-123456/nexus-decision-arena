import { and, desc, eq, gte, or } from "drizzle-orm";
import type { SourceMonitorStatus } from "@nexus/shared";
import type { Database } from "../client";
import { sourceChecks } from "../schema";
import { iso } from "./domain-mapper";

/**
 * One stored check, as it comes back from the table.
 *
 * Kept as a plain record rather than a shared-schema type on purpose: a check
 * is the audit trail of monitoring, not a domain entity anything else reasons
 * about. The outcome it feeds into is the domain type.
 */
export type SourceCheckRecord = {
  id: string;
  sessionId: string;
  sourceId: string;
  status: SourceMonitorStatus;
  reasonCode: string | null;
  message: string;
  previousSnapshotId: string | null;
  currentSnapshotId: string | null;
  previousContentHash: string | null;
  currentContentHash: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  newVersionStored: boolean;
  checkedBy: string;
  checkedAt: string;
  createdAt: string;
};

export type NewSourceCheck = {
  id: string;
  sessionId: string;
  sourceId: string;
  status: SourceMonitorStatus;
  reasonCode?: string | null | undefined;
  message: string;
  previousSnapshotId?: string | null | undefined;
  currentSnapshotId?: string | null | undefined;
  previousContentHash?: string | null | undefined;
  currentContentHash?: string | null | undefined;
  httpStatus?: number | null | undefined;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  newVersionStored?: boolean | undefined;
  checkedBy: string;
};

function mapSourceCheck(
  row: typeof sourceChecks.$inferSelect
): SourceCheckRecord {
  // Same normalization as every other repository: Postgres returns text or
  // Date for `timestamptz`, and the consumers want ISO strings.
  return {
    id: row.id,
    sessionId: row.sessionId,
    sourceId: row.sourceId,
    status: row.status as SourceMonitorStatus,
    reasonCode: row.reasonCode ?? null,
    message: row.message,
    previousSnapshotId: row.previousSnapshotId ?? null,
    currentSnapshotId: row.currentSnapshotId ?? null,
    previousContentHash: row.previousContentHash ?? null,
    currentContentHash: row.currentContentHash ?? null,
    httpStatus: row.httpStatus ?? null,
    errorCode: row.errorCode ?? null,
    errorMessage: row.errorMessage ?? null,
    newVersionStored: row.newVersionStored,
    checkedBy: row.checkedBy,
    checkedAt: iso(row.checkedAt),
    createdAt: iso(row.createdAt)
  };
}

/**
 * The audit trail of source monitoring.
 *
 * Every check — including the ones that failed — leaves a row, which is what
 * makes "we tried and could not reach it" distinguishable from "we never
 * looked". The two counters exist so the service can enforce a rate limit and
 * a failure-retry budget without re-reading whole histories.
 */
export class SourceCheckRepository {
  constructor(private readonly database: Database) {}

  async insertCheck(input: {
    record: NewSourceCheck;
  }): Promise<SourceCheckRecord> {
    const [row] = await this.database
      .insert(sourceChecks)
      .values({
        id: input.record.id,
        sessionId: input.record.sessionId,
        sourceId: input.record.sourceId,
        status: input.record.status,
        reasonCode: input.record.reasonCode ?? null,
        message: input.record.message,
        previousSnapshotId: input.record.previousSnapshotId ?? null,
        currentSnapshotId: input.record.currentSnapshotId ?? null,
        previousContentHash: input.record.previousContentHash ?? null,
        currentContentHash: input.record.currentContentHash ?? null,
        httpStatus: input.record.httpStatus ?? null,
        errorCode: input.record.errorCode ?? null,
        errorMessage: input.record.errorMessage ?? null,
        newVersionStored: input.record.newVersionStored ?? false,
        checkedBy: input.record.checkedBy
      })
      .returning();
    return mapSourceCheck(row!);
  }

  /** Newest checks first; `limit` bounds how far back the UI reads. */
  async listChecks(
    sessionId: string,
    sourceId: string,
    options: { limit?: number | undefined } = {}
  ): Promise<SourceCheckRecord[]> {
    let query = this.database
      .select()
      .from(sourceChecks)
      .where(
        and(
          eq(sourceChecks.sessionId, sessionId),
          eq(sourceChecks.sourceId, sourceId)
        )
      )
      .orderBy(desc(sourceChecks.checkedAt))
      .$dynamic();
    if (options.limit) {
      query = query.limit(options.limit);
    }
    const rows = await query;
    return rows.map(mapSourceCheck);
  }

  /** The most recent check of one source, or null when never checked. */
  async lastCheck(
    sessionId: string,
    sourceId: string
  ): Promise<SourceCheckRecord | null> {
    const [row] = await this.database
      .select()
      .from(sourceChecks)
      .where(
        and(
          eq(sourceChecks.sessionId, sessionId),
          eq(sourceChecks.sourceId, sourceId)
        )
      )
      .orderBy(desc(sourceChecks.checkedAt))
      .limit(1);
    return row ? mapSourceCheck(row) : null;
  }

  /**
   * How many checks of this source happened since `since`.
   *
   * The rate limit reads this: monitoring must not turn into a probe, so the
   * service compares the count against the configured budget before it
   * reaches out again.
   */
  async countRecentChecks(
    sessionId: string,
    sourceId: string,
    since: string
  ): Promise<number> {
    const rows = await this.database
      .select({ id: sourceChecks.id })
      .from(sourceChecks)
      .where(
        and(
          eq(sourceChecks.sessionId, sessionId),
          eq(sourceChecks.sourceId, sourceId),
          gte(sourceChecks.checkedAt, since)
        )
      );
    return rows.length;
  }

  /**
   * How many checks of this source did not establish anything since `since`.
   *
   * The failure-retry budget reads this, and it counts both ways a check can
   * come back empty — `failed` (the check itself could not run) and
   * `unavailable` (the source could not be read) — because a source that keeps
   * timing out must stop being retried exactly like one that keeps erroring.
   * Successes are not counted here, so a source that keeps answering is never
   * throttled by this budget.
   */
  async countUnsuccessfulSince(
    sessionId: string,
    sourceId: string,
    since: string
  ): Promise<number> {
    const rows = await this.database
      .select({ id: sourceChecks.id })
      .from(sourceChecks)
      .where(
        and(
          eq(sourceChecks.sessionId, sessionId),
          eq(sourceChecks.sourceId, sourceId),
          gte(sourceChecks.checkedAt, since),
          or(
            eq(sourceChecks.status, "failed"),
            eq(sourceChecks.status, "unavailable")
          )
        )
      );
    return rows.length;
  }

  /**
   * How many checks the whole session ran since `since`.
   *
   * The per-session quota reads this: monitoring must not be able to turn into
   * a scan of the session's entire source list, whatever any single source's
   * own budget says.
   */
  async countSessionRecentChecks(
    sessionId: string,
    since: string
  ): Promise<number> {
    const rows = await this.database
      .select({ id: sourceChecks.id })
      .from(sourceChecks)
      .where(
        and(
          eq(sourceChecks.sessionId, sessionId),
          gte(sourceChecks.checkedAt, since)
        )
      );
    return rows.length;
  }
}
