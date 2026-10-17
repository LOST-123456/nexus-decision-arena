"use client";

import { useCallback, useEffect, useState } from "react";
import { getCurrentUser, type AuthUser } from "../arena/api-client";
import { ConfirmDialog } from "../../components/ui/dialog";
import { Notice } from "../../components/ui/notice";
import { formatDateTime } from "./labels";
import {
  acceptCollaborationInvitation,
  cancelCollaborationReviewRequest,
  changeCollaborationRole,
  claimCollaborationReviewRequest,
  CollaborationFailedError,
  createCollaborationComment,
  createCollaborationReviewRequest,
  createCollaborationWorkItem,
  declineCollaborationInvitation,
  decideCollaborationReviewRequest,
  deleteCollaborationComment,
  inviteCollaborationMember,
  listCollaborationActivity,
  listCollaborationComments,
  listCollaborationMembers,
  listCollaborationReviewRequests,
  listCollaborationWorkItems,
  removeCollaborationMember,
  updateCollaborationWorkItem
} from "./api";
import type {
  CollaborationActivity,
  Comment,
  ReviewDecision,
  ReviewRequest,
  ReviewRequestTargetType,
  ReviewRequestType,
  TeamMember,
  TeamMemberRole,
  WorkItem,
  WorkItemStatus
} from "./api";

/**
 * The team collaboration & human-review surface for one research.
 *
 * Five views over the same session-scoped collaboration axis — members, work
 * items, comments, review requests and the shared activity trail. The roles
 * here (owner/editor/reviewer/viewer) are *per-research* and layered on top of
 * the platform's global owner/reviewer/viewer, so a viewer of this research
 * reads everything but writes nothing, an editor manages the work, and a
 * reviewer may comment and sign off reviews — none of it bleeds into the
 * platform's own access control. The server is the record of who may do what;
 * the UI only hides a control it already knows the caller cannot use, and a
 * stray refusal still surfaces as a message rather than a silent failure.
 */

type SubTab = "members" | "work" | "comments" | "review" | "activity";

const ROLE_LABELS: Record<TeamMemberRole, string> = {
  owner: "负责人",
  editor: "编辑",
  reviewer: "审核者",
  viewer: "只读"
};

const REQUEST_TYPE_LABELS: Record<ReviewRequestType, string> = {
  claim_review: "主张审核",
  source_review: "来源审核",
  report_review: "报告审核",
  conflict_review: "冲突审核"
};

/**
 * The audit trail shares one `execution_events` table with the research
 * material, so its rows arrive wearing the machine's own type names. Printing
 * "COMMENT_DELETED" at a reader is a leak rather than a feature; an unknown
 * type still shows itself instead of silently vanishing, because a row that
 * disappears is worse than a row that is ugly.
 */
const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  MEMBER_INVITED: "邀请成员",
  MEMBER_JOINED: "成员接受邀请",
  MEMBER_DECLINED: "成员拒绝邀请",
  MEMBER_ROLE_CHANGED: "修改成员角色",
  MEMBER_REMOVED: "移除成员",
  WORK_ITEM_CREATED: "创建研究任务",
  COMMENT_CREATED: "发表评论",
  COMMENT_DELETED: "删除评论",
  REVIEW_REQUEST_CREATED: "发起审核请求",
  REVIEW_REQUEST_ASSIGNED: "认领审核",
  REVIEW_REQUEST_DECIDED: "审核结论",
  REVIEW_REQUEST_CANCELLED: "取消审核请求"
};

const STATUS_LABELS: Record<string, string> = {
  pending: "待接受",
  active: "已加入",
  declined: "已拒绝",
  removed: "已移除",
  open: "待认领",
  in_progress: "进行中",
  in_review: "审核中",
  completed: "已完成",
  cancelled: "已取消",
  approved: "通过",
  rejected: "驳回"
};

export type CollaborationPanelProps = {
  sessionId: string;
  /**
   * False for a read-only account. Omitted means "ask the server who is signed
   * in": a page that does not know the role must not offer controls the account
   * may not use, and discovering that by a refused request is a worse answer
   * than not offering them.
   */
  canEdit?: boolean | undefined;
  /** Called after the collaboration actually changed; the workspace reloads. */
  onChanged?: (() => void | Promise<void>) | undefined;
};

export function CollaborationPanel({
  sessionId,
  canEdit,
  onChanged
}: CollaborationPanelProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [reviewRequests, setReviewRequests] = useState<ReviewRequest[]>([]);
  const [activity, setActivity] = useState<CollaborationActivity[]>([]);
  const [comments, setComments] = useState<Comment[]>([]);
  const [subTab, setSubTab] = useState<SubTab>("members");

  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Comment target, chosen by the reader so a thread can sit on any artifact.
  const [commentTargetType, setCommentTargetType] = useState<string>("claim");
  const [commentTargetId, setCommentTargetId] = useState<string>("claim-demo");

  // Inline "remove member" reason, keyed by member userId.
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState("");

  const allowsEdit = canEdit ?? (user === null || user.role !== "viewer");

  // The caller's per-research role is derived from the membership row the
  // server knows about. The platform owner has no membership row here — they
  // are the owner by virtue of owning the session — so "no active row for the
  // signed-in user" means owner, never a stranger (a stranger cannot load the
  // panel at all: that is a 404).
  const myMember = members.find(
    (m) => m.userId === user?.id && m.status === "active"
  );
  const isPlatformOwner = myMember === undefined && user !== null;
  const myRole: TeamMemberRole = myMember ? myMember.role : "owner";
  const isOwner = myMember?.role === "owner" || isPlatformOwner;
  const canManageMembers = isOwner;
  const canWriteWorkItems = isOwner || myRole === "editor";
  const canComment = isOwner || myRole === "editor" || myRole === "reviewer";
  const isExplicitViewer = myRole === "viewer" && myMember !== undefined;
  const readOnly = !allowsEdit || isExplicitViewer;

  const reloadMembers = useCallback(async () => {
    const response = await listCollaborationMembers(sessionId);
    setMembers(response.members);
    return response.members;
  }, [sessionId]);

  const reloadWork = useCallback(async () => {
    const response = await listCollaborationWorkItems(sessionId);
    setWorkItems(response.workItems);
    return response.workItems;
  }, [sessionId]);

  const reloadReviews = useCallback(async () => {
    const response = await listCollaborationReviewRequests(sessionId);
    setReviewRequests(response.reviewRequests);
    return response.reviewRequests;
  }, [sessionId]);

  const reloadActivity = useCallback(async () => {
    const response = await listCollaborationActivity(sessionId);
    setActivity(response.activity);
    return response.activity;
  }, [sessionId]);

  const reloadComments = useCallback(async () => {
    if (!commentTargetType.trim() || !commentTargetId.trim()) {
      setComments([]);
      return [];
    }
    const response = await listCollaborationComments(
      sessionId,
      commentTargetType,
      commentTargetId
    );
    setComments(response.comments);
    return response.comments;
  }, [sessionId, commentTargetType, commentTargetId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await getCurrentUser().catch(() => null);
        if (cancelled) return;
        setUser(current ?? null);
        await reloadMembers();
        await reloadWork();
        await reloadReviews();
        await reloadActivity();
        if (cancelled) return;
      } catch (cause) {
        if (!cancelled) {
          setLoadError(
            cause instanceof CollaborationFailedError && cause.status === 404
              ? "你不是该研究的协作者，无法查看团队协作。"
              : cause instanceof Error
                ? cause.message
                : "团队协作加载失败"
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    if (subTab === "comments") {
      void reloadComments();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subTab, commentTargetType, commentTargetId, sessionId]);

  const run = useCallback(
    async (action: () => Promise<unknown>, label: string): Promise<boolean> => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await action();
        return true;
      } catch (cause) {
        setError(
          cause instanceof CollaborationFailedError
            ? `${label}失败（${cause.status}）：${cause.message}`
            : cause instanceof Error
              ? `${label}失败：${cause.message}`
              : `${label}失败`
        );
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const afterChange = useCallback(async () => {
    await reloadMembers();
    await reloadWork();
    await reloadReviews();
    await reloadActivity();
    if (subTab === "comments") await reloadComments();
    if (onChanged) await onChanged();
  }, [
    reloadMembers,
    reloadWork,
    reloadReviews,
    reloadActivity,
    reloadComments,
    onChanged,
    subTab
  ]);

  if (loadError) {
    return (
      <div className="research-column">
        <Notice
          eyebrow="COLLABORATION / 读取失败"
          title="无法读取团队协作"
          reason={loadError}
          hint="成员、任务、讨论与审核记录都在 core 服务里；重试会重新读取，不会改变任何数据。"
          role="alert"
          testId="collab-load-error"
          actions={
            <button
              type="button"
              className="workspace-retry"
              onClick={() => {
                setLoadError(null);
                void (async () => {
                  try {
                    const current = await getCurrentUser().catch(() => null);
                    setUser(current);
                    await reloadMembers();
                    await reloadWork();
                    await reloadReviews();
                    await reloadActivity();
                  } catch (cause) {
                    setLoadError(
                      cause instanceof CollaborationFailedError &&
                        cause.status === 404
                        ? "你不是该研究的协作者，无法查看团队协作。"
                        : cause instanceof Error
                          ? cause.message
                          : "团队协作加载失败"
                    );
                  }
                })();
              }}
            >
              重试
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="research-column" data-testid="collaboration-panel">
      <div className="research-panel">
        <div className="research-panel-head">
          <span className="research-panel-title">团队协作</span>
          <span className="research-muted">
            {readOnly
              ? "你在该研究中为只读角色，可以查看成员、任务、讨论、审核与活动，但不能修改。"
              : `你的角色：${ROLE_LABELS[myRole]}（每研究独立，区别于平台全局角色）`}
          </span>
        </div>
        <div className="research-tabs" role="tablist" aria-label="协作子面板">
          <button
            type="button"
            role="tab"
            className="research-tab"
            aria-selected={subTab === "members"}
            data-testid="collab-tab-members"
            onClick={() => setSubTab("members")}
          >
            团队
          </button>
          <button
            type="button"
            role="tab"
            className="research-tab"
            aria-selected={subTab === "work"}
            data-testid="collab-tab-work"
            onClick={() => setSubTab("work")}
          >
            任务
          </button>
          <button
            type="button"
            role="tab"
            className="research-tab"
            aria-selected={subTab === "comments"}
            data-testid="collab-tab-comments"
            onClick={() => setSubTab("comments")}
          >
            讨论
          </button>
          <button
            type="button"
            role="tab"
            className="research-tab"
            aria-selected={subTab === "review"}
            data-testid="collab-tab-review"
            onClick={() => setSubTab("review")}
          >
            审核
          </button>
          <button
            type="button"
            role="tab"
            className="research-tab"
            aria-selected={subTab === "activity"}
            data-testid="collab-tab-activity"
            onClick={() => setSubTab("activity")}
          >
            活动
          </button>
        </div>
      </div>

      {message ? (
        <p className="research-muted" data-testid="collab-message" role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className="research-error" data-testid="collab-error" role="alert">
          {error}
        </p>
      ) : null}

      {subTab === "members" ? (
        <MembersView
          sessionId={sessionId}
          members={members}
          user={user}
          myUserId={user?.id ?? null}
          canManageMembers={canManageMembers && !readOnly}
          busy={busy}
          run={run}
          afterChange={afterChange}
          onMessage={setMessage}
          onError={setError}
          removing={removing}
          setRemoving={setRemoving}
          removeReason={removeReason}
          setRemoveReason={setRemoveReason}
        />
      ) : null}

      {subTab === "work" ? (
        <WorkItemsView
          sessionId={sessionId}
          workItems={workItems}
          members={members}
          canWrite={canWriteWorkItems && !readOnly}
          busy={busy}
          run={run}
          afterChange={afterChange}
        />
      ) : null}

      {subTab === "comments" ? (
        <CommentsView
          sessionId={sessionId}
          comments={comments}
          targetType={commentTargetType}
          targetId={commentTargetId}
          setTargetType={setCommentTargetType}
          setTargetId={setCommentTargetId}
          myUserId={user?.id ?? null}
          canComment={canComment && !readOnly}
          busy={busy}
          run={run}
          afterChange={afterChange}
        />
      ) : null}

      {subTab === "review" ? (
        <ReviewRequestsView
          sessionId={sessionId}
          reviewRequests={reviewRequests}
          myUserId={user?.id ?? null}
          canCreate={canComment && !readOnly}
          busy={busy}
          run={run}
          afterChange={afterChange}
        />
      ) : null}

      {subTab === "activity" ? (
        <ActivityView activity={activity} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Members
 * ------------------------------------------------------------------ */

function MembersView({
  sessionId,
  members,
  user,
  myUserId,
  canManageMembers,
  busy,
  run,
  afterChange,
  onMessage,
  onError,
  removing,
  setRemoving,
  removeReason,
  setRemoveReason
}: {
  sessionId: string;
  members: TeamMember[];
  user: AuthUser | null;
  myUserId: string | null;
  canManageMembers: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>, label: string) => Promise<boolean>;
  afterChange: () => Promise<void>;
  onMessage: (value: string | null) => void;
  onError: (value: string | null) => void;
  removing: string | null;
  setRemoving: (value: string | null) => void;
  removeReason: string;
  setRemoveReason: (value: string) => void;
}) {
  const [inviteUserId, setInviteUserId] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "reviewer" | "viewer">(
    "reviewer"
  );

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!inviteUserId.trim()) return;
    const ok = await run(async () => {
      await inviteCollaborationMember(sessionId, {
        userId: inviteUserId.trim(),
        role: inviteRole
      });
      onMessage(`已邀请 ${inviteUserId.trim()} 作为${ROLE_LABELS[inviteRole]}。`);
      setInviteUserId("");
      await afterChange();
    }, "邀请成员");
    if (!ok) onError(null);
  };

  const accept = async (member: TeamMember) => {
    const ok = await run(async () => {
      await acceptCollaborationInvitation(member.sessionId, member.userId);
      onMessage(`${member.userId} 已接受邀请。`);
      await afterChange();
    }, "接受邀请");
    if (!ok) onError(null);
  };

  const decline = async (member: TeamMember) => {
    const ok = await run(async () => {
      await declineCollaborationInvitation(member.sessionId, member.userId);
      onMessage(`${member.userId} 已拒绝邀请。`);
      await afterChange();
    }, "拒绝邀请");
    if (!ok) onError(null);
  };

  const changeRole = async (
    member: TeamMember,
    role: Exclude<TeamMemberRole, "owner">
  ) => {
    if (role === member.role) return;
    const ok = await run(async () => {
      await changeCollaborationRole(member.sessionId, member.userId, role);
      onMessage(`已将 ${member.userId} 的角色改为${ROLE_LABELS[role]}。`);
      await afterChange();
    }, "修改角色");
    if (!ok) onError(null);
  };

  const confirmRemove = async (member: TeamMember) => {
    if (!removeReason.trim()) {
      onError("请填写移除原因。");
      return;
    }
    const ok = await run(async () => {
      await removeCollaborationMember(
        member.sessionId,
        member.userId,
        removeReason.trim()
      );
      onMessage(`已移除 ${member.userId}（原因已记录）。`);
      setRemoving(null);
      setRemoveReason("");
      await afterChange();
    }, "移除成员");
    if (!ok) onError(null);
  };

  return (
    <section className="research-panel" data-testid="collab-members">
      <div className="research-panel-head">
        <span className="research-panel-title">团队成员（{members.length}）</span>
      </div>
      {canManageMembers ? (
        <form className="research-form" onSubmit={invite} data-testid="collab-invite-form">
          <div className="research-field">
            <label className="research-label" htmlFor="collab-invite-user">
              邀请账号
            </label>
            <input
              id="collab-invite-user"
              className="research-input"
              data-testid="collab-invite-user"
              value={inviteUserId}
              onChange={(event) => setInviteUserId(event.target.value)}
              placeholder="用户名或账号 ID"
            />
          </div>
          <div className="research-field">
            <label className="research-label" htmlFor="collab-invite-role">
              角色
            </label>
            <select
              id="collab-invite-role"
              className="research-input"
              data-testid="collab-invite-role"
              value={inviteRole}
              onChange={(event) =>
                setInviteRole(
                  event.target.value as "editor" | "reviewer" | "viewer"
                )
              }
            >
              <option value="editor">编辑</option>
              <option value="reviewer">审核者</option>
              <option value="viewer">只读</option>
            </select>
            <span className="research-muted">
              协作角色不能授予「负责人」：研究负责人由平台决定，API 不会提升所有权。
            </span>
          </div>
          <button
            className="research-button"
            type="submit"
            data-testid="collab-invite-submit"
            disabled={busy}
          >
            邀请
          </button>
        </form>
      ) : null}

      <div className="research-table-scroll">
        <table className="research-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>角色</th>
              <th>状态</th>
              <th>邀请人</th>
              <th>版本</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isSelf = member.userId === myUserId;
              const canActOnThis =
                canManageMembers && !isSelf && member.status === "active";
              return (
                <tr key={member.id} data-testid="collab-member">
                  <td>
                    <span className="research-source-title">{member.userId}</span>
                    {isSelf ? (
                      <span className="research-pill research-pill-neutral">（你）</span>
                    ) : null}
                  </td>
                  <td>
                    <span className="research-pill research-pill-neutral">
                      {ROLE_LABELS[member.role]}
                    </span>
                  </td>
                  <td>{STATUS_LABELS[member.status] ?? member.status}</td>
                  <td className="research-muted">{member.invitedBy}</td>
                  <td className="research-muted">{member.version}</td>
                  <td>
                    {member.status === "pending" && isSelf ? (
                      <>
                        <button
                          className="research-button"
                          type="button"
                          data-testid={`collab-accept-${member.userId}`}
                          disabled={busy}
                          onClick={() => void accept(member)}
                        >
                          接受
                        </button>
                        <button
                          className="research-button-secondary"
                          type="button"
                          data-testid={`collab-decline-${member.userId}`}
                          disabled={busy}
                          onClick={() => void decline(member)}
                        >
                          拒绝
                        </button>
                      </>
                    ) : null}
                    {canActOnThis ? (
                      <>
                        <select
                          className="research-input"
                          data-testid={`collab-role-${member.userId}`}
                          value={member.role}
                          disabled={busy}
                          onChange={(event) =>
                            void changeRole(
                              member,
                              event.target.value as Exclude<
                                TeamMemberRole,
                                "owner"
                              >
                            )
                          }
                        >
                          <option value="owner" disabled>
                            负责人
                          </option>
                          <option value="editor">编辑</option>
                          <option value="reviewer">审核者</option>
                          <option value="viewer">只读</option>
                        </select>
                        {removing === member.userId ? (
                          <>
                            <input
                              className="research-input"
                              data-testid={`collab-remove-reason-${member.userId}`}
                              value={removeReason}
                              placeholder="移除原因（必填）"
                              onChange={(event) => setRemoveReason(event.target.value)}
                            />
                            <button
                              className="research-button"
                              type="button"
                              data-testid={`collab-remove-confirm-${member.userId}`}
                              disabled={busy}
                              onClick={() => void confirmRemove(member)}
                            >
                              确认移除
                            </button>
                            <button
                              className="research-button-secondary"
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setRemoving(null);
                                setRemoveReason("");
                              }}
                            >
                              取消
                            </button>
                          </>
                        ) : (
                          <button
                            className="research-button-secondary"
                            type="button"
                            data-testid={`collab-remove-${member.userId}`}
                            disabled={busy}
                            onClick={() => {
                              setRemoving(member.userId);
                              setRemoveReason("");
                            }}
                          >
                            移除
                          </button>
                        )}
                      </>
                    ) : null}
                    {member.status === "removed" && member.removeReason ? (
                      <span className="research-muted">原因：{member.removeReason}</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {members.length === 0 ? (
              <tr>
                <td colSpan={6} className="research-muted">
                  还没有团队成员。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {!canManageMembers && user ? (
        <p className="research-muted">
          只有研究负责人可以管理成员。你的角色（{ROLE_LABELS[memberRoleFromUser(members, user?.id)]}）没有该权限。
        </p>
      ) : null}
    </section>
  );
}

function memberRoleFromUser(
  members: TeamMember[],
  userId: string | null | undefined
): TeamMemberRole {
  if (!userId) return "viewer";
  const self = members.find((m) => m.userId === userId && m.status === "active");
  return self ? self.role : "owner";
}

/* ------------------------------------------------------------------ *
 * Work items
 * ------------------------------------------------------------------ */

function WorkItemsView({
  sessionId,
  workItems,
  members,
  canWrite,
  busy,
  run,
  afterChange
}: {
  sessionId: string;
  workItems: WorkItem[];
  members: TeamMember[];
  canWrite: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>, label: string) => Promise<boolean>;
  afterChange: () => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState("");

  const activeAssignable = members.filter((m) => m.status === "active");

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const ok = await run(async () => {
      await createCollaborationWorkItem(sessionId, {
        title: title.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(assignee.trim() ? { assigneeUserId: assignee.trim() } : {})
      });
      setTitle("");
      setDescription("");
      setAssignee("");
      await afterChange();
    }, "创建任务");
    if (!ok) return;
  };

  const update = async (
    workItem: WorkItem,
    next: {
      status?: WorkItemStatus;
      assigneeUserId?: string;
    }
  ) => {
    const ok = await run(async () => {
      await updateCollaborationWorkItem(workItem.sessionId, workItem.id, {
        ...next,
        expectedVersion: workItem.version
      });
      await afterChange();
    }, "更新任务");
    if (!ok) return;
  };

  return (
    <section className="research-panel" data-testid="collab-work-items">
      <div className="research-panel-head">
        <span className="research-panel-title">研究任务（{workItems.length}）</span>
        <span className="research-muted">
          任务分配给协作者；被指派人必须是本研究的有效成员。
        </span>
      </div>
      {canWrite ? (
        <form className="research-form" onSubmit={create} data-testid="collab-work-form">
          <div className="research-field">
            <label className="research-label" htmlFor="collab-work-title">
              标题
            </label>
            <input
              id="collab-work-title"
              className="research-input"
              data-testid="collab-work-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：核对数据集来源"
            />
          </div>
          <div className="research-field">
            <label className="research-label" htmlFor="collab-work-desc">
              说明
            </label>
            <input
              id="collab-work-desc"
              className="research-input"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="research-field">
            <label className="research-label" htmlFor="collab-work-assignee">
              指派人
            </label>
            <select
              id="collab-work-assignee"
              className="research-input"
              data-testid="collab-work-assignee"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
            >
              <option value="">未指派</option>
              {activeAssignable.map((m) => (
                <option key={m.id} value={m.userId}>
                  {m.userId}（{ROLE_LABELS[m.role]}）
                </option>
              ))}
            </select>
          </div>
          <button
            className="research-button"
            type="submit"
            data-testid="collab-work-submit"
            disabled={busy}
          >
            创建任务
          </button>
        </form>
      ) : null}

      <div className="research-table-scroll">
        <table className="research-table">
          <thead>
            <tr>
              <th>标题</th>
              <th>状态</th>
              <th>指派人</th>
              <th>创建人</th>
              <th>版本</th>
              {canWrite ? <th>操作</th> : null}
            </tr>
          </thead>
          <tbody>
            {workItems.map((workItem) => (
              <tr key={workItem.id} data-testid="collab-work-item">
                <td>
                  <span className="research-source-title">{workItem.title}</span>
                  {workItem.description ? (
                    <p className="research-muted">{workItem.description}</p>
                  ) : null}
                </td>
                <td>
                  {canWrite ? (
                    <select
                      className="research-input"
                      data-testid={`collab-work-status-${workItem.id}`}
                      value={workItem.status}
                      disabled={busy}
                      onChange={(event) =>
                        void update(workItem, {
                          status: event.target.value as WorkItemStatus
                        })
                      }
                    >
                      <option value="open">待办</option>
                      <option value="in_progress">进行中</option>
                      <option value="in_review">待审核</option>
                      <option value="completed">已完成</option>
                      <option value="cancelled">已取消</option>
                    </select>
                  ) : (
                    <span className="research-pill research-pill-neutral">
                      {STATUS_LABELS[workItem.status] ?? workItem.status}
                    </span>
                  )}
                </td>
                <td className="research-muted">
                  {workItem.assigneeUserId ?? "—"}
                </td>
                <td className="research-muted">{workItem.createdBy}</td>
                <td className="research-muted">{workItem.version}</td>
                {canWrite ? (
                  <td>
                    <select
                      className="research-input"
                      data-testid={`collab-work-assignee-${workItem.id}`}
                      value={workItem.assigneeUserId ?? ""}
                      disabled={busy}
                      onChange={(event) => {
                        // The server model has no "clear assignee" path (an absent
                        // field means "no change", not "unassign"), so unassigning
                        // is not offered: the placeholder is disabled and only a
                        // real, active member can ever be selected.
                        const nextAssignee = event.target.value;
                        if (!nextAssignee) return;
                        void update(workItem, { assigneeUserId: nextAssignee });
                      }}
                    >
                      <option value="" disabled>
                        未指派
                      </option>
                      {activeAssignable.map((m) => (
                        <option key={m.id} value={m.userId}>
                          {m.userId}（{ROLE_LABELS[m.role]}）
                        </option>
                      ))}
                    </select>
                  </td>
                ) : null}
              </tr>
            ))}
            {workItems.length === 0 ? (
              <tr>
                <td
                  colSpan={canWrite ? 6 : 5}
                  className="research-muted"
                >
                  还没有研究任务。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Comments
 * ------------------------------------------------------------------ */

function CommentsView({
  sessionId,
  comments,
  targetType,
  targetId,
  setTargetType,
  setTargetId,
  myUserId,
  canComment,
  busy,
  run,
  afterChange
}: {
  sessionId: string;
  comments: Comment[];
  targetType: string;
  targetId: string;
  setTargetType: (value: string) => void;
  setTargetId: (value: string) => void;
  myUserId: string | null;
  canComment: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>, label: string) => Promise<boolean>;
  afterChange: () => Promise<void>;
}) {
  const [body, setBody] = useState("");
  // The comment waiting for a confirmation before it is deleted. Only the
  // author ever sees this control, and the server only lets the author delete,
  // but a one-way action still gets asked for.
  const [deleteTarget, setDeleteTarget] = useState<Comment | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!body.trim() || !targetType.trim() || !targetId.trim()) return;
    const ok = await run(async () => {
      await createCollaborationComment(sessionId, {
        body: body.trim(),
        targetType,
        targetId: targetId.trim()
      });
      setBody("");
      await afterChange();
    }, "发表评论");
    if (!ok) return;
  };

  const remove = async (comment: Comment) => {
    const ok = await run(async () => {
      await deleteCollaborationComment(
        comment.sessionId,
        comment.id,
        comment.version
      );
      await afterChange();
    }, "删除评论");
    if (!ok) return;
  };

  return (
    <section className="research-panel" data-testid="collab-comments">
      <div className="research-panel-head">
        <span className="research-panel-title">讨论</span>
        <span className="research-muted">
          评论挂在某个研究工件上；作者由服务器记录，不能冒用他人身份。
        </span>
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="collab-comment-target-type">
          目标类型
        </label>
        <select
          id="collab-comment-target-type"
          className="research-input"
          data-testid="collab-comment-target-type"
          value={targetType}
          onChange={(event) => setTargetType(event.target.value)}
        >
          <option value="claim">主张</option>
          <option value="evidence">证据</option>
          <option value="source">来源</option>
          <option value="conflict">冲突</option>
          <option value="challenge">质疑</option>
          <option value="plan_item">计划项</option>
          <option value="revalidation_task">复核任务</option>
          <option value="report_snapshot">报告快照</option>
          <option value="work_item">任务</option>
        </select>
      </div>
      <div className="research-field">
        <label className="research-label" htmlFor="collab-comment-target-id">
          目标 ID
        </label>
        <input
          id="collab-comment-target-id"
          className="research-input"
          data-testid="collab-comment-target-id"
          value={targetId}
          onChange={(event) => setTargetId(event.target.value)}
          placeholder="例如 claim-123"
        />
      </div>

      {canComment ? (
        <form className="research-form" onSubmit={create} data-testid="collab-comment-form">
          <div className="research-field">
            <label className="research-label" htmlFor="collab-comment-body">
              评论内容
            </label>
            <textarea
              id="collab-comment-body"
              className="research-input"
              data-testid="collab-comment-body"
              value={body}
              rows={3}
              onChange={(event) => setBody(event.target.value)}
              placeholder="写下你的意见或问题"
            />
          </div>
          <button
            className="research-button"
            type="submit"
            data-testid="collab-comment-submit"
            disabled={busy}
          >
            发表评论
          </button>
        </form>
      ) : (
        <p className="research-muted">
          只有负责人、编辑或审核者可以发表评论；只读角色只能查看。
        </p>
      )}

      <ul className="research-plain-list" data-testid="collab-comment-list">
        {comments.map((comment) => {
          const isSelf = comment.authorUserId === myUserId;
          return (
            <li key={comment.id} className="research-plain-list-item" data-testid="collab-comment">
              <span className="research-source-title">
                {comment.authorUserId}
                {isSelf ? "（你）" : ""}
                {comment.deletedAt ? "（已删除）" : ""}
              </span>
              <p>{comment.body}</p>
              <span className="research-muted">
                版本 {comment.version} · 创建于 {formatDateTime(comment.createdAt)}
              </span>
              {!comment.deletedAt && isSelf && canComment ? (
                <button
                  className="research-button-secondary"
                  type="button"
                  data-testid={`collab-comment-delete-${comment.id}`}
                  disabled={busy}
                  onClick={() => setDeleteTarget(comment)}
                >
                  删除
                </button>
              ) : null}
            </li>
          );
        })}
        {comments.length === 0 ? (
          <li className="research-muted">该目标下还没有评论。</li>
        ) : null}
      </ul>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这条评论？"
        description="删除是软删除：评论会标记为「已删除」并记录一条审计事件（含删除人），记录本身保留，删除后无法恢复显示。"
        confirmLabel="删除"
        busy={busy}
        testId="collab-comment-delete-dialog"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const comment = deleteTarget;
          if (!comment) return;
          void (async () => {
            await remove(comment);
            setDeleteTarget(null);
          })();
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Review requests
 * ------------------------------------------------------------------ */

function ReviewRequestsView({
  sessionId,
  reviewRequests,
  myUserId,
  canCreate,
  busy,
  run,
  afterChange
}: {
  sessionId: string;
  reviewRequests: ReviewRequest[];
  myUserId: string | null;
  canCreate: boolean;
  busy: boolean;
  run: (action: () => Promise<unknown>, label: string) => Promise<boolean>;
  afterChange: () => Promise<void>;
}) {
  const [requestType, setRequestType] =
    useState<ReviewRequestType>("claim_review");
  const [targetType, setTargetType] =
    useState<ReviewRequestTargetType>("claim");
  const [targetId, setTargetId] = useState("");
  const [reviewer, setReviewer] = useState("");
  // The two one-way rulings on a review request. Approving and claiming stay
  // single-click: they are the ordinary forward path. Rejecting throws the
  // request away and cancelling abandons it, so both are asked for first.
  const [rejectTarget, setRejectTarget] = useState<ReviewRequest | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ReviewRequest | null>(null);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!targetId.trim()) return;
    const ok = await run(async () => {
      await createCollaborationReviewRequest(sessionId, {
        requestType,
        targetType,
        targetId: targetId.trim(),
        ...(reviewer.trim()
          ? { requestedReviewerUserId: reviewer.trim() }
          : {})
      });
      setTargetId("");
      setReviewer("");
      await afterChange();
    }, "发起审核请求");
    if (!ok) return;
  };

  const claim = async (request: ReviewRequest) => {
    const ok = await run(async () => {
      await claimCollaborationReviewRequest(request.sessionId, request.id);
      await afterChange();
    }, "认领审核");
    if (!ok) return;
  };

  const decide = async (request: ReviewRequest, decision: ReviewDecision) => {
    const ok = await run(async () => {
      await decideCollaborationReviewRequest(request.sessionId, request.id, {
        decision,
        expectedVersion: request.version
      });
      await afterChange();
    }, decision === "approved" ? "通过审核" : "驳回审核");
    if (!ok) return;
  };

  const cancel = async (request: ReviewRequest) => {
    const ok = await run(async () => {
      await cancelCollaborationReviewRequest(request.sessionId, request.id);
      await afterChange();
    }, "取消审核请求");
    if (!ok) return;
  };

  return (
    <section className="research-panel" data-testid="collab-review-requests">
      <div className="research-panel-head">
        <span className="research-panel-title">
          人工审核请求（{reviewRequests.length}）
        </span>
        <span className="research-muted">
          审核结论是对工件的人工确认，不等于主张判定或核实状态；正式核实仍走证据核实流程。
        </span>
      </div>
      {canCreate ? (
        <form className="research-form" onSubmit={create} data-testid="collab-review-form">
          <div className="research-field">
            <label className="research-label" htmlFor="collab-review-type">
              审核类型
            </label>
            <select
              id="collab-review-type"
              className="research-input"
              data-testid="collab-review-type"
              value={requestType}
              onChange={(event) =>
                setRequestType(event.target.value as ReviewRequestType)
              }
            >
              <option value="claim_review">主张审核</option>
              <option value="source_review">来源审核</option>
              <option value="report_review">报告审核</option>
              <option value="conflict_review">冲突审核</option>
            </select>
          </div>
          <div className="research-field">
            <label className="research-label" htmlFor="collab-review-target-type">
              目标类型
            </label>
            <select
              id="collab-review-target-type"
              className="research-input"
              data-testid="collab-review-target-type"
              value={targetType}
              onChange={(event) =>
                setTargetType(event.target.value as ReviewRequestTargetType)
              }
            >
              <option value="claim">主张</option>
              <option value="evidence">证据</option>
              <option value="source">来源</option>
              <option value="conflict">冲突</option>
              <option value="report_snapshot">报告快照</option>
            </select>
          </div>
          <div className="research-field">
            <label className="research-label" htmlFor="collab-review-target-id">
              目标 ID
            </label>
            <input
              id="collab-review-target-id"
              className="research-input"
              data-testid="collab-review-target-id"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
              placeholder="例如 claim-9"
            />
          </div>
          <div className="research-field">
            <label className="research-label" htmlFor="collab-review-reviewer">
              指定审核人（可选）
            </label>
            <input
              id="collab-review-reviewer"
              className="research-input"
              data-testid="collab-review-reviewer"
              value={reviewer}
              onChange={(event) => setReviewer(event.target.value)}
              placeholder="留空则向所有人开放"
            />
            <span className="research-muted">
              不能指定自己为审核人（不能自审）。
            </span>
          </div>
          <button
            className="research-button"
            type="submit"
            data-testid="collab-review-submit"
            disabled={busy}
          >
            发起审核请求
          </button>
        </form>
      ) : (
        <p className="research-muted">
          只有负责人、编辑或审核者可以发起审核请求；只读角色只能查看。
        </p>
      )}

      <div className="research-table-scroll">
        <table className="research-table">
          <thead>
            <tr>
              <th>类型</th>
              <th>目标</th>
              <th>状态</th>
              <th>请求人</th>
              <th>审核人</th>
              <th>结论</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {reviewRequests.map((request) => {
              const isRequester = request.requestedBy === myUserId;
              const isAssigned =
                request.assignedReviewerUserId === myUserId;
              const canClaim =
                request.status === "open" &&
                !isRequester &&
                (request.requestedReviewerUserId === undefined ||
                  request.requestedReviewerUserId === myUserId);
              const canDecide =
                request.status === "in_review" && isAssigned;
              const canCancel =
                request.status === "open" &&
                (isRequester || myUserId === null);
              return (
                <tr key={request.id} data-testid="collab-review-item">
                  <td>{REQUEST_TYPE_LABELS[request.requestType] ?? request.requestType}</td>
                  <td className="research-muted">
                    {request.targetType}:{request.targetId}
                  </td>
                  <td>
                    <span className="research-pill research-pill-neutral">
                      {STATUS_LABELS[request.status] ?? request.status}
                    </span>
                  </td>
                  <td className="research-muted">{request.requestedBy}</td>
                  <td className="research-muted">
                    {request.assignedReviewerUserId ?? "—"}
                  </td>
                  <td className="research-muted">
                    {request.decision
                      ? STATUS_LABELS[request.decision] ?? request.decision
                      : "—"}
                  </td>
                  <td>
                    {canClaim ? (
                      <button
                        className="research-button"
                        type="button"
                        data-testid={`collab-review-claim-${request.id}`}
                        disabled={busy}
                        onClick={() => void claim(request)}
                      >
                        认领
                      </button>
                    ) : null}
                    {canDecide ? (
                      <>
                        <button
                          className="research-button"
                          type="button"
                          data-testid={`collab-review-approve-${request.id}`}
                          disabled={busy}
                          onClick={() => void decide(request, "approved")}
                        >
                          通过
                        </button>
                        <button
                          className="research-button-secondary"
                          type="button"
                          data-testid={`collab-review-reject-${request.id}`}
                          disabled={busy}
                          onClick={() => setRejectTarget(request)}
                        >
                          驳回
                        </button>
                      </>
                    ) : null}
                    {canCancel ? (
                      <button
                        className="research-button-secondary"
                        type="button"
                        data-testid={`collab-review-cancel-${request.id}`}
                        disabled={busy}
                        onClick={() => setCancelTarget(request)}
                      >
                        取消
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
            {reviewRequests.length === 0 ? (
              <tr>
                <td colSpan={7} className="research-muted">
                  还没有审核请求。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <ConfirmDialog
        open={rejectTarget !== null}
        title="驳回这个审核请求？"
        description="驳回会记录为一次人工结论：该工件未通过审核，请求随即关闭。审核结论是对工件的人工确认，不等于主张判定，也不改变核实状态。"
        confirmLabel="驳回"
        busy={busy}
        testId="collab-review-reject-dialog"
        onCancel={() => setRejectTarget(null)}
        onConfirm={() => {
          const request = rejectTarget;
          if (!request) return;
          void (async () => {
            await decide(request, "rejected");
            setRejectTarget(null);
          })();
        }}
      />
      <ConfirmDialog
        open={cancelTarget !== null}
        title="取消这个审核请求？"
        description="取消会关闭请求并留下记录，不会记录任何结论；需要时再重新发起。"
        confirmLabel="取消请求"
        busy={busy}
        testId="collab-review-cancel-dialog"
        onCancel={() => setCancelTarget(null)}
        onConfirm={() => {
          const request = cancelTarget;
          if (!request) return;
          void (async () => {
            await cancel(request);
            setCancelTarget(null);
          })();
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Activity
 * ------------------------------------------------------------------ */

function ActivityView({ activity }: { activity: CollaborationActivity[] }) {
  return (
    <section className="research-panel" data-testid="collab-activity">
      <div className="research-panel-head">
        <span className="research-panel-title">活动轨迹</span>
        <span className="research-muted">
          来自共享的 execution_events：协作动作与研究材料变更共用一条审计线。
        </span>
      </div>
      <ul className="research-plain-list" data-testid="collab-activity-list">
        {activity.map((item) => (
          <li key={item.id} className="research-plain-list-item" data-testid="collab-activity-item">
            <span className="research-source-title">
              {ACTIVITY_TYPE_LABELS[item.type] ?? item.type}
            </span>
            <span className="research-muted">
              #{item.sequence} · 发生于 {formatDateTime(item.occurredAt)}
            </span>
          </li>
        ))}
        {activity.length === 0 ? (
          <li className="research-muted">还没有协作活动记录。</li>
        ) : null}
      </ul>
    </section>
  );
}
