import {
  COLLABORATION_EVENT_TYPES,
  type CollaborationActivity,
  type CollaborationRole,
  type Comment,
  type CommentDraft,
  type MembershipStatus,
  type ReviewDecision,
  type ReviewRequest,
  type ReviewRequestDecision,
  type ReviewRequestDraft,
  type TeamMember,
  type TeamMemberInvite,
  type TeamMemberRemoval,
  type TeamMemberRoleChange,
  type WorkItem,
  type WorkItemDraft,
  type WorkItemStatus,
  type WorkItemUpdate
} from "@nexus/shared";
import {
  MembershipExistsError,
  type TeamCollaborationRepository
} from "@nexus/db";

/**
 * Team collaboration & human review workflow.
 *
 * The authorization model in one sentence: a caller acts in a research under a
 * *collaboration role* derived from either platform ownership of the session
 * (`decision_sessions.owner_user_id`) or their live membership row; the four
 * roles are owner > editor > reviewer > viewer, and every write is gated on
 * that role. Unknown or unauthorized sessions answer 404 — the same answer an
 * unknown id gets — so the API cannot be used to probe which researches
 * exist. Attribution (who invited, authored, requested, decided) is always
 * taken from the caller, never the request body, and the optimistic-lock
 * `version` column makes two concurrent writers a 409, never a silent
 * overwrite.
 */

/** The actor, supplied by the route from the server-side identity. */
export type CollaborationCaller = {
  userId: string;
  role: CollaborationRole;
  name: string;
  /** Set only when the deployment has no identity system. */
  implicitOperator?: boolean;
};

// ----- Errors (mapped to HTTP by the route) ---------------------------------

/** Session not found, or the caller is not a collaborator on it. 404. */
export class CollaborationSessionNotFoundError extends Error {
  constructor() {
    super("Not found");
    this.name = "CollaborationSessionNotFoundError";
  }
}

/** The caller may read but not write (e.g. viewer role). 403. */
export class CollaborationForbiddenError extends Error {
  constructor(message = "You do not have permission to perform this action") {
    super(message);
    this.name = "CollaborationForbiddenError";
  }
}

/** A write collided with another (version mismatch, re-invite, last-owner). */
export class CollaborationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaborationConflictError";
  }
}

/** Malformed request: escalation attempt, self-review, bad assignment. 400. */
export class CollaborationBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaborationBadRequestError";
  }
}

/** A referenced collaboration object (member/work item/comment/request). 404. */
export class CollaborationTargetNotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "CollaborationTargetNotFoundError";
  }
}

export type CollaborationContext = {
  sessionId: string;
  ownerUserId: string | null;
  /** The caller's collaboration role, or null if they are not a collaborator. */
  role: CollaborationRole | null;
  /** True when the caller is the platform owner of the session. */
  isPlatformOwner: boolean;
};

const WRITE_ROLES: CollaborationRole[] = ["owner", "editor"];
const COMMENT_ROLES: CollaborationRole[] = ["owner", "editor", "reviewer"];

export class TeamCollaborationService {
  constructor(private readonly repo: TeamCollaborationRepository) {}

  // ----- Authorization helpers ----------------------------------------------

  private async requireContext(
    caller: CollaborationCaller,
    sessionId: string
  ): Promise<CollaborationContext> {
    const ownerUserId = await this.repo.getSessionOwnerUserId(sessionId);
    if (ownerUserId === null && !(await this.repo.sessionExists(sessionId))) {
      throw new CollaborationSessionNotFoundError();
    }
    let role: CollaborationRole | null = null;
    if (caller.implicitOperator) {
      role = "owner";
    } else if (ownerUserId !== null && ownerUserId === caller.userId) {
      role = "owner";
    } else {
      const membership = await this.repo.getLiveMembership(
        sessionId,
        caller.userId
      );
      role = membership ? membership.role : null;
    }
    return {
      sessionId,
      ownerUserId,
      role,
      isPlatformOwner:
        ownerUserId !== null && ownerUserId === caller.userId
    };
  }

  /** Read access: the caller must be a collaborator (any role) or owner. */
  private async requireReader(
    caller: CollaborationCaller,
    sessionId: string
  ): Promise<CollaborationContext> {
    const ctx = await this.requireContext(caller, sessionId);
    if (ctx.role === null) {
      throw new CollaborationSessionNotFoundError();
    }
    return ctx;
  }

  /** Write access: the caller must hold one of `allowed` collaboration roles. */
  private async requireWriter(
    caller: CollaborationCaller,
    sessionId: string,
    allowed: CollaborationRole[]
  ): Promise<CollaborationContext> {
    const ctx = await this.requireReader(caller, sessionId);
    if (ctx.role === null || !allowed.includes(ctx.role)) {
      throw new CollaborationForbiddenError();
    }
    return ctx;
  }

  /**
   * Member-administration access: only the session owner — the platform owner,
   * or an active owner-role member (for legacy sessions whose platform owner
   * is unknown).
   */
  private async requireOwner(
    caller: CollaborationCaller,
    sessionId: string
  ): Promise<CollaborationContext> {
    const ctx = await this.requireReader(caller, sessionId);
    if (!ctx.isPlatformOwner && ctx.role !== "owner") {
      throw new CollaborationForbiddenError(
        "Only the research owner may administer its members"
      );
    }
    return ctx;
  }

  /**
   * Ensures removing or downgrading `userId` does not leave the research with
   * no owner. The platform owner always counts; for a legacy session with no
   * platform owner, there must remain at least one active owner member.
   */
  private async assertNotLastOwner(
    ctx: CollaborationContext,
    excludingUserId: string
  ): Promise<void> {
    if (ctx.ownerUserId !== null) {
      // A platform owner survives any membership change.
      return;
    }
    const remainingOwners = await this.repo.listActiveMembersByRole(
      ctx.sessionId,
      "owner"
    );
    const others = remainingOwners.filter((m) => m.userId !== excludingUserId);
    if (others.length === 0) {
      throw new CollaborationConflictError(
        "This research would be left with no owner; promote or invite another owner first"
      );
    }
  }

  // ----- Members -------------------------------------------------------------

  async listMembers(
    caller: CollaborationCaller,
    sessionId: string,
    statuses?: readonly MembershipStatus[]
  ): Promise<TeamMember[]> {
    await this.requireReader(caller, sessionId);
    return this.repo.listMemberships(sessionId, statuses);
  }

  /**
   * Invite a user. The platform owner or an editor may invite; the role is
   * capped at editor/reviewer/viewer so the collaboration API can never grant
   * ownership (privilege escalation is impossible through this surface).
   */
  async inviteMember(
    caller: CollaborationCaller,
    invite: TeamMemberInvite
  ): Promise<TeamMember> {
    await this.requireWriter(caller, invite.sessionId, WRITE_ROLES);
    if (invite.role === "owner") {
      throw new CollaborationBadRequestError(
        "Ownership is set by the platform, not by the collaboration API"
      );
    }
    try {
      return await this.repo.createMembership({
        sessionId: invite.sessionId,
        userId: invite.userId,
        role: invite.role,
        invitedBy: caller.name,
        event: {
          correlationId: invite.sessionId,
          type: "MEMBER_INVITED",
          payload: {
            userId: invite.userId,
            role: invite.role,
            invitedBy: caller.name
          }
        }
      });
    } catch (error) {
      if (error instanceof MembershipExistsError) {
        throw new CollaborationConflictError(
          "This user already has a pending or active membership in this research"
        );
      }
      throw error;
    }
  }

  /** The invitee accepts their own pending invitation. */
  async acceptInvitation(
    caller: CollaborationCaller,
    sessionId: string,
    userId: string
  ): Promise<TeamMember> {
    if (!caller.implicitOperator && caller.userId !== userId) {
      throw new CollaborationForbiddenError(
        "You can only accept your own invitation"
      );
    }
    if (!(await this.repo.sessionExists(sessionId))) {
      throw new CollaborationSessionNotFoundError();
    }
    const member = await this.repo.acceptMembership(sessionId, userId, {
      correlationId: sessionId,
      type: "MEMBER_JOINED",
      payload: { userId, acceptedBy: caller.name }
    });
    if (!member) {
      throw new CollaborationTargetNotFoundError(
        "No pending invitation for this user"
      );
    }
    return member;
  }

  /** The invitee declines their own pending invitation. */
  async declineInvitation(
    caller: CollaborationCaller,
    sessionId: string,
    userId: string
  ): Promise<TeamMember> {
    if (!caller.implicitOperator && caller.userId !== userId) {
      throw new CollaborationForbiddenError(
        "You can only decline your own invitation"
      );
    }
    if (!(await this.repo.sessionExists(sessionId))) {
      throw new CollaborationSessionNotFoundError();
    }
    const member = await this.repo.declineMembership(sessionId, userId, {
      correlationId: sessionId,
      type: "MEMBER_DECLINED",
      payload: { userId, declinedBy: caller.name }
    });
    if (!member) {
      throw new CollaborationTargetNotFoundError(
        "No pending invitation for this user"
      );
    }
    return member;
  }

  /** Change a live member's role. Owner only; never promotes to owner. */
  async changeMemberRole(
    caller: CollaborationCaller,
    change: TeamMemberRoleChange
  ): Promise<TeamMember> {
    const ctx = await this.requireOwner(caller, change.sessionId);
    if (change.role === "owner") {
      throw new CollaborationBadRequestError(
        "Ownership is set by the platform, not by the collaboration API"
      );
    }
    const current = await this.repo.getLiveMembership(
      change.sessionId,
      change.userId
    );
    if (!current) {
      throw new CollaborationTargetNotFoundError("Member not found");
    }
    // Reaching here, `change.role` is already known not to be "owner".
    if (current.role === "owner") {
      await this.assertNotLastOwner(ctx, change.userId);
    }
    const member = await this.repo.changeRole(
      change.sessionId,
      change.userId,
      change.role,
      current.version,
      {
        correlationId: change.sessionId,
        type: "MEMBER_ROLE_CHANGED",
        payload: {
          userId: change.userId,
          from: current.role,
          to: change.role,
          changedBy: caller.name
        }
      }
    );
    if (!member) {
      throw new CollaborationConflictError(
        "This membership was modified by someone else; please reload and retry"
      );
    }
    return member;
  }

  /** Remove a live member. Owner only; never strands the research without owner. */
  async removeMember(
    caller: CollaborationCaller,
    removal: TeamMemberRemoval
  ): Promise<TeamMember> {
    const ctx = await this.requireOwner(caller, removal.sessionId);
    const current = await this.repo.getLiveMembership(
      removal.sessionId,
      removal.userId
    );
    if (!current) {
      throw new CollaborationTargetNotFoundError("Member not found");
    }
    if (current.role === "owner") {
      await this.assertNotLastOwner(ctx, removal.userId);
    }
    const member = await this.repo.removeMembership(
      removal.sessionId,
      removal.userId,
      caller.name,
      removal.reason,
      current.version,
      {
        correlationId: removal.sessionId,
        type: "MEMBER_REMOVED",
        payload: {
          userId: removal.userId,
          removedBy: caller.name,
          reason: removal.reason
        }
      }
    );
    if (!member) {
      throw new CollaborationConflictError(
        "This membership was modified by someone else; please reload and retry"
      );
    }
    return member;
  }

  // ----- Work items ----------------------------------------------------------

  async listWorkItems(
    caller: CollaborationCaller,
    sessionId: string
  ): Promise<WorkItem[]> {
    await this.requireReader(caller, sessionId);
    return this.repo.listWorkItems(sessionId);
  }

  /**
   * Create a work item. Owner/editor only, and the assignee — if named — must
   * be a collaborator (the platform owner or an active member), so a task is
   * never assigned to someone who cannot see the research.
   */
  async createWorkItem(
    caller: CollaborationCaller,
    draft: WorkItemDraft
  ): Promise<WorkItem> {
    await this.requireWriter(caller, draft.sessionId, WRITE_ROLES);
    if (draft.assigneeUserId) {
      await this.assertAssignable(caller, draft.sessionId, draft.assigneeUserId);
    }
    return this.repo.createWorkItem({
      sessionId: draft.sessionId,
      draft,
      createdBy: caller.name,
      event: {
        correlationId: draft.sessionId,
        type: "WORK_ITEM_CREATED",
        payload: {
          title: draft.title,
          assigneeUserId: draft.assigneeUserId ?? null,
          createdBy: caller.name
        }
      }
    });
  }

  /** Update a work item. Owner/editor only; assignee is re-validated. */
  async updateWorkItem(
    caller: CollaborationCaller,
    update: WorkItemUpdate
  ): Promise<WorkItem> {
    await this.requireWriter(caller, update.sessionId, WRITE_ROLES);
    const existing = await this.repo.getWorkItem(update.workItemId);
    if (!existing || existing.sessionId !== update.sessionId) {
      throw new CollaborationTargetNotFoundError("Work item not found");
    }
    if (
      update.assigneeUserId !== undefined &&
      update.assigneeUserId !== existing.assigneeUserId
    ) {
      await this.assertAssignable(
        caller,
        update.sessionId,
        update.assigneeUserId
      );
    }
    const changes: {
      title?: string;
      description?: string;
      status?: WorkItemStatus;
      assigneeUserId?: string;
      dueAt?: string;
    } = {};
    if (update.title !== undefined) changes.title = update.title;
    if (update.description !== undefined)
      changes.description = update.description;
    if (update.status !== undefined) changes.status = update.status;
    if (update.assigneeUserId !== undefined)
      changes.assigneeUserId = update.assigneeUserId;
    if (update.dueAt !== undefined) changes.dueAt = update.dueAt;

    const updated = await this.repo.updateWorkItem({
      workItemId: update.workItemId,
      changes,
      expectedVersion: update.expectedVersion,
      event: {
        correlationId: update.sessionId,
        type:
          update.status === "completed"
            ? "WORK_ITEM_COMPLETED"
            : "WORK_ITEM_UPDATED",
        payload: {
          workItemId: update.workItemId,
          status: update.status ?? existing.status,
          updatedBy: caller.name
        }
      }
    });
    if (!updated) {
      throw new CollaborationConflictError(
        "This work item was modified by someone else; please reload and retry"
      );
    }
    return updated;
  }

  private async assertAssignable(
    _caller: CollaborationCaller,
    sessionId: string,
    userId: string
  ): Promise<void> {
    const ownerUserId = await this.repo.getSessionOwnerUserId(sessionId);
    if (ownerUserId !== null && ownerUserId === userId) return;
    const membership = await this.repo.getLiveMembership(sessionId, userId);
    if (!membership || membership.status !== "active") {
      throw new CollaborationBadRequestError(
        "The assignee must be an active member of this research"
      );
    }
  }

  // ----- Comments ------------------------------------------------------------

  async listComments(
    caller: CollaborationCaller,
    sessionId: string,
    targetType: string,
    targetId: string
  ): Promise<Comment[]> {
    await this.requireReader(caller, sessionId);
    return this.repo.listComments(sessionId, targetType, targetId);
  }

  /**
   * Create a comment. Owner/editor/reviewer only. The author is taken from the
   * caller (never the body), so a comment cannot be forged as another person.
   */
  async createComment(
    caller: CollaborationCaller,
    draft: CommentDraft
  ): Promise<Comment> {
    await this.requireWriter(caller, draft.sessionId, COMMENT_ROLES);
    if (draft.parentCommentId) {
      const parent = await this.repo.getComment(draft.parentCommentId);
      if (
        !parent ||
        parent.sessionId !== draft.sessionId ||
        parent.targetType !== draft.targetType ||
        parent.targetId !== draft.targetId
      ) {
        throw new CollaborationBadRequestError(
          "The parent comment does not belong to this target"
        );
      }
    }
    return this.repo.createComment({
      sessionId: draft.sessionId,
      draft,
      authorUserId: caller.userId,
      event: {
        correlationId: draft.sessionId,
        type: "COMMENT_CREATED",
        payload: {
          targetType: draft.targetType,
          targetId: draft.targetId,
          authorUserId: caller.userId
        }
      }
    });
  }

  /** Soft-delete a comment. Only the author may delete their own comment. */
  async deleteComment(
    caller: CollaborationCaller,
    sessionId: string,
    commentId: string,
    expectedVersion: number
  ): Promise<Comment> {
    await this.requireReader(caller, sessionId);
    const comment = await this.repo.getComment(commentId);
    if (!comment || comment.sessionId !== sessionId) {
      throw new CollaborationTargetNotFoundError("Comment not found");
    }
    if (
      !caller.implicitOperator &&
      comment.authorUserId !== caller.userId
    ) {
      throw new CollaborationForbiddenError(
        "You can only delete your own comments"
      );
    }
    const deleted = await this.repo.softDeleteComment(
      commentId,
      expectedVersion,
      {
        correlationId: sessionId,
        type: "COMMENT_DELETED",
        payload: { commentId, deletedBy: caller.name }
      }
    );
    if (!deleted) {
      throw new CollaborationConflictError(
        "This comment was modified by someone else; please reload and retry"
      );
    }
    return deleted;
  }

  // ----- Review requests -----------------------------------------------------

  async listReviewRequests(
    caller: CollaborationCaller,
    sessionId: string
  ): Promise<ReviewRequest[]> {
    await this.requireReader(caller, sessionId);
    return this.repo.listReviewRequests(sessionId);
  }

  /**
   * Create a review request. Owner/editor/reviewer may request; a request
   * directed at a specific reviewer cannot name the requester (no self-review),
   * and the named reviewer must be a collaborator.
   */
  async createReviewRequest(
    caller: CollaborationCaller,
    draft: ReviewRequestDraft
  ): Promise<ReviewRequest> {
    await this.requireWriter(caller, draft.sessionId, COMMENT_ROLES);
    if (
      draft.requestedReviewerUserId &&
      draft.requestedReviewerUserId === caller.userId
    ) {
      throw new CollaborationBadRequestError(
        "You cannot request a review from yourself"
      );
    }
    if (draft.requestedReviewerUserId) {
      await this.assertAssignable(
        caller,
        draft.sessionId,
        draft.requestedReviewerUserId
      );
    }
    return this.repo.createReviewRequest({
      sessionId: draft.sessionId,
      draft,
      requestedBy: caller.userId,
      event: {
        correlationId: draft.sessionId,
        type: "REVIEW_REQUEST_CREATED",
        payload: {
          requestType: draft.requestType,
          targetType: draft.targetType,
          targetId: draft.targetId,
          requestedBy: caller.userId,
          requestedReviewerUserId: draft.requestedReviewerUserId ?? null
        }
      }
    });
  }

  /**
   * Claim an open review request. Any active collaborator except the requester
   * may claim; if a specific reviewer was named, only they may.
   */
  async claimReviewRequest(
    caller: CollaborationCaller,
    sessionId: string,
    reviewRequestId: string
  ): Promise<ReviewRequest> {
    await this.requireReader(caller, sessionId);
    const request = await this.repo.getReviewRequest(reviewRequestId);
    if (!request || request.sessionId !== sessionId) {
      throw new CollaborationTargetNotFoundError("Review request not found");
    }
    if (request.requestedBy === caller.userId) {
      throw new CollaborationBadRequestError(
        "You cannot review a request you created"
      );
    }
    if (
      request.requestedReviewerUserId &&
      request.requestedReviewerUserId !== caller.userId
    ) {
      throw new CollaborationForbiddenError(
        "This review request was assigned to another reviewer"
      );
    }
    const claimed = await this.repo.claimReviewRequest(
      reviewRequestId,
      caller.userId,
      request.version,
      {
        correlationId: sessionId,
        type: "REVIEW_REQUEST_ASSIGNED",
        payload: {
          reviewRequestId,
          assignedReviewerUserId: caller.userId
        }
      }
    );
    if (!claimed) {
      throw new CollaborationConflictError(
        "This review request was modified by someone else; please reload and retry"
      );
    }
    return claimed;
  }

  /**
   * Decide a review request. Only the assigned reviewer may decide. The
   * decision is a human sign-off on the artifact — it never writes a claim
   * verdict or a verification status; formal verification still goes through
   * the evidence-verification API.
   */
  async decideReviewRequest(
    caller: CollaborationCaller,
    decision: ReviewRequestDecision
  ): Promise<ReviewRequest> {
    const request = await this.repo.getReviewRequest(decision.reviewRequestId);
    if (!request || request.sessionId !== decision.sessionId) {
      throw new CollaborationTargetNotFoundError("Review request not found");
    }
    await this.requireReader(caller, decision.sessionId);
    if (
      !caller.implicitOperator &&
      request.assignedReviewerUserId !== caller.userId
    ) {
      throw new CollaborationForbiddenError(
        "Only the assigned reviewer may decide this request"
      );
    }
    const decided = await this.repo.decideReviewRequest(
      decision.reviewRequestId,
      decision.decision as ReviewDecision,
      caller.name,
      decision.expectedVersion,
      {
        correlationId: decision.sessionId,
        type: "REVIEW_REQUEST_DECIDED",
        payload: {
          reviewRequestId: decision.reviewRequestId,
          decision: decision.decision,
          decidedBy: caller.name
        }
      }
    );
    if (!decided) {
      throw new CollaborationConflictError(
        "This review request was modified by someone else; please reload and retry"
      );
    }
    return decided;
  }

  /** Cancel an open review request. The requester or an owner may cancel. */
  async cancelReviewRequest(
    caller: CollaborationCaller,
    sessionId: string,
    reviewRequestId: string
  ): Promise<ReviewRequest> {
    const ctx = await this.requireReader(caller, sessionId);
    const request = await this.repo.getReviewRequest(reviewRequestId);
    if (!request || request.sessionId !== sessionId) {
      throw new CollaborationTargetNotFoundError("Review request not found");
    }
    const isOwner =
      ctx.isPlatformOwner || ctx.role === "owner";
    if (request.requestedBy !== caller.userId && !isOwner) {
      throw new CollaborationForbiddenError(
        "Only the requester or the research owner may cancel this request"
      );
    }
    const cancelled = await this.repo.cancelReviewRequest(
      reviewRequestId,
      request.version,
      {
        correlationId: sessionId,
        type: "REVIEW_REQUEST_CANCELLED",
        payload: { reviewRequestId, cancelledBy: caller.name }
      }
    );
    if (!cancelled) {
      throw new CollaborationConflictError(
        "This review request was modified by someone else; please reload and retry"
      );
    }
    return cancelled;
  }

  // ----- Activity ------------------------------------------------------------

  /** The collaboration activity feed, projected from `executionEvents`. */
  async listActivity(
    caller: CollaborationCaller,
    sessionId: string
  ): Promise<CollaborationActivity[]> {
    await this.requireReader(caller, sessionId);
    return this.repo.listActivity(sessionId, COLLABORATION_EVENT_TYPES);
  }
}
