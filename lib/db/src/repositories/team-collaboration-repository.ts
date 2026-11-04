import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  newId,
  resolvePageLimit,
  type CollaborationActivity,
  type CollaborationEventType,
  type Comment,
  type CommentDraft,
  type CursorPage,
  type MembershipStatus,
  type PageRequest,
  type ReviewDecision,
  type ReviewRequest,
  type ReviewRequestDraft,
  type ReviewRequestType,
  type ReviewRequestTargetType,
  type TeamMember,
  type WorkItem,
  type WorkItemDraft,
  type WorkItemStatus,
  type WorkItemTargetType,
  type CollaborationRole
} from "@nexus/shared";
import type { Database } from "../client";
import {
  decisionSessions,
  executionEvents,
  researchComments,
  researchMemberships,
  researchReviewRequests,
  researchWorkItems
} from "../schema";
import {
  appendEvent,
  type AppendEventInput,
  type DbExecutor
} from "./append-event";

/**
 * Team collaboration & human review storage.
 *
 * Every method either stays inside one session (like the rest of the
 * repository layer) or takes an explicit `sessionId` that the service has
 * already authorized. Nothing here widens access: the authorization decision
 * lives in `TeamCollaborationService`, and this layer's job is to make the
 * authorized write and its audit event atomic and attributable. Attribution
 * columns (`invitedBy`, `createdBy`, `authorUserId`, `requestedBy`,
 * `decidedBy`) are always passed by the service from the caller identity, so
 * a caller cannot author a comment or a decision as someone else.
 */

/** Thrown when an insert would duplicate the one live membership per user. */
export class MembershipExistsError extends Error {
  constructor() {
    super("This user already has a pending or active membership in this research.");
    this.name = "MembershipExistsError";
  }
}

function toIso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function parseMember(row: unknown): TeamMember {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    sessionId: String(value.sessionId),
    userId: String(value.userId),
    role: value.role as CollaborationRole,
    status: value.status as MembershipStatus,
    invitedBy: String(value.invitedBy),
    invitedAt: toIso(value.invitedAt),
    ...(value.joinedAt ? { joinedAt: toIso(value.joinedAt) } : {}),
    statusChangedAt: toIso(value.statusChangedAt),
    ...(value.removedBy ? { removedBy: String(value.removedBy) } : {}),
    ...(value.removeReason ? { removeReason: String(value.removeReason) } : {}),
    version: Number(value.version),
    createdAt: toIso(value.createdAt)
  };
}

function parseWorkItem(row: unknown): WorkItem {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    sessionId: String(value.sessionId),
    title: String(value.title),
    ...(value.description ? { description: String(value.description) } : {}),
    status: value.status as WorkItemStatus,
    ...(value.assigneeUserId
      ? { assigneeUserId: String(value.assigneeUserId) }
      : {}),
    ...(value.targetType
      ? { targetType: value.targetType as WorkItemTargetType }
      : {}),
    ...(value.targetId ? { targetId: String(value.targetId) } : {}),
    createdBy: String(value.createdBy),
    createdAt: toIso(value.createdAt),
    updatedAt: toIso(value.updatedAt),
    ...(value.completedAt ? { completedAt: toIso(value.completedAt) } : {}),
    ...(value.dueAt ? { dueAt: toIso(value.dueAt) } : {}),
    version: Number(value.version)
  };
}

function parseComment(row: unknown): Comment {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    sessionId: String(value.sessionId),
    authorUserId: String(value.authorUserId),
    body: String(value.body),
    targetType: value.targetType as Comment["targetType"],
    targetId: String(value.targetId),
    ...(value.parentCommentId
      ? { parentCommentId: String(value.parentCommentId) }
      : {}),
    ...(value.deletedAt ? { deletedAt: toIso(value.deletedAt) } : {}),
    createdAt: toIso(value.createdAt),
    updatedAt: toIso(value.updatedAt),
    version: Number(value.version)
  };
}

function parseReviewRequest(row: unknown): ReviewRequest {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    sessionId: String(value.sessionId),
    requestType: value.requestType as ReviewRequestType,
    targetType: value.targetType as ReviewRequestTargetType,
    targetId: String(value.targetId),
    requestedBy: String(value.requestedBy),
    ...(value.requestedReviewerUserId
      ? { requestedReviewerUserId: String(value.requestedReviewerUserId) }
      : {}),
    status: value.status as ReviewRequest["status"],
    ...(value.assignedReviewerUserId
      ? { assignedReviewerUserId: String(value.assignedReviewerUserId) }
      : {}),
    ...(value.decision
      ? { decision: value.decision as ReviewDecision }
      : {}),
    ...(value.decidedBy ? { decidedBy: String(value.decidedBy) } : {}),
    ...(value.decidedAt ? { decidedAt: toIso(value.decidedAt) } : {}),
    createdAt: toIso(value.createdAt),
    updatedAt: toIso(value.updatedAt),
    version: Number(value.version)
  };
}

export class TeamCollaborationRepository {
  constructor(private readonly database: Database) {}

  /** The platform owner of the session, or null for a legacy session. */
  async getSessionOwnerUserId(sessionId: string): Promise<string | null> {
    const [row] = await this.database
      .select({ ownerUserId: decisionSessions.ownerUserId })
      .from(decisionSessions)
      .where(eq(decisionSessions.id, sessionId))
      .limit(1);
    return row?.ownerUserId ?? null;
  }

  async sessionExists(sessionId: string): Promise<boolean> {
    const [row] = await this.database
      .select({ id: decisionSessions.id })
      .from(decisionSessions)
      .where(eq(decisionSessions.id, sessionId))
      .limit(1);
    return Boolean(row);
  }

  // ----- Memberships ---------------------------------------------------------

  /** The live (pending or active) membership for a user, if any. */
  async getLiveMembership(
    sessionId: string,
    userId: string
  ): Promise<TeamMember | null> {
    const [row] = await this.database
      .select()
      .from(researchMemberships)
      .where(
        and(
          eq(researchMemberships.sessionId, sessionId),
          eq(researchMemberships.userId, userId),
          sql`${researchMemberships.status} IN ('pending', 'active')`
        )
      )
      .limit(1);
    return row ? parseMember(row) : null;
  }

  /**
   * Sessions where this user holds a live membership (pending or active).
   *
   * The list form of `getLiveMembership`: a collaborator who was invited must
   * still find the research in their workspace, not only by typing its id.
   */
  async listSessionIdsForMember(userId: string): Promise<string[]> {
    const rows = await this.database
      .selectDistinct({ sessionId: researchMemberships.sessionId })
      .from(researchMemberships)
      .where(
        and(
          eq(researchMemberships.userId, userId),
          sql`${researchMemberships.status} IN ('pending', 'active')`
        )
      );
    return rows.map((row) => row.sessionId);
  }

  async getMembershipById(membershipId: string): Promise<TeamMember | null> {
    const [row] = await this.database
      .select()
      .from(researchMemberships)
      .where(eq(researchMemberships.id, membershipId))
      .limit(1);
    return row ? parseMember(row) : null;
  }

  async listMemberships(
    sessionId: string,
    statuses?: readonly MembershipStatus[]
  ): Promise<TeamMember[]> {
    const conditions = [eq(researchMemberships.sessionId, sessionId)];
    if (statuses && statuses.length > 0) {
      conditions.push(inArray(researchMemberships.status, [...statuses]));
    }
    const rows = await this.database
      .select()
      .from(researchMemberships)
      .where(and(...conditions))
      .orderBy(desc(researchMemberships.invitedAt));
    return rows.map(parseMember);
  }

  async listActiveMembersByRole(
    sessionId: string,
    role: CollaborationRole
  ): Promise<TeamMember[]> {
    const rows = await this.database
      .select()
      .from(researchMemberships)
      .where(
        and(
          eq(researchMemberships.sessionId, sessionId),
          eq(researchMemberships.status, "active"),
          eq(researchMemberships.role, role)
        )
      );
    return rows.map(parseMember);
  }

  /** Invite: create a `pending` membership. Unique per user; re-invite 409s. */
  async createMembership(input: {
    sessionId: string;
    userId: string;
    role: CollaborationRole;
    invitedBy: string;
    event: AppendEventInput;
  }): Promise<TeamMember> {
    return this.database.transaction(async (transaction) => {
      const id = newId();
      try {
        const [row] = await transaction
          .insert(researchMemberships)
          .values({
            id,
            sessionId: input.sessionId,
            userId: input.userId,
            role: input.role,
            invitedBy: input.invitedBy
          })
          .returning();
        await appendEvent(transaction, input.sessionId, input.event);
        return parseMember(row!);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "23505"
        ) {
          throw new MembershipExistsError();
        }
        throw error;
      }
    });
  }

  /**
   * Accept a pending invitation: promote to `active` and record when.
   * Returns null if there is no pending membership for this user (so a second
   * accept, or accepting something you were never invited to, is not a 200).
   */
  async acceptMembership(
    sessionId: string,
    userId: string,
    event: AppendEventInput
  ): Promise<TeamMember | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(researchMemberships)
        .set({
          status: "active",
          joinedAt: new Date().toISOString(),
          statusChangedAt: new Date().toISOString(),
          version: sql`${researchMemberships.version} + 1`
        })
        .where(
          and(
            eq(researchMemberships.sessionId, sessionId),
            eq(researchMemberships.userId, userId),
            eq(researchMemberships.status, "pending")
          )
        )
        .returning();
      if (!row) return null;
      await appendEvent(transaction, sessionId, event);
      return parseMember(row);
    });
  }

  /** Decline a pending invitation. Returns null if nothing pending. */
  async declineMembership(
    sessionId: string,
    userId: string,
    event: AppendEventInput
  ): Promise<TeamMember | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(researchMemberships)
        .set({
          status: "declined",
          statusChangedAt: new Date().toISOString(),
          version: sql`${researchMemberships.version} + 1`
        })
        .where(
          and(
            eq(researchMemberships.sessionId, sessionId),
            eq(researchMemberships.userId, userId),
            eq(researchMemberships.status, "pending")
          )
        )
        .returning();
      if (!row) return null;
      await appendEvent(transaction, sessionId, event);
      return parseMember(row);
    });
  }

  /**
   * Change a live member's role, optimistic-locked on `expectedVersion`.
   * Returns null on a version mismatch (the caller maps it to 409).
   */
  async changeRole(
    sessionId: string,
    userId: string,
    role: CollaborationRole,
    expectedVersion: number,
    event: AppendEventInput
  ): Promise<TeamMember | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(researchMemberships)
        .set({
          role,
          statusChangedAt: new Date().toISOString(),
          version: sql`${researchMemberships.version} + 1`
        })
        .where(
          and(
            eq(researchMemberships.sessionId, sessionId),
            eq(researchMemberships.userId, userId),
            sql`${researchMemberships.status} IN ('pending', 'active')`,
            eq(researchMemberships.version, expectedVersion)
          )
        )
        .returning();
      if (!row) return null;
      await appendEvent(transaction, sessionId, event);
      return parseMember(row);
    });
  }

  /**
   * Remove a live member, recording who and why. Optimistic-locked on
   * `expectedVersion`; null on mismatch.
   */
  async removeMembership(
    sessionId: string,
    userId: string,
    removedBy: string,
    reason: string,
    expectedVersion: number,
    event: AppendEventInput
  ): Promise<TeamMember | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(researchMemberships)
        .set({
          status: "removed",
          removedBy,
          removeReason: reason,
          statusChangedAt: new Date().toISOString(),
          version: sql`${researchMemberships.version} + 1`
        })
        .where(
          and(
            eq(researchMemberships.sessionId, sessionId),
            eq(researchMemberships.userId, userId),
            sql`${researchMemberships.status} IN ('pending', 'active')`,
            eq(researchMemberships.version, expectedVersion)
          )
        )
        .returning();
      if (!row) return null;
      await appendEvent(transaction, sessionId, event);
      return parseMember(row);
    });
  }

  // ----- Work items ----------------------------------------------------------

  async createWorkItem(input: {
    sessionId: string;
    draft: WorkItemDraft;
    createdBy: string;
    event: AppendEventInput;
  }): Promise<WorkItem> {
    return this.database.transaction(async (transaction) => {
      const id = newId();
      const [row] = await transaction
        .insert(researchWorkItems)
        .values({
          id,
          sessionId: input.sessionId,
          title: input.draft.title,
          ...(input.draft.description
            ? { description: input.draft.description }
            : {}),
          assigneeUserId: input.draft.assigneeUserId ?? null,
          ...(input.draft.targetType
            ? { targetType: input.draft.targetType }
            : {}),
          ...(input.draft.targetId
            ? { targetId: input.draft.targetId }
            : {}),
          createdBy: input.createdBy,
          ...(input.draft.dueAt ? { dueAt: input.draft.dueAt } : {})
        })
        .returning();
      await appendEvent(transaction, input.sessionId, input.event);
      return parseWorkItem(row!);
    });
  }

  async getWorkItem(workItemId: string): Promise<WorkItem | null> {
    const [row] = await this.database
      .select()
      .from(researchWorkItems)
      .where(eq(researchWorkItems.id, workItemId))
      .limit(1);
    return row ? parseWorkItem(row) : null;
  }

  async listWorkItems(sessionId: string): Promise<WorkItem[]> {
    const rows = await this.database
      .select()
      .from(researchWorkItems)
      .where(eq(researchWorkItems.sessionId, sessionId))
      .orderBy(desc(researchWorkItems.updatedAt));
    return rows.map(parseWorkItem);
  }

  /**
   * Apply a set of changes optimistically. `expectedVersion` makes the write
   * conditional; a mismatch returns null (mapped to 409). `completedAt` is set
   * when `status` becomes `completed`, and cleared otherwise, so the DB's
   * "completed implies completedAt" CHECK stays satisfied.
   */
  async updateWorkItem(input: {
    workItemId: string;
    changes: {
      title?: string;
      description?: string;
      status?: WorkItemStatus;
      assigneeUserId?: string;
      dueAt?: string;
    };
    expectedVersion: number;
    event?: AppendEventInput;
  }): Promise<WorkItem | null> {
    return this.database.transaction(async (transaction) => {
      const setValues: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
        version: sql`${researchWorkItems.version} + 1`
      };
      if (input.changes.title !== undefined)
        setValues.title = input.changes.title;
      if (input.changes.description !== undefined)
        setValues.description = input.changes.description;
      if (input.changes.status !== undefined)
        setValues.status = input.changes.status;
      if (input.changes.assigneeUserId !== undefined)
        setValues.assigneeUserId = input.changes.assigneeUserId;
      if (input.changes.dueAt !== undefined) setValues.dueAt = input.changes.dueAt;
      // Keep the completed<>completedAt invariant intact on every write.
      if (input.changes.status === "completed") {
        setValues.completedAt = new Date().toISOString();
      } else if (input.changes.status !== undefined) {
        setValues.completedAt = null;
      }
      const [row] = await transaction
        .update(researchWorkItems)
        .set(setValues)
        .where(
          and(
            eq(researchWorkItems.id, input.workItemId),
            eq(researchWorkItems.version, input.expectedVersion)
          )
        )
        .returning();
      if (!row) return null;
      if (input.event) {
        await appendEvent(transaction, String(row.sessionId), input.event);
      }
      return parseWorkItem(row);
    });
  }

  // ----- Comments ------------------------------------------------------------

  async createComment(input: {
    sessionId: string;
    draft: CommentDraft;
    authorUserId: string;
    event: AppendEventInput;
  }): Promise<Comment> {
    return this.database.transaction(async (transaction) => {
      const id = newId();
      const [row] = await transaction
        .insert(researchComments)
        .values({
          id,
          sessionId: input.sessionId,
          authorUserId: input.authorUserId,
          body: input.draft.body,
          targetType: input.draft.targetType,
          targetId: input.draft.targetId,
          ...(input.draft.parentCommentId
            ? { parentCommentId: input.draft.parentCommentId }
            : {})
        })
        .returning();
      await appendEvent(transaction, input.sessionId, input.event);
      return parseComment(row!);
    });
  }

  async getComment(commentId: string): Promise<Comment | null> {
    const [row] = await this.database
      .select()
      .from(researchComments)
      .where(
        and(
          eq(researchComments.id, commentId),
          sql`${researchComments.deletedAt} IS NULL`
        )
      )
      .limit(1);
    return row ? parseComment(row) : null;
  }

  /** All non-deleted comments on a target, newest first. */
  async listComments(
    sessionId: string,
    targetType: string,
    targetId: string
  ): Promise<Comment[]> {
    const rows = await this.database
      .select()
      .from(researchComments)
      .where(
        and(
          eq(researchComments.sessionId, sessionId),
          eq(researchComments.targetType, targetType),
          eq(researchComments.targetId, targetId),
          sql`${researchComments.deletedAt} IS NULL`
        )
      )
      .orderBy(desc(researchComments.createdAt));
    return rows.map(parseComment);
  }

  /** Soft-delete a comment by its author. Optimistic-locked; null on mismatch. */
  async softDeleteComment(
    commentId: string,
    expectedVersion: number,
    event: AppendEventInput
  ): Promise<Comment | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(researchComments)
        .set({
          deletedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: sql`${researchComments.version} + 1`
        })
        .where(
          and(
            eq(researchComments.id, commentId),
            sql`${researchComments.deletedAt} IS NULL`,
            eq(researchComments.version, expectedVersion)
          )
        )
        .returning();
      if (!row) return null;
      await appendEvent(transaction, String(row.sessionId), event);
      return parseComment(row);
    });
  }

  // ----- Review requests -----------------------------------------------------

  async createReviewRequest(input: {
    sessionId: string;
    draft: ReviewRequestDraft;
    requestedBy: string;
    event: AppendEventInput;
  }): Promise<ReviewRequest> {
    return this.database.transaction(async (transaction) => {
      const id = newId();
      const [row] = await transaction
        .insert(researchReviewRequests)
        .values({
          id,
          sessionId: input.sessionId,
          requestType: input.draft.requestType,
          targetType: input.draft.targetType,
          targetId: input.draft.targetId,
          requestedBy: input.requestedBy,
          ...(input.draft.requestedReviewerUserId
            ? {
                requestedReviewerUserId: input.draft.requestedReviewerUserId
              }
            : {})
        })
        .returning();
      await appendEvent(transaction, input.sessionId, input.event);
      return parseReviewRequest(row!);
    });
  }

  async getReviewRequest(reviewRequestId: string): Promise<ReviewRequest | null> {
    const [row] = await this.database
      .select()
      .from(researchReviewRequests)
      .where(eq(researchReviewRequests.id, reviewRequestId))
      .limit(1);
    return row ? parseReviewRequest(row) : null;
  }

  async listReviewRequests(sessionId: string): Promise<ReviewRequest[]> {
    const rows = await this.database
      .select()
      .from(researchReviewRequests)
      .where(eq(researchReviewRequests.sessionId, sessionId))
      .orderBy(desc(researchReviewRequests.createdAt));
    return rows.map(parseReviewRequest);
  }

  /** Claim an open request. Optimistic-locked; null on mismatch. */
  async claimReviewRequest(
    reviewRequestId: string,
    reviewerUserId: string,
    expectedVersion: number,
    event: AppendEventInput
  ): Promise<ReviewRequest | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(researchReviewRequests)
        .set({
          status: "in_review",
          assignedReviewerUserId: reviewerUserId,
          updatedAt: new Date().toISOString(),
          version: sql`${researchReviewRequests.version} + 1`
        })
        .where(
          and(
            eq(researchReviewRequests.id, reviewRequestId),
            eq(researchReviewRequests.status, "open"),
            eq(researchReviewRequests.version, expectedVersion)
          )
        )
        .returning();
      if (!row) return null;
      await appendEvent(transaction, String(row.sessionId), event);
      return parseReviewRequest(row);
    });
  }

  /**
   * Decide a request (approve/reject). Completes it and records the decision
   * and who made it. Optimistic-locked; null on mismatch. Deliberately does
   * NOT write a claim verdict or a verification status — an `approved` here is
   * a human sign-off, and any formal verification still goes through the
   * existing evidence-verification API.
   */
  async decideReviewRequest(
    reviewRequestId: string,
    decision: ReviewDecision,
    decidedBy: string,
    expectedVersion: number,
    event: AppendEventInput
  ): Promise<ReviewRequest | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(researchReviewRequests)
        .set({
          status: "completed",
          decision,
          decidedBy,
          decidedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          version: sql`${researchReviewRequests.version} + 1`
        })
        .where(
          and(
            eq(researchReviewRequests.id, reviewRequestId),
            eq(researchReviewRequests.status, "in_review"),
            eq(researchReviewRequests.version, expectedVersion)
          )
        )
        .returning();
      if (!row) return null;
      await appendEvent(transaction, String(row.sessionId), event);
      return parseReviewRequest(row);
    });
  }

  /** Cancel an open request. Optimistic-locked; null on mismatch. */
  async cancelReviewRequest(
    reviewRequestId: string,
    expectedVersion: number,
    event: AppendEventInput
  ): Promise<ReviewRequest | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(researchReviewRequests)
        .set({
          status: "cancelled",
          updatedAt: new Date().toISOString(),
          version: sql`${researchReviewRequests.version} + 1`
        })
        .where(
          and(
            eq(researchReviewRequests.id, reviewRequestId),
            eq(researchReviewRequests.status, "open"),
            eq(researchReviewRequests.version, expectedVersion)
          )
        )
        .returning();
      if (!row) return null;
      await appendEvent(transaction, String(row.sessionId), event);
      return parseReviewRequest(row);
    });
  }

  // ----- Activity ------------------------------------------------------------

  /**
   * The collaboration activity feed, projected from `executionEvents` (which
   * is reused, not duplicated). Only the collaboration event types are
   * returned, newest first, so the audit trail for a research stays one table.
   */
  /**
   * One page of a research's collaboration trail, newest first.
   *
   * The trail is an append-only event log: it grows with every comment, status
   * change and review decision, so reading all of it means reading the whole
   * history of the research on every tab click. Paged on `sequence`, which is
   * dense and monotonic per session, so "older than the last one I saw" is a
   * value comparison and a concurrent append cannot shift a page.
   */
  async listActivity(
    sessionId: string,
    types: readonly CollaborationEventType[],
    page: PageRequest = {}
  ): Promise<CursorPage<CollaborationActivity>> {
    if (types.length === 0) {
      return { items: [], nextCursor: null, hasNextPage: false };
    }
    const limit = resolvePageLimit(page.limit);
    const after =
      typeof page.after === "number" && Number.isFinite(page.after)
        ? page.after
        : null;
    const rows = await this.database
      .select()
      .from(executionEvents)
      .where(
        and(
          eq(executionEvents.sessionId, sessionId),
          inArray(executionEvents.type, [...types]),
          after === null ? undefined : lt(executionEvents.sequence, after)
        )
      )
      .orderBy(desc(executionEvents.sequence))
      .limit(limit + 1);
    const hasNextPage = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => ({
      id: String(row.id),
      sessionId: String(row.sessionId),
      sequence: Number(row.sequence),
      correlationId: String(row.correlationId),
      type: String(row.type),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      occurredAt: toIso(row.occurredAt)
    }));
    const last = items[items.length - 1];
    return {
      items,
      hasNextPage,
      nextCursor: hasNextPage && last ? last.sequence : null
    };
  }
}

export type { DbExecutor };
