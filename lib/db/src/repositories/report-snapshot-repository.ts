import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  newId,
  resolvePageLimit,
  type CursorPage,
  type ExecutionEvent,
  type PageRequest,
  type ReportClaimReference,
  type ReportEvidenceReference,
  type ReportMonitoringReference,
  type ReportReviewReference,
  type ReportSnapshotSummary,
  type ResearchReportSnapshot,
  type ReportSourceReference
} from "@nexus/shared";
import type { Database } from "../client";
import { researchReportSnapshots, sourceSnapshots } from "../schema";
import {
  appendEvent,
  type AppendEventInput,
  type DbExecutor,
  type ReadExecutor
} from "./append-event";
import { iso } from "./domain-mapper";

export class ReportSnapshotNotFoundError extends Error {
  constructor(snapshotId: string) {
    super(`Report snapshot not found: ${snapshotId}`);
    this.name = "ReportSnapshotNotFoundError";
  }
}

/**
 * Thrown when the session does not exist. A save against an unknown session
 * is a 404, not a snapshot with no session behind it.
 */
export class ReportSnapshotSessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "ReportSnapshotSessionNotFoundError";
  }
}

/** A version about to be frozen, already carrying everything it needs. */
export type NewReportSnapshot = {
  id: string;
  sessionId: string;
  version: number;
  createdBy: string;
  researchQuestion: string | null;
  reportSchemaVersion: number;
  materialsFingerprint: string;
  snapshotHash: string;
  reportPayload: unknown;
  sourceReferences: Array<Omit<ReportSourceReference, "present">>;
  evidenceReferences: ReportEvidenceReference[];
  claimReferences: ReportClaimReference[];
  reviewReferences: ReportReviewReference[];
  monitoringReferences: ReportMonitoringReference[];
  changeReason: string | null;
  idempotencyKey: string | null;
};

/**
 * The only writer of report snapshots, and the only reader of their rows.
 *
 * Two things it refuses to do are the point. It never updates a stored
 * version — there is no update method, so "history was edited" is not a
 * state this repository can be in. And it never writes to claims, evidence,
 * sources, captures or reviews: saving a version copies what those rows
 * said, it does not touch them.
 *
 * Reads are scoped by session, so a snapshot from another session answers
 * exactly as a snapshot that never existed would.
 */
export class ReportSnapshotRepository {
  constructor(private readonly database: Database) {}

  /**
   * Writes one version inside the caller's transaction.
   *
   * The caller owns the transaction on purpose: a snapshot is only honest if
   * the material it was built from, the version number it was given and the
   * audit event that records the save all land together or not at all. The
   * unique index on (session, version) is the backstop for a concurrent
   * double-save; the caller retries the whole read when it fires.
   */
  async insertSnapshot(
    transaction: DbExecutor,
    input: { snapshot: NewReportSnapshot; event: AppendEventInput }
  ): Promise<{ snapshot: ResearchReportSnapshot; event: ExecutionEvent }> {
    const now = new Date().toISOString();
    const [row] = await transaction
      .insert(researchReportSnapshots)
      .values({
        id: input.snapshot.id,
        sessionId: input.snapshot.sessionId,
        version: input.snapshot.version,
        createdBy: input.snapshot.createdBy,
        researchQuestion: input.snapshot.researchQuestion,
        reportSchemaVersion: input.snapshot.reportSchemaVersion,
        materialsFingerprint: input.snapshot.materialsFingerprint,
        snapshotHash: input.snapshot.snapshotHash,
        reportPayload: input.snapshot.reportPayload,
        sourceReferences: input.snapshot.sourceReferences,
        evidenceReferences: input.snapshot.evidenceReferences,
        claimReferences: input.snapshot.claimReferences,
        reviewReferences: input.snapshot.reviewReferences,
        monitoringReferences: input.snapshot.monitoringReferences,
        changeReason: input.snapshot.changeReason,
        idempotencyKey: input.snapshot.idempotencyKey,
        createdAt: now
      })
      .returning();

    const event = await appendEvent(
      transaction,
      input.snapshot.sessionId,
      input.event
    );

    // Hydrated inside the same transaction: the capture-existence read then
    // sees exactly what this version saw.
    return { snapshot: await this.hydrate(row!, transaction), event };
  }

  /**
   * One page of a session's versions, newest first, without payloads.
   *
   * The history list answers "what exists" and never needs the report body,
   * so the payload stays in the database until someone opens one version.
   *
   * Paged on `version`, which is dense and monotonic per session: "older than
   * the last one I saw" is a value comparison (`version < after`), not an
   * offset, so a save that lands between two requests cannot make a row appear
   * twice or vanish from the next page. One extra row is fetched to answer
   * "is there another page?" without a second count query.
   */
  async listSummaries(
    sessionId: string,
    page: PageRequest = {}
  ): Promise<CursorPage<ReportSnapshotSummary>> {
    const limit = resolvePageLimit(page.limit);
    const after =
      typeof page.after === "number" && Number.isFinite(page.after)
        ? page.after
        : null;
    const rows = await this.database
      .select()
      .from(researchReportSnapshots)
      .where(
        and(
          eq(researchReportSnapshots.sessionId, sessionId),
          after === null
            ? undefined
            : lt(researchReportSnapshots.version, after)
        )
      )
      .orderBy(desc(researchReportSnapshots.version))
      .limit(limit + 1);

    const hasNextPage = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => summaryFrom(row));
    const last = items[items.length - 1];
    return {
      items,
      hasNextPage,
      nextCursor: hasNextPage && last ? last.version : null
    };
  }

  /**
   * One version, payload included.
   *
   * Scoped by session: another session's version is a 404 here, exactly as
   * if it did not exist. `sourceReferences` gains its `present` flag from
   * the capture table — a cleaned-up capture is reported as gone rather
   * than shown as a dangling pointer.
   */
  async getSnapshot(
    sessionId: string,
    snapshotId: string
  ): Promise<ResearchReportSnapshot> {
    const [row] = await this.database
      .select()
      .from(researchReportSnapshots)
      .where(
        and(
          eq(researchReportSnapshots.sessionId, sessionId),
          eq(researchReportSnapshots.id, snapshotId)
        )
      )
      .limit(1);
    if (!row) throw new ReportSnapshotNotFoundError(snapshotId);
    return this.hydrate(row);
  }

  /** One version by its number, for "compare with the previous version". */
  async findByVersion(
    sessionId: string,
    version: number
  ): Promise<ResearchReportSnapshot | null> {
    const [row] = await this.database
      .select()
      .from(researchReportSnapshots)
      .where(
        and(
          eq(researchReportSnapshots.sessionId, sessionId),
          eq(researchReportSnapshots.version, version)
        )
      )
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  /**
   * The version a given idempotency key already produced, if any.
   *
   * This is what makes a double-submitted save the same version instead of a
   * second one, and it works even when the in-memory replay store was lost
   * to a restart: the key travels with the row.
   */
  async findByIdempotencyKey(
    sessionId: string,
    idempotencyKey: string
  ): Promise<ResearchReportSnapshot | null> {
    const [row] = await this.database
      .select()
      .from(researchReportSnapshots)
      .where(
        and(
          eq(researchReportSnapshots.sessionId, sessionId),
          eq(researchReportSnapshots.idempotencyKey, idempotencyKey)
        )
      )
      .limit(1);
    return row ? this.hydrate(row) : null;
  }

  /**
   * The highest version number a session has reached.
   *
   * Read inside the caller's transaction so two concurrent saves cannot both
   * be told "next is 3": the loser collides on the unique index and retries
   * against the now-committed row.
   */
  async maxVersion(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<number> {
    const rows = await executor
      .select({ version: researchReportSnapshots.version })
      .from(researchReportSnapshots)
      .where(eq(researchReportSnapshots.sessionId, sessionId))
      .orderBy(desc(researchReportSnapshots.version))
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  private async hydrate(
    row: typeof researchReportSnapshots.$inferSelect,
    executor: ReadExecutor = this.database
  ): Promise<ResearchReportSnapshot> {
    const storedSources = row.sourceReferences as Array<
      Omit<ReportSourceReference, "present">
    >;
    const snapshotIds = storedSources
      .map((reference) => reference.snapshotId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const presentIds = new Set<string>();
    if (snapshotIds.length > 0) {
      const captureRows = await executor
        .select({ id: sourceSnapshots.id })
        .from(sourceSnapshots)
        .where(inArray(sourceSnapshots.id, snapshotIds));
      for (const capture of captureRows) {
        presentIds.add(capture.id);
      }
    }

    return {
      snapshotId: row.id,
      sessionId: row.sessionId,
      version: row.version,
      createdAt: iso(row.createdAt),
      createdBy: row.createdBy,
      researchQuestion: row.researchQuestion ?? null,
      reportSchemaVersion: row.reportSchemaVersion,
      materialsFingerprint: row.materialsFingerprint,
      snapshotHash: row.snapshotHash,
      reportPayload: row.reportPayload,
      sourceReferences: storedSources.map((reference) => ({
        ...reference,
        present:
          reference.snapshotId === null
            ? false
            : presentIds.has(reference.snapshotId)
      })),
      evidenceReferences: row.evidenceReferences as ReportEvidenceReference[],
      claimReferences: row.claimReferences as ReportClaimReference[],
      reviewReferences: row.reviewReferences as ReportReviewReference[],
      monitoringReferences: row.monitoringReferences as ReportMonitoringReference[],
      changeReason: row.changeReason ?? null
    };
  }
}

function summaryFrom(
  row: typeof researchReportSnapshots.$inferSelect
): ReportSnapshotSummary {
  const claims = row.claimReferences as ReportClaimReference[];
  const evidence = row.evidenceReferences as ReportEvidenceReference[];
  const monitoring = row.monitoringReferences as ReportMonitoringReference[];
  return {
    snapshotId: row.id,
    sessionId: row.sessionId,
    version: row.version,
    createdAt: iso(row.createdAt),
    createdBy: row.createdBy,
    changeReason: row.changeReason ?? null,
    materialsFingerprint: row.materialsFingerprint,
    claimCount: claims.length,
    evidenceCount: evidence.length,
    sourceCount: (row.sourceReferences as unknown[]).length,
    unresolvedConflicts: conflictCountFrom(row.reportPayload),
    openRevalidations: monitoring.filter((task) => task.status === "open")
      .length,
    inReviewRevalidations: monitoring.filter(
      (task) => task.status === "in_review"
    ).length
  };
}

/**
 * Unresolved conflicts, counted from the payload the version froze.
 *
 * The payload is the only place the report states which conflicts were
 * awaiting a human decision at save time, so that is what the history list
 * reports — a count recomputed from today's rows would describe the present,
 * not the version.
 */
function conflictCountFrom(payload: unknown): number {
  if (!isRecord(payload)) return 0;
  const gaps = payload.gaps;
  if (!isRecord(gaps)) return 0;
  const unresolved = gaps.unresolvedConflicts;
  return Array.isArray(unresolved) ? unresolved.length : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A fresh id for a version about to be written. */
export function newSnapshotId(): string {
  return newId();
}
