import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { newId } from "@nexus/shared";
import type { Database } from "../client";
import {
  agentRuns,
  decisionSessions,
  notificationReads,
  researchComments,
  researchMemberships,
  researchReportSnapshots,
  researchReviewRequests
} from "../schema";
import { iso } from "./domain-mapper";

/**
 * The facts the notification centre derives items from.
 *
 * Nothing here is a notification. Every reader returns rows that already exist
 * for their own reasons — a membership someone has to accept, an open review
 * request, a comment somebody wrote, a snapshot that was saved, a run that
 * failed and must be retried — and the centre is one more way of looking at
 * them. That is deliberate: a stored notification would keep announcing an
 * invitation that was withdrawn, a request that has since been decided, or a
 * failure that has since been fixed.
 */
export type PendingInvitationRow = {
  membershipId: string;
  sessionId: string;
  researchQuestion: string | null;
  role: string;
  invitedBy: string;
  invitedAt: string;
};

export type FailedRunRow = {
  runId: string;
  sessionId: string;
  researchQuestion: string | null;
  error: string | null;
  attempt: number;
  startedAt: string;
};

/** A review somebody is waiting on: addressed to this account, still open. */
export type PendingReviewRequestRow = {
  requestId: string;
  sessionId: string;
  researchQuestion: string | null;
  requestType: string;
  targetType: string;
  targetId: string;
  /**
   * `open` or `in_review` — both are still waiting on somebody. The row says
   * which one it is, because a reader that only ever saw `open` would be
   * looking at half of the truth and would not know it.
   */
  status: string;
  requestedBy: string;
  createdAt: string;
};

/** Somebody else's comment, on a research this account may read. */
export type RecentCommentRow = {
  commentId: string;
  sessionId: string;
  researchQuestion: string | null;
  authorUserId: string;
  targetType: string;
  body: string;
  createdAt: string;
};

/** A report version saved by somebody else. */
export type RecentVersionRow = {
  snapshotId: string;
  sessionId: string;
  researchQuestion: string | null;
  version: number;
  createdBy: string;
  changeReason: string | null;
  createdAt: string;
};

/**
 * Read markers: the one thing that cannot be derived.
 *
 * Idempotent on purpose. Two tabs open, both marking the same card read, and
 * the second call does nothing rather than failing or double-counting.
 */
export class NotificationRepository {
  constructor(private readonly database: Database) {}

  async listPendingInvitations(userId: string): Promise<PendingInvitationRow[]> {
    const rows = await this.database
      .select({
        membershipId: researchMemberships.id,
        sessionId: researchMemberships.sessionId,
        researchQuestion: decisionSessions.researchQuestion,
        role: researchMemberships.role,
        invitedBy: researchMemberships.invitedBy,
        invitedAt: researchMemberships.invitedAt
      })
      .from(researchMemberships)
      .innerJoin(
        decisionSessions,
        eq(decisionSessions.id, researchMemberships.sessionId)
      )
      .where(
        and(
          eq(researchMemberships.userId, userId),
          eq(researchMemberships.status, "pending")
        )
      )
      .orderBy(desc(researchMemberships.invitedAt));

    return rows.map((row) => ({ ...row, invitedAt: iso(row.invitedAt) }));
  }

  /**
   * Failed runs in the researches this account may read.
   *
   * `sessionIds` is the access decision, already made by the caller from the
   * same source the session guard uses, so there is exactly one place that
   * decides who may read what. `"all"` is a separate value on purpose: an
   * empty array must mean "nothing", and an operator deployment with no
   * identity system has no ids to hand in. Collapsing the two would turn a
   * caller who may read nothing into a caller who sees everything.
   */
  async listFailedRuns(
    sessionIds: readonly string[] | "all"
  ): Promise<FailedRunRow[]> {
    if (sessionIds !== "all" && sessionIds.length === 0) return [];

    const rows = await this.database
      .select({
        runId: agentRuns.id,
        sessionId: agentRuns.sessionId,
        researchQuestion: decisionSessions.researchQuestion,
        error: agentRuns.error,
        attempt: agentRuns.attempt,
        startedAt: agentRuns.startedAt
      })
      .from(agentRuns)
      .innerJoin(decisionSessions, eq(decisionSessions.id, agentRuns.sessionId))
      .where(
        sessionIds === "all"
          ? eq(agentRuns.status, "failed")
          : and(
              eq(agentRuns.status, "failed"),
              inArray(agentRuns.sessionId, [...sessionIds])
            )
      )
      .orderBy(desc(agentRuns.startedAt));

    return rows.map((row) => ({ ...row, startedAt: iso(row.startedAt) }));
  }

  /**
   * Review requests addressed to this account that are still open.
   *
   * Addressed means either named when the request was raised
   * (`requested_reviewer_user_id`) or picked up since
   * (`assigned_reviewer_user_id`). Both columns carry their own partial index,
   * so the `OR` is a bitmap union rather than a scan.
   *
   * **Both `open` and `in_review` count, and the reason is in the schema.** A
   * CHECK constraint keeps the two in lock-step: an `open` request has no
   * assignee yet, an `in_review` one has exactly one. Filtering on `open`
   * alone would therefore drop every request somebody has already picked up —
   * which is precisely the one waiting on *this* reviewer for a verdict. The
   * request stops being a notification when it is decided or cancelled, not
   * when somebody accepts it.
   */
  async listPendingReviewRequests(
    userId: string
  ): Promise<PendingReviewRequestRow[]> {
    const rows = await this.database
      .select({
        requestId: researchReviewRequests.id,
        sessionId: researchReviewRequests.sessionId,
        researchQuestion: decisionSessions.researchQuestion,
        requestType: researchReviewRequests.requestType,
        targetType: researchReviewRequests.targetType,
        targetId: researchReviewRequests.targetId,
        status: researchReviewRequests.status,
        requestedBy: researchReviewRequests.requestedBy,
        createdAt: researchReviewRequests.createdAt
      })
      .from(researchReviewRequests)
      .innerJoin(
        decisionSessions,
        eq(decisionSessions.id, researchReviewRequests.sessionId)
      )
      .where(
        and(
          inArray(researchReviewRequests.status, ["open", "in_review"]),
          or(
            eq(researchReviewRequests.requestedReviewerUserId, userId),
            eq(researchReviewRequests.assignedReviewerUserId, userId)
          )
        )
      )
      .orderBy(desc(researchReviewRequests.createdAt));

    return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
  }

  /**
   * Comments other people left, inside the window, on researches you can read.
   *
   * Three filters, and each one removes a different kind of noise:
   *
   *  - `author_user_id <> viewer` — your own comment is not news to you.
   *  - `deleted_at is null` — a comment somebody withdrew must not keep
   *    appearing in a feed that cannot be edited.
   *  - `created_at > since` — without a window, a three-year-old comment would
   *    be as "new" as this morning's, forever. The window is the definition of
   *    news here, and the caller supplies it so the value lives in one place.
   */
  async listRecentComments(
    sessionIds: readonly string[] | "all",
    viewerUserId: string,
    since: string
  ): Promise<RecentCommentRow[]> {
    if (sessionIds !== "all" && sessionIds.length === 0) return [];

    const rows = await this.database
      .select({
        commentId: researchComments.id,
        sessionId: researchComments.sessionId,
        researchQuestion: decisionSessions.researchQuestion,
        authorUserId: researchComments.authorUserId,
        targetType: researchComments.targetType,
        body: researchComments.body,
        createdAt: researchComments.createdAt
      })
      .from(researchComments)
      .innerJoin(
        decisionSessions,
        eq(decisionSessions.id, researchComments.sessionId)
      )
      .where(
        and(
          isNull(researchComments.deletedAt),
          ne(researchComments.authorUserId, viewerUserId),
          gt(researchComments.createdAt, since),
          sessionIds === "all"
            ? undefined
            : inArray(researchComments.sessionId, [...sessionIds])
        )
      )
      .orderBy(desc(researchComments.createdAt));

    return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
  }

  /**
   * Report versions somebody else saved, inside the window.
   *
   * `created_by <> viewer` is the same rule as comments: a version you saved
   * yourself is not something to be told about. There is no delete state to
   * filter on — versions are immutable by design, which is why this reader is
   * the simplest of the three.
   */
  async listRecentVersions(
    sessionIds: readonly string[] | "all",
    viewerUserId: string,
    since: string
  ): Promise<RecentVersionRow[]> {
    if (sessionIds !== "all" && sessionIds.length === 0) return [];

    const rows = await this.database
      .select({
        snapshotId: researchReportSnapshots.id,
        sessionId: researchReportSnapshots.sessionId,
        researchQuestion: decisionSessions.researchQuestion,
        version: researchReportSnapshots.version,
        createdBy: researchReportSnapshots.createdBy,
        changeReason: researchReportSnapshots.changeReason,
        createdAt: researchReportSnapshots.createdAt
      })
      .from(researchReportSnapshots)
      .innerJoin(
        decisionSessions,
        eq(decisionSessions.id, researchReportSnapshots.sessionId)
      )
      .where(
        and(
          ne(researchReportSnapshots.createdBy, viewerUserId),
          gt(researchReportSnapshots.createdAt, since),
          sessionIds === "all"
            ? undefined
            : inArray(researchReportSnapshots.sessionId, [...sessionIds])
        )
      )
      .orderBy(desc(researchReportSnapshots.createdAt));

    return rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) }));
  }

  async listReadKeys(userId: string): Promise<string[]> {
    const rows = await this.database
      .select({ itemKey: notificationReads.itemKey })
      .from(notificationReads)
      .where(eq(notificationReads.userId, userId));
    return rows.map((row) => row.itemKey);
  }

  async markRead(userId: string, itemKeys: readonly string[]): Promise<void> {
    if (itemKeys.length === 0) return;
    await this.database
      .insert(notificationReads)
      .values(
        itemKeys.map((itemKey) => ({ id: newId(), userId, itemKey }))
      )
      // A second tap on an already-read card is not an error.
      .onConflictDoNothing({
        target: [notificationReads.userId, notificationReads.itemKey]
      });
  }

  /** Rows a reader no longer needs, so the marker table cannot grow forever. */
  async forgetKeys(userId: string): Promise<number> {
    const result = await this.database.execute(
      sql`DELETE FROM ${notificationReads} AS n
          WHERE n.user_id = ${userId}
            AND n.read_at < now() - interval '90 days'`
    );
    return Number((result as unknown as { rowCount?: number }).rowCount ?? 0);
  }
}
