import { describe, expect, it } from "vitest";
import {
  buildCommentItem,
  buildFailedRunItem,
  buildInvitationItem,
  buildNotificationFeed,
  buildReviewRequestItem,
  buildVersionItem,
  commentKey,
  failedRunKey,
  invitationKey,
  NEWS_WINDOW_DAYS,
  newsWindowStart,
  NOTIFICATION_LIMIT,
  reviewRequestKey,
  versionKey,
  type FailedRunRow,
  type PendingInvitationRow,
  type PendingReviewRequestRow,
  type RecentCommentRow,
  type RecentVersionRow
} from "./notification-service";

/**
 * What the notification centre promises, and what it must never say.
 *
 * The cards are derived from rows that already exist, so the interesting
 * failures are all in the derivation: an item announced twice, an unread badge
 * that only counts what fits on screen, a research with no question rendered as
 * an empty card, a failed run whose reason was never recorded presented as if
 * it had one.
 *
 * One failure is new with this round and worth naming: **the cap**. Before,
 * every card lived in one list of fifty, so fifty recent comments could push a
 * single invitation off the page — the badge says one thing is waiting and the
 * page does not show it. Actions and news now have their own budgets.
 */

const SESSION = "22222222-2222-7222-8222-222222222222";
const QUESTION = "高校实验室的采购周期是否支持 12 个月试点？";

function invitation(
  overrides: Partial<PendingInvitationRow> = {}
): PendingInvitationRow {
  return {
    membershipId: "11111111-1111-7111-8111-111111111111",
    sessionId: SESSION,
    researchQuestion: QUESTION,
    role: "editor",
    invitedBy: "owner (owner)",
    invitedAt: "2026-10-27T08:00:00.000Z",
    ...overrides
  };
}

function failedRun(overrides: Partial<FailedRunRow> = {}): FailedRunRow {
  return {
    runId: "33333333-3333-7333-8333-333333333333",
    sessionId: SESSION,
    researchQuestion: QUESTION,
    error: "model timeout",
    attempt: 2,
    startedAt: "2026-10-27T09:00:00.000Z",
    ...overrides
  };
}

function reviewRequest(
  overrides: Partial<PendingReviewRequestRow> = {}
): PendingReviewRequestRow {
  return {
    requestId: "44444444-4444-7444-8444-444444444444",
    sessionId: SESSION,
    researchQuestion: QUESTION,
    requestType: "report_review",
    targetType: "report_snapshot",
    targetId: "snapshot-1",
    status: "open",
    requestedBy: "owner (owner)",
    createdAt: "2026-10-27T07:00:00.000Z",
    ...overrides
  };
}

function comment(overrides: Partial<RecentCommentRow> = {}): RecentCommentRow {
  return {
    commentId: "55555555-5555-7555-8555-555555555555",
    sessionId: SESSION,
    researchQuestion: QUESTION,
    authorUserId: "reviewer-a",
    targetType: "claim",
    body: "这个主张的证据只覆盖了一个城市。",
    createdAt: "2026-10-27T10:00:00.000Z",
    ...overrides
  };
}

function version(overrides: Partial<RecentVersionRow> = {}): RecentVersionRow {
  return {
    snapshotId: "66666666-6666-7666-8666-666666666666",
    sessionId: SESSION,
    researchQuestion: QUESTION,
    version: 3,
    createdBy: "owner",
    changeReason: "补充了第二轮检索的来源",
    createdAt: "2026-10-27T11:00:00.000Z",
    ...overrides
  };
}

describe("item keys", () => {
  it("is built from the source row, so it survives a re-read", () => {
    expect(invitationKey("abc")).toBe("invitation:abc");
    expect(failedRunKey("xyz")).toBe("run-failed:xyz");
    expect(reviewRequestKey("rq")).toBe("review-request:rq");
    expect(commentKey("cm")).toBe("comment:cm");
    expect(versionKey("vs")).toBe("version:vs");
  });

  it("keeps every kind from colliding on an identical id", () => {
    const keys = [
      invitationKey("same"),
      failedRunKey("same"),
      reviewRequestKey("same"),
      commentKey("same"),
      versionKey("same")
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("buildNotificationFeed", () => {
  it("separates what is waiting from what merely happened", () => {
    const feed = buildNotificationFeed({
      invitations: [invitation({ invitedAt: "2026-10-27T08:00:00.000Z" })],
      reviewRequests: [reviewRequest()],
      failedRuns: [failedRun({ startedAt: "2026-10-27T09:00:00.000Z" })],
      comments: [comment()],
      versions: [version()],
      readKeys: []
    });

    expect(feed.actions.map((entry) => entry.kind)).toEqual([
      "run-failed",
      "invitation",
      "review-request"
    ]);
    expect(feed.news.map((entry) => entry.kind)).toEqual([
      "version",
      "comment"
    ]);
    // A comment is not something the reader is behind on; it must never turn
    // up among the things that are waiting on them.
    expect(feed.actions.some((entry) => entry.kind === "comment")).toBe(false);
  });

  it("never lets fresh news push a waiting item off the page", () => {
    // 60 comments in the last hour and one invitation from yesterday. With a
    // single merged list of fifty, the invitation is invisible while the badge
    // says one thing is waiting.
    const noisyNews = Array.from({ length: 60 }, (_, index) =>
      comment({
        commentId: `comment-${index}`,
        createdAt: `2026-10-27T11:${String(index % 60).padStart(2, "0")}:00.000Z`
      })
    );

    const feed = buildNotificationFeed({
      invitations: [invitation({ invitedAt: "2026-10-26T08:00:00.000Z" })],
      failedRuns: [],
      comments: noisyNews,
      readKeys: []
    });

    expect(feed.actions).toHaveLength(1);
    expect(feed.actions[0]?.kind).toBe("invitation");
    // The news side is still capped on its own.
    expect(feed.news).toHaveLength(NOTIFICATION_LIMIT);
    expect(feed.overflow.news).toBe(10);
    expect(feed.overflow.actions).toBe(0);
  });

  it("counts unread actions and unread news apart", () => {
    const readComment = comment({ commentId: "c-read" });
    const feed = buildNotificationFeed({
      invitations: [invitation()],
      failedRuns: [failedRun()],
      comments: [readComment, comment({ commentId: "c-unread" })],
      readKeys: [commentKey(readComment.commentId), invitationKey(invitation().membershipId)]
    });

    expect(feed.unreadActionCount).toBe(1);
    expect(feed.unreadNewsCount).toBe(1);
  });

  it("counts unread over everything, not just the visible page", () => {
    // A badge that only counts the first page understates the work waiting.
    const many = Array.from({ length: NOTIFICATION_LIMIT + 5 }, (_, index) =>
      failedRun({
        runId: `run-${index}`,
        startedAt: `2026-10-27T09:${String(index % 60).padStart(2, "0")}:00.000Z`
      })
    );

    const feed = buildNotificationFeed({
      invitations: [],
      failedRuns: many,
      readKeys: []
    });

    expect(feed.actions).toHaveLength(NOTIFICATION_LIMIT);
    expect(feed.unreadActionCount).toBe(NOTIFICATION_LIMIT + 5);
    expect(feed.overflow.actions).toBe(5);
  });

  it("keeps a fixed order for items that share a timestamp", () => {
    const build = (order: readonly string[]) =>
      buildNotificationFeed({
        invitations: order.map((id) =>
          invitation({
            membershipId: id,
            invitedAt: "2026-10-27T08:00:00.000Z"
          })
        ),
        failedRuns: [],
        readKeys: []
      });

    expect(build(["a", "b"]).actions.map((entry) => entry.key)).toEqual(
      build(["b", "a"]).actions.map((entry) => entry.key)
    );
  });

  it("reports the window it used, so the screen does not invent its own", () => {
    const feed = buildNotificationFeed({
      invitations: [],
      failedRuns: [],
      readKeys: []
    });
    expect(feed.windowDays).toBe(NEWS_WINDOW_DAYS);
  });

  it("is empty, and says so, when nothing is waiting", () => {
    const feed = buildNotificationFeed({
      invitations: [],
      failedRuns: [],
      readKeys: []
    });
    expect(feed).toEqual({
      actions: [],
      news: [],
      unreadActionCount: 0,
      unreadNewsCount: 0,
      overflow: { actions: 0, news: 0 },
      windowDays: NEWS_WINDOW_DAYS
    });
  });
});

describe("the news window", () => {
  it("is a fixed distance back from the moment it is asked", () => {
    const now = new Date("2026-10-27T12:00:00.000Z");
    expect(newsWindowStart(now)).toBe("2026-10-20T12:00:00.000Z");
    // The clock is injected, so two calls at different times are two different
    // windows and neither is "whatever time it was inside the function".
    expect(newsWindowStart(new Date("2026-10-28T12:00:00.000Z"))).toBe(
      "2026-10-21T12:00:00.000Z"
    );
  });
});

describe("card text", () => {
  it("names the role in words a person reads", () => {
    const item = buildInvitationItem(invitation({ role: "editor" }), new Set());
    expect(item.detail).toContain("编辑者");
    expect(item.detail).toContain("等待你接受");
    expect(item.href).toBe(`/research/${SESSION}`);
  });

  it("falls back to the raw role rather than inventing a label", () => {
    const item = buildInvitationItem(
      invitation({ role: "some-new-role" }),
      new Set()
    );
    expect(item.detail).toContain("some-new-role");
  });

  it("says a research has no question yet instead of rendering an empty title", () => {
    const item = buildInvitationItem(
      invitation({ researchQuestion: "   " }),
      new Set()
    );
    expect(item.title).toBe("（未命名研究）");
  });

  it("says the failure reason is missing instead of printing nothing", () => {
    const item = buildFailedRunItem(failedRun({ error: null }), new Set());
    expect(item.detail).toContain("未记录失败原因");
    expect(item.detail).toContain("第 2 次尝试");
  });

  it("keeps the recorded reason verbatim", () => {
    const item = buildFailedRunItem(
      failedRun({ error: "provider rejected the request" }),
      new Set()
    );
    expect(item.detail).toContain("provider rejected the request");
  });

  it("says a review is waiting for a verdict, not that it was assigned", () => {
    const item = buildReviewRequestItem(reviewRequest(), new Set());
    expect(item.detail).toContain("报告审核");
    expect(item.detail).toContain("报告快照");
    // "已分配给你" describes a state; the reader needs the action.
    expect(item.detail).toContain("等你给出结论");
    expect(item.urgency).toBe("action");
  });

  it("shows who commented and what they said, trimmed", () => {
    const item = buildCommentItem(
      comment({ body: "第一句。" + "很长的补充说明。".repeat(20) }),
      new Set()
    );
    expect(item.detail).toContain("reviewer-a");
    expect(item.detail).toContain("主张");
    expect(item.detail).toContain("第一句。");
    // The full body belongs on the research page, not in a list of cards.
    expect(item.detail).toContain("…");
    expect(item.urgency).toBe("news");
  });

  it("says a comment was blank rather than rendering nothing after the colon", () => {
    const item = buildCommentItem(comment({ body: "   \n  " }), new Set());
    expect(item.detail).toContain("（空白评论）");
  });

  it("names the version and why it was saved", () => {
    const item = buildVersionItem(version(), new Set());
    expect(item.detail).toContain("第 3 版");
    expect(item.detail).toContain("补充了第二轮检索的来源");
    expect(item.urgency).toBe("news");
  });

  it("leaves the reason out when the saver did not give one", () => {
    const item = buildVersionItem(version({ changeReason: "  " }), new Set());
    expect(item.detail).toContain("第 3 版");
    expect(item.detail).not.toContain("：");
  });
});
