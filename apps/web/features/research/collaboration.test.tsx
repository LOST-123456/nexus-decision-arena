import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The team collaboration & human-review surface, checked against the real
 * component with only the API faked. What is pinned down here is the honesty
 * contract:
 *  - the member/work/comment/review lists are read from the server, never
 *    invented;
 *  - every write reaches the *research's* session id (not the signed-in user's
 *    id) — a mix-up would silently address the wrong research;
 *  - a viewer reads everything but is offered no control;
 *  - a comment carries the server identity as its author, and only that author
 *    is shown a delete control;
 *  - a review request cannot be claimed by its own requester (no self-review);
 *  - a refused write surfaces the server's own status (a 409 is a conflict, not
 *    a bare failure).
 */

class CollaborationFailedError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "CollaborationFailedError";
  }
}

const listCollaborationMembers = vi.fn();
const listCollaborationWorkItems = vi.fn();
const listCollaborationReviewRequests = vi.fn();
const listCollaborationActivity = vi.fn();
const listCollaborationComments = vi.fn();
const inviteCollaborationMember = vi.fn();
const acceptCollaborationInvitation = vi.fn();
const declineCollaborationInvitation = vi.fn();
const changeCollaborationRole = vi.fn();
const removeCollaborationMember = vi.fn();
const createCollaborationWorkItem = vi.fn();
const updateCollaborationWorkItem = vi.fn();
const createCollaborationComment = vi.fn();
const deleteCollaborationComment = vi.fn();
const createCollaborationReviewRequest = vi.fn();
const claimCollaborationReviewRequest = vi.fn();
const decideCollaborationReviewRequest = vi.fn();
const cancelCollaborationReviewRequest = vi.fn();
const getCurrentUser = vi.fn();

vi.mock("./api", () => ({
  CollaborationFailedError,
  listCollaborationMembers: (...args: unknown[]) => listCollaborationMembers(...args),
  listCollaborationWorkItems: (...args: unknown[]) => listCollaborationWorkItems(...args),
  listCollaborationReviewRequests: (...args: unknown[]) => listCollaborationReviewRequests(...args),
  listCollaborationActivity: (...args: unknown[]) => listCollaborationActivity(...args),
  listCollaborationComments: (...args: unknown[]) => listCollaborationComments(...args),
  inviteCollaborationMember: (...args: unknown[]) => inviteCollaborationMember(...args),
  acceptCollaborationInvitation: (...args: unknown[]) => acceptCollaborationInvitation(...args),
  declineCollaborationInvitation: (...args: unknown[]) => declineCollaborationInvitation(...args),
  changeCollaborationRole: (...args: unknown[]) => changeCollaborationRole(...args),
  removeCollaborationMember: (...args: unknown[]) => removeCollaborationMember(...args),
  createCollaborationWorkItem: (...args: unknown[]) => createCollaborationWorkItem(...args),
  updateCollaborationWorkItem: (...args: unknown[]) => updateCollaborationWorkItem(...args),
  createCollaborationComment: (...args: unknown[]) => createCollaborationComment(...args),
  deleteCollaborationComment: (...args: unknown[]) => deleteCollaborationComment(...args),
  createCollaborationReviewRequest: (...args: unknown[]) => createCollaborationReviewRequest(...args),
  claimCollaborationReviewRequest: (...args: unknown[]) => claimCollaborationReviewRequest(...args),
  decideCollaborationReviewRequest: (...args: unknown[]) => decideCollaborationReviewRequest(...args),
  cancelCollaborationReviewRequest: (...args: unknown[]) => cancelCollaborationReviewRequest(...args)
}));

vi.mock("../arena/api-client", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args)
}));

const { CollaborationPanel } = await import("./collaboration");

const SESSION_ID = "0199e6d0-0000-7000-8000-0000000000a1";
const OTHER_SESSION = "0199e6d0-0000-7000-8000-0000000000b2";
const ME = "u-me";
const OTHER = "u-other";

function member(over: Record<string, unknown>) {
  return {
    id: "m-1",
    sessionId: SESSION_ID,
    userId: ME,
    role: "editor",
    status: "active",
    invitedBy: "u-owner",
    invitedAt: "2026-01-01T00:00:00.000Z",
    joinedAt: "2026-01-01T00:00:00.000Z",
    statusChangedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over
  };
}

function workItem(over: Record<string, unknown>) {
  return {
    id: "w-1",
    sessionId: SESSION_ID,
    title: "复核来源 A",
    status: "open",
    createdBy: ME,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    ...over
  };
}

function comment(over: Record<string, unknown>) {
  return {
    id: "c-1",
    sessionId: SESSION_ID,
    authorUserId: ME,
    body: "这条主张需要更强证据。",
    targetType: "claim",
    targetId: "claim-demo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    ...over
  };
}

function reviewRequest(over: Record<string, unknown>) {
  return {
    id: "r-1",
    sessionId: SESSION_ID,
    requestType: "claim_review",
    targetType: "claim",
    targetId: "claim-demo",
    requestedBy: OTHER,
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
    ...over
  };
}

function seedLists(over: {
  members?: unknown[];
  workItems?: unknown[];
  reviewRequests?: unknown[];
} = {}) {
  listCollaborationMembers.mockResolvedValue({ members: over.members ?? [] });
  listCollaborationWorkItems.mockResolvedValue({ workItems: over.workItems ?? [] });
  listCollaborationReviewRequests.mockResolvedValue({
    reviewRequests: over.reviewRequests ?? []
  });
  listCollaborationActivity.mockResolvedValue({ activity: [] });
  listCollaborationComments.mockResolvedValue({ comments: [] });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CollaborationPanel", () => {
  it("lists the real members read from the server", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    seedLists({
      members: [
        member({ id: "m-1", userId: ME, role: "editor", status: "active" }),
        member({
          id: "m-2",
          userId: OTHER,
          role: "reviewer",
          status: "pending"
        })
      ]
    });

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);

    expect(await screen.findByTestId("collab-members")).toBeTruthy();
    expect(screen.getAllByTestId("collab-member").length).toBe(2);
    expect(screen.getByText(OTHER)).toBeTruthy();
    expect(listCollaborationMembers).toHaveBeenCalledWith(SESSION_ID);
  });

  it("invites against the research session id, never the caller's user id", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    seedLists({ members: [] });
    inviteCollaborationMember.mockResolvedValue(
      member({ id: "m-new", userId: "u-new", role: "editor", status: "pending" })
    );

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);

    const form = await screen.findByTestId("collab-invite-form");
    fireEvent.change(screen.getByTestId("collab-invite-user"), {
      target: { value: "u-new" }
    });
    fireEvent.change(screen.getByTestId("collab-invite-role"), {
      target: { value: "editor" }
    });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(inviteCollaborationMember).toHaveBeenCalledWith(SESSION_ID, {
        userId: "u-new",
        role: "editor"
      })
    );
    // The caller's own id must never be mistaken for the session id.
    expect(inviteCollaborationMember).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: ME })
    );
  });

  it("gives a viewer the record but no write controls", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "viewer" });
    seedLists({
      members: [member({ id: "m-me", userId: ME, role: "viewer", status: "active" })]
    });

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={false} />);

    await screen.findByTestId("collab-members");
    expect(screen.queryByTestId("collab-invite-form")).toBeNull();
    expect(screen.queryByTestId(`collab-role-${ME}`)).toBeNull();
    expect(screen.getByText(/只读角色/)).toBeTruthy();
  });

  it("creates a work item against the session id with the chosen assignee", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    seedLists({
      members: [member({ id: "m-editor", userId: OTHER, role: "editor" })]
    });
    createCollaborationWorkItem.mockResolvedValue(
      workItem({ assigneeUserId: OTHER })
    );

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);

    fireEvent.click(await screen.findByTestId("collab-tab-work"));
    const form = await screen.findByTestId("collab-work-form");
    fireEvent.change(screen.getByTestId("collab-work-title"), {
      target: { value: "复核来源 A" }
    });
    fireEvent.change(screen.getByTestId("collab-work-assignee"), {
      target: { value: OTHER }
    });
    fireEvent.submit(form);

    await waitFor(() =>
      expect(createCollaborationWorkItem).toHaveBeenCalledWith(SESSION_ID, {
        title: "复核来源 A",
        assigneeUserId: OTHER
      })
    );
  });

  it("attributes a comment to its author and only lets the author delete it", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    seedLists({
      members: [member({ id: "m-me", userId: ME, role: "editor" })]
    });
    listCollaborationComments.mockResolvedValue({
      comments: [
        comment({ id: "c-mine", authorUserId: ME, body: "我的批注" }),
        comment({ id: "c-theirs", authorUserId: OTHER, body: "别人的批注" })
      ]
    });

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);

    fireEvent.click(await screen.findByTestId("collab-tab-comments"));
    await waitFor(() =>
      expect(screen.getAllByTestId("collab-comment").length).toBe(2)
    );
    expect(screen.getByText("别人的批注")).toBeTruthy();
    // Only the author is offered a delete control.
    expect(screen.getByTestId("collab-comment-delete-c-mine")).toBeTruthy();
    expect(screen.queryByTestId("collab-comment-delete-c-theirs")).toBeNull();
    expect(listCollaborationComments).toHaveBeenCalledWith(
      SESSION_ID,
      "claim",
      "claim-demo"
    );
  });

  it("never lets a requester claim their own review request", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    seedLists({
      members: [member({ id: "m-me", userId: ME, role: "editor" })],
      reviewRequests: [
        reviewRequest({ id: "r-mine", requestedBy: ME, status: "open" }),
        reviewRequest({ id: "r-theirs", requestedBy: OTHER, status: "open" })
      ]
    });

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);

    fireEvent.click(await screen.findByTestId("collab-tab-review"));
    await waitFor(() =>
      expect(screen.getAllByTestId("collab-review-item").length).toBe(2)
    );
    // Own request: no claim control (but the requester may cancel it).
    expect(screen.queryByTestId("collab-review-claim-r-mine")).toBeNull();
    expect(screen.getByTestId("collab-review-cancel-r-mine")).toBeTruthy();
    // Someone else's open request: claimable.
    expect(screen.getByTestId("collab-review-claim-r-theirs")).toBeTruthy();
  });

  it("surfaces a 409 from a stale decision instead of hiding it", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    seedLists({
      members: [member({ id: "m-me", userId: ME, role: "editor" })],
      reviewRequests: [
        reviewRequest({
          id: "r-assigned",
          requestedBy: OTHER,
          status: "in_review",
          assignedReviewerUserId: ME
        })
      ]
    });
    decideCollaborationReviewRequest.mockRejectedValue(
      new CollaborationFailedError("版本已过期", 409)
    );

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);

    fireEvent.click(await screen.findByTestId("collab-tab-review"));
    const approve = await screen.findByTestId("collab-review-approve-r-assigned");
    fireEvent.click(approve);

    const error = await screen.findByTestId("collab-error");
    expect(error.textContent).toContain("409");
    expect(error.textContent).toContain("版本已过期");
    expect(decideCollaborationReviewRequest).toHaveBeenCalledWith(
      SESSION_ID,
      "r-assigned",
      { decision: "approved", expectedVersion: 1 }
    );
  });

  it("reports a non-collaborator as a not-found rather than an empty panel", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    listCollaborationMembers.mockRejectedValue(
      new CollaborationFailedError("Not found", 404)
    );
    listCollaborationWorkItems.mockResolvedValue({ workItems: [] });
    listCollaborationReviewRequests.mockResolvedValue({ reviewRequests: [] });
    listCollaborationActivity.mockResolvedValue({ activity: [] });

    render(
      <CollaborationPanel sessionId={OTHER_SESSION} canEdit={true} />
    );

    const banner = await screen.findByTestId("collab-load-error");
    expect(banner.textContent).toContain("不是该研究的协作者");
  });
});

/**
 * The audit trail is append-only, so it is read a page at a time. What has to
 * hold is that "more" is offered when it exists, that extending appends rather
 * than replacing, and that a failed extension never costs the events already
 * on screen — losing audit history to a network blip would be the worst of the
 * three outcomes.
 */
describe("CollaborationPanel · activity paging", () => {
  function event(sequence: number) {
    return {
      id: `evt-${sequence}`,
      sessionId: SESSION_ID,
      sequence,
      correlationId: `corr-${sequence}`,
      type: "COLLABORATION_MEMBER_INVITED",
      payload: {},
      occurredAt: "2026-10-20T09:00:00.000Z"
    };
  }

  it("appends the next page of events instead of replacing the trail", async () => {
    seedLists({});
    getCurrentUser.mockResolvedValue({ id: ME, role: "owner" });
    listCollaborationActivity
      .mockResolvedValueOnce({
        activity: [event(9), event(8)],
        nextCursor: 8,
        hasNextPage: true
      })
      .mockResolvedValueOnce({
        activity: [event(7)],
        nextCursor: null,
        hasNextPage: false
      });

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);
    fireEvent.click(await screen.findByTestId("collab-tab-activity"));

    expect(await screen.findAllByTestId("collab-activity-item")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("collab-activity-load-more"));

    await waitFor(() =>
      expect(screen.getAllByTestId("collab-activity-item")).toHaveLength(3)
    );
    // The cursor travels as the last sequence already on screen.
    expect(listCollaborationActivity).toHaveBeenLastCalledWith(SESSION_ID, {
      after: 8
    });
    expect(screen.queryByTestId("collab-activity-load-more")).toBeNull();
  });

  it("keeps the events already on screen when the next page fails", async () => {
    seedLists({});
    getCurrentUser.mockResolvedValue({ id: ME, role: "owner" });
    listCollaborationActivity
      .mockResolvedValueOnce({
        activity: [event(9), event(8)],
        nextCursor: 8,
        hasNextPage: true
      })
      .mockRejectedValueOnce(new Error("network down"));

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);
    fireEvent.click(await screen.findByTestId("collab-tab-activity"));

    expect(await screen.findAllByTestId("collab-activity-item")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("collab-activity-load-more"));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("network down")
    );
    expect(screen.getAllByTestId("collab-activity-item")).toHaveLength(2);
    expect(screen.getByTestId("collab-activity-load-more")).toBeTruthy();
  });

  /**
   * 空表单提交必须给解释。
   *
   * 这四处以前是 `if (!field) return;`：按钮看着可用，点下去不发请求、
   * 不报错、不提示，用户只能反复点 —— 表现和「按钮坏了」完全一样。
   */
  it("邀请时账号留空会说明缺什么，而不是静默返回", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    // members 为空 = 当前账号是平台拥有者（没有成员行），四个面板都可见。
    seedLists({ members: [] });

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);
    fireEvent.click(await screen.findByTestId("collab-invite-submit"));

    const error = await screen.findByTestId("collab-error");
    expect(error.textContent).toContain("账号 ID");
    expect(inviteCollaborationMember).not.toHaveBeenCalled();
  });

  it("工作项标题留空会说明缺什么", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    // members 为空 = 当前账号是平台拥有者（没有成员行），四个面板都可见。
    seedLists({ members: [] });

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);
    fireEvent.click(await screen.findByTestId("collab-tab-work"));
    fireEvent.click(await screen.findByTestId("collab-work-submit"));

    const error = await screen.findByTestId("collab-error");
    expect(error.textContent).toContain("标题");
    expect(createCollaborationWorkItem).not.toHaveBeenCalled();
  });

  it("评论正文留空会说明缺什么", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    // members 为空 = 当前账号是平台拥有者（没有成员行），四个面板都可见。
    seedLists({ members: [] });

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);
    fireEvent.click(await screen.findByTestId("collab-tab-comments"));
    fireEvent.click(await screen.findByTestId("collab-comment-submit"));

    const error = await screen.findByTestId("collab-error");
    expect(error.textContent).toContain("评论内容");
    expect(createCollaborationComment).not.toHaveBeenCalled();
  });

  it("发起审阅时对象留空会说明缺什么", async () => {
    getCurrentUser.mockResolvedValue({ id: ME, role: "editor" });
    // members 为空 = 当前账号是平台拥有者（没有成员行），四个面板都可见。
    seedLists({ members: [] });

    render(<CollaborationPanel sessionId={SESSION_ID} canEdit={true} />);
    fireEvent.click(await screen.findByTestId("collab-tab-review"));
    fireEvent.click(await screen.findByTestId("collab-review-submit"));

    const error = await screen.findByTestId("collab-error");
    expect(error.textContent).toContain("对象 ID");
    expect(createCollaborationReviewRequest).not.toHaveBeenCalled();
  });
});
