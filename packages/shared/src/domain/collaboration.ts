import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

/**
 * Team collaboration & human review workflow.
 *
 * A session-scoped collaboration axis, distinct from the platform-wide
 * `owner`/`reviewer`/`viewer` roles. The platform roles answer "what may this
 * account do to the deployment"; these roles answer "what may this person do
 * to *this research*". They are layered, never merged: a session owner is the
 * person who created the research (the `decision_sessions.owner_user_id`
 * column), and `owner` here is the top of the per-session collaboration
 * hierarchy. No global platform role is added, so the two systems cannot
 * accidentally collide or be escalated across.
 *
 * Everything here is stored in `research_` tables keyed by `session_id`, so a
 * row never crosses the session boundary. The closed sets on every
 * status-like column are enforced by CHECK constraints in migration 0019; the
 * zod enums below mirror them so the API rejects the same values the database
 * would, and the two can never drift without a test failing.
 */

/** The four collaboration roles inside one research. */
export const CollaborationRoleSchema = z.enum([
  "owner",
  "editor",
  "reviewer",
  "viewer"
]);
export type CollaborationRole = z.infer<typeof CollaborationRoleSchema>;

/** Lifecycle of a membership row. */
export const MembershipStatusSchema = z.enum([
  "pending",
  "active",
  "declined",
  "removed"
]);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

/** Lifecycle of a work item. */
export const WorkItemStatusSchema = z.enum([
  "open",
  "in_progress",
  "in_review",
  "completed",
  "cancelled"
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

/**
 * What a work item points at. Empty means a free-form task; otherwise it is a
 * pointer at an existing research artifact, so the collaboration layer assigns
 * and tracks without re-modelling the work itself.
 */
export const WorkItemTargetTypeSchema = z.enum([
  "plan_item",
  "revalidation_task",
  "evidence_gap",
  "source_monitor_task",
  "agent_run",
  "work_item"
]);
export type WorkItemTargetType = z.infer<typeof WorkItemTargetTypeSchema>;

/** What a comment is attached to. */
export const CommentTargetTypeSchema = z.enum([
  "claim",
  "evidence",
  "source",
  "conflict",
  "challenge",
  "plan_item",
  "revalidation_task",
  "report_snapshot",
  "work_item"
]);
export type CommentTargetType = z.infer<typeof CommentTargetTypeSchema>;

/** What kind of human review is being requested. */
export const ReviewRequestTypeSchema = z.enum([
  "claim_review",
  "source_review",
  "report_review",
  "conflict_review"
]);
export type ReviewRequestType = z.infer<typeof ReviewRequestTypeSchema>;

/** What a review request points at. */
export const ReviewRequestTargetTypeSchema = z.enum([
  "claim",
  "evidence",
  "source",
  "conflict",
  "report_snapshot"
]);
export type ReviewRequestTargetType = z.infer<
  typeof ReviewRequestTargetTypeSchema
>;

/** Lifecycle of a review request. */
export const ReviewRequestStatusSchema = z.enum([
  "open",
  "in_review",
  "completed",
  "cancelled"
]);
export type ReviewRequestStatus = z.infer<typeof ReviewRequestStatusSchema>;

/** The reviewer's verdict on a review request. */
export const ReviewDecisionSchema = z.enum(["approved", "rejected"]);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

/**
 * 枚举的中文说法，放在枚举旁边。
 *
 * 两处都要用：审核表单的下拉框，和消息中心派生出来的卡片文案。各写一份的
 * 结果是同一个 `report_review` 在列表里叫「报告审核」、在消息里叫「报告评审」
 * ——两个词指一件事，读的人会以为这是两件事。
 *
 * 取值函数接受 `string` 而不是枚举类型：这些列在库里的类型是 `text`，模型层
 * 没有约束，真库里完全可能有一个界面还不认识的取值。那时把原值显示出来，
 * 比渲染成空白要好——一行消失比一行难看更糟。
 */
export const REVIEW_REQUEST_TYPE_LABELS: Record<ReviewRequestType, string> = {
  claim_review: "主张审核",
  source_review: "来源审核",
  report_review: "报告审核",
  conflict_review: "冲突审核"
};

export function reviewRequestTypeLabel(value: string): string {
  return value in REVIEW_REQUEST_TYPE_LABELS
    ? REVIEW_REQUEST_TYPE_LABELS[value as ReviewRequestType]
    : value;
}

export const COMMENT_TARGET_TYPE_LABELS: Record<CommentTargetType, string> = {
  claim: "主张",
  evidence: "证据",
  source: "来源",
  conflict: "冲突",
  challenge: "质疑",
  plan_item: "计划项",
  revalidation_task: "复核任务",
  report_snapshot: "报告快照",
  work_item: "任务"
};

export function commentTargetTypeLabel(value: string): string {
  return value in COMMENT_TARGET_TYPE_LABELS
    ? COMMENT_TARGET_TYPE_LABELS[value as CommentTargetType]
    : value;
}

/** A team member as returned by the API: a membership row made legible. */
export const TeamMemberSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  userId: z.string().min(1).max(120),
  role: CollaborationRoleSchema,
  status: MembershipStatusSchema,
  invitedBy: z.string().min(1).max(120),
  invitedAt: TimestampSchema,
  joinedAt: TimestampSchema.optional(),
  statusChangedAt: TimestampSchema,
  removedBy: z.string().min(1).max(120).optional(),
  removeReason: z.string().max(1000).optional(),
  version: z.number().int().nonnegative(),
  createdAt: TimestampSchema
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

/** Invite a user into the research with a role. */
export const TeamMemberInviteSchema = z.object({
  sessionId: IdSchema,
  userId: z.string().min(1).max(120),
  role: CollaborationRoleSchema
});
export type TeamMemberInvite = z.infer<typeof TeamMemberInviteSchema>;

/** Change an existing member's role. */
export const TeamMemberRoleChangeSchema = z.object({
  sessionId: IdSchema,
  userId: z.string().min(1).max(120),
  role: CollaborationRoleSchema
});
export type TeamMemberRoleChange = z.infer<typeof TeamMemberRoleChangeSchema>;

/** Remove a member, recording who and why. */
export const TeamMemberRemovalSchema = z.object({
  sessionId: IdSchema,
  userId: z.string().min(1).max(120),
  reason: z.string().trim().min(1).max(1000)
});
export type TeamMemberRemoval = z.infer<typeof TeamMemberRemovalSchema>;

/** A work item as returned by the API. */
export const WorkItemSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  title: z.string().min(1).max(240),
  description: z.string().max(5000).optional(),
  status: WorkItemStatusSchema,
  assigneeUserId: z.string().min(1).max(120).optional(),
  targetType: WorkItemTargetTypeSchema.optional(),
  targetId: z.string().min(1).max(120).optional(),
  createdBy: z.string().min(1).max(120),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  completedAt: TimestampSchema.optional(),
  dueAt: TimestampSchema.optional(),
  version: z.number().int().nonnegative()
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

/** Create a work item. */
export const WorkItemDraftSchema = z.object({
  sessionId: IdSchema,
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(5000).optional(),
  assigneeUserId: z.string().min(1).max(120).optional(),
  targetType: WorkItemTargetTypeSchema.optional(),
  targetId: z.string().min(1).max(120).optional(),
  dueAt: TimestampSchema.optional()
});
export type WorkItemDraft = z.infer<typeof WorkItemDraftSchema>;

/** Mutate a work item. Every field optional; `expectedVersion` makes the
 * update conditional so two writers cannot silently overwrite each other. */
export const WorkItemUpdateSchema = z.object({
  sessionId: IdSchema,
  workItemId: IdSchema,
  title: z.string().trim().min(1).max(240).optional(),
  description: z.string().trim().max(5000).optional(),
  status: WorkItemStatusSchema.optional(),
  assigneeUserId: z.string().min(1).max(120).optional(),
  dueAt: TimestampSchema.optional(),
  expectedVersion: z.number().int().nonnegative()
});
export type WorkItemUpdate = z.infer<typeof WorkItemUpdateSchema>;

/** A comment as returned by the API. Soft-deleted comments keep their row. */
export const CommentSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  authorUserId: z.string().min(1).max(120),
  body: z.string().min(1).max(5000),
  targetType: CommentTargetTypeSchema,
  targetId: z.string().min(1).max(120),
  parentCommentId: IdSchema.optional(),
  deletedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int().nonnegative()
});
export type Comment = z.infer<typeof CommentSchema>;

/** Create a comment. `authorUserId` is never taken from this; the service
 * overwrites it from the caller identity, so a forged author is impossible. */
export const CommentDraftSchema = z.object({
  sessionId: IdSchema,
  body: z.string().trim().min(1).max(5000),
  targetType: CommentTargetTypeSchema,
  targetId: z.string().min(1).max(120),
  parentCommentId: IdSchema.optional()
});
export type CommentDraft = z.infer<typeof CommentDraftSchema>;

/** A review request as returned by the API. */
export const ReviewRequestSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  requestType: ReviewRequestTypeSchema,
  targetType: ReviewRequestTargetTypeSchema,
  targetId: z.string().min(1).max(120),
  requestedBy: z.string().min(1).max(120),
  requestedReviewerUserId: z.string().min(1).max(120).optional(),
  status: ReviewRequestStatusSchema,
  assignedReviewerUserId: z.string().min(1).max(120).optional(),
  decision: ReviewDecisionSchema.optional(),
  decidedBy: z.string().min(1).max(120).optional(),
  decidedAt: TimestampSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  version: z.number().int().nonnegative()
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

/** Create a review request. */
export const ReviewRequestDraftSchema = z.object({
  sessionId: IdSchema,
  requestType: ReviewRequestTypeSchema,
  targetType: ReviewRequestTargetTypeSchema,
  targetId: z.string().min(1).max(120),
  requestedReviewerUserId: z.string().min(1).max(120).optional()
});
export type ReviewRequestDraft = z.infer<typeof ReviewRequestDraftSchema>;

/** Decide a review request. The decision is a human sign-off on the artifact,
 * not a claim verdict and not a verification status — formal verification
 * still goes through the evidence-verification API. */
export const ReviewRequestDecisionSchema = z.object({
  sessionId: IdSchema,
  reviewRequestId: IdSchema,
  decision: ReviewDecisionSchema,
  expectedVersion: z.number().int().nonnegative()
});
export type ReviewRequestDecision = z.infer<typeof ReviewRequestDecisionSchema>;

/**
 * Activity feed item. Projected from `executionEvents` (which is reused, not
 * duplicated): collaboration writes its own event types and the feed filters
 * for them, so the audit trail is one table for the whole session.
 */
export const CollaborationActivitySchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  sequence: z.number().int().nonnegative(),
  correlationId: IdSchema,
  type: z.string(),
  payload: z.record(z.unknown()),
  occurredAt: TimestampSchema
});
export type CollaborationActivity = z.infer<typeof CollaborationActivitySchema>;

/** Event types collaboration writes into `executionEvents`. */
export const COLLABORATION_EVENT_TYPES = [
  "MEMBER_INVITED",
  "MEMBER_JOINED",
  "MEMBER_DECLINED",
  "MEMBER_ROLE_CHANGED",
  "MEMBER_REMOVED",
  "WORK_ITEM_CREATED",
  "WORK_ITEM_UPDATED",
  "WORK_ITEM_COMPLETED",
  "COMMENT_CREATED",
  "COMMENT_DELETED",
  "REVIEW_REQUEST_CREATED",
  "REVIEW_REQUEST_ASSIGNED",
  "REVIEW_REQUEST_DECIDED",
  "REVIEW_REQUEST_CANCELLED"
] as const;
export type CollaborationEventType =
  (typeof COLLABORATION_EVENT_TYPES)[number];
