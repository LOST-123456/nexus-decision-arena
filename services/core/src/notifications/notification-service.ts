import type {
  FailedRunRow,
  PendingInvitationRow,
  PendingReviewRequestRow,
  RecentCommentRow,
  RecentVersionRow
} from "@nexus/db";
import { commentTargetTypeLabel, reviewRequestTypeLabel } from "@nexus/shared";

/** The row shapes the feed is built from, re-exported for its callers. */
export type {
  FailedRunRow,
  PendingInvitationRow,
  PendingReviewRequestRow,
  RecentCommentRow,
  RecentVersionRow
};

/**
 * The notification centre's whole logic, as a pure function.
 *
 * Two rules shape it, both of which come from the architecture rather than from
 * taste:
 *
 *  1. **An item is derived, never stored.** Every card is one row that already
 *     exists for its own reason — a pending membership, an open review request,
 *     somebody's comment, a saved snapshot, a failed run. There is no copy that
 *     can outlive the row being accepted, decided, deleted, retried or fixed,
 *     so a reader can never be told about something that is no longer there.
 *  2. **Read state is the only thing remembered.** That is the one fact no
 *     table can derive, and it is per account per item key.
 *
 * Keeping this pure means the ordering, the splitting and the unread counts are
 * testable without a database — and those are exactly the parts where a
 * notification centre usually starts lying.
 */

export type NotificationKind =
  /** 等你接受邀请。 */
  | "invitation"
  /** 有人等你给出审核结论。 */
  | "review-request"
  /** 一次运行失败了，需要重试。 */
  | "run-failed"
  /** 别人在你能读的研究下留了评论。 */
  | "comment"
  /** 别人保存了一个新的报告版本。 */
  | "version";

/**
 * 两类东西,不能混在一个列表里。
 *
 * `action` 是「等你动手」——不接受邀请就进不去,不给结论审核就一直挂着。
 * `news` 是「你该知道」——没人因为你不看评论而卡住。
 *
 * 把它们混在一起,红点就从「有两件事等我」退化成「一堆红点所以我不看」。这是
 * 消息中心最常见的死法,所以这个区分放在类型里,而不是放在界面的样式里。
 */
export type NotificationUrgency = "action" | "news";

const URGENCY_OF: Record<NotificationKind, NotificationUrgency> = {
  invitation: "action",
  "review-request": "action",
  "run-failed": "action",
  comment: "news",
  version: "news"
};

export type NotificationItem = {
  /** Stable across reads: marking it read twice is a no-op. */
  key: string;
  kind: NotificationKind;
  urgency: NotificationUrgency;
  sessionId: string;
  /** The research this is about, in the research's own words. */
  title: string;
  /** What happened, said plainly. Never a status code on its own. */
  detail: string;
  occurredAt: string;
  href: string;
  read: boolean;
};

/**
 * 两组各自的容量,以及被截掉多少。
 *
 * 上限**按组**算,不是先合并再切五十条。合并切的话,五十条较新的新闻能把一条
 * 待办挤出页面——角标说「1 项待处理」,列表里找不到它,那是让人怀疑自己看错。
 */
export type NotificationFeed = {
  actions: NotificationItem[];
  news: NotificationItem[];
  unreadActionCount: number;
  unreadNewsCount: number;
  overflow: { actions: number; news: number };
  /** 「最近 N 天」这句话里的 N,由服务端给出,界面不自己写死。 */
  windowDays: number;
};

export const NOTIFICATION_LIMIT = 50;

/**
 * 「新动态」的窗口。
 *
 * 没有窗口,一条三年前的评论会和今早的一样「新」,而且永远如此——评论和新版本
 * 不像邀请那样有生命周期终点(接受/拒绝/关闭),它们只会变旧。所以窗口就是这类
 * 事件的定义。七天是一个说法:再长读的人不信「最近」,再短会把上周的漏掉。
 */
export const NEWS_WINDOW_DAYS = 7;

/**
 * The window's lower bound, as the string the timestamp columns compare against.
 *
 * `now` is injected rather than read from the clock inside: the same input must
 * produce the same window, or the feed is untestable and two calls a second
 * apart can disagree about what "recent" means.
 */
export function newsWindowStart(now: Date): string {
  const start = new Date(now.getTime() - NEWS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return start.toISOString();
}

function untitled(question: string | null): string {
  // A research with no question yet is still a real research; saying
  // "未命名研究" is honest, an empty title is a broken card.
  return question?.trim() ? question.trim() : "（未命名研究）";
}

/** 评论正文进卡片只留一段提示,不把整段搬进列表。 */
function snippet(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "（空白评论）";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function invitationKey(membershipId: string): string {
  return `invitation:${membershipId}`;
}

export function failedRunKey(runId: string): string {
  return `run-failed:${runId}`;
}

export function reviewRequestKey(requestId: string): string {
  return `review-request:${requestId}`;
}

export function commentKey(commentId: string): string {
  return `comment:${commentId}`;
}

export function versionKey(snapshotId: string): string {
  return `version:${snapshotId}`;
}

const ROLE_TEXT: Record<string, string> = {
  owner: "所有者",
  editor: "编辑者",
  reviewer: "复核者",
  viewer: "只读"
};

function roleText(role: string): string {
  return ROLE_TEXT[role] ?? role;
}

function item(
  key: string,
  kind: NotificationKind,
  base: {
    sessionId: string;
    title: string;
    detail: string;
    occurredAt: string;
    href: string;
  },
  readKeys: ReadonlySet<string>
): NotificationItem {
  return {
    key,
    kind,
    urgency: URGENCY_OF[kind],
    sessionId: base.sessionId,
    title: base.title,
    detail: base.detail,
    occurredAt: base.occurredAt,
    href: base.href,
    read: readKeys.has(key)
  };
}

export function buildInvitationItem(
  row: PendingInvitationRow,
  readKeys: ReadonlySet<string>
): NotificationItem {
  const key = invitationKey(row.membershipId);
  return item(
    key,
    "invitation",
    {
      sessionId: row.sessionId,
      title: untitled(row.researchQuestion),
      detail: `${row.invitedBy} 邀请你以「${roleText(row.role)}」身份加入这项研究，等待你接受。`,
      occurredAt: row.invitedAt,
      href: `/research/${row.sessionId}`
    },
    readKeys
  );
}

export function buildFailedRunItem(
  row: FailedRunRow,
  readKeys: ReadonlySet<string>
): NotificationItem {
  const key = failedRunKey(row.runId);
  const reason = row.error?.trim() ? row.error.trim() : "未记录失败原因";
  return item(
    key,
    "run-failed",
    {
      sessionId: row.sessionId,
      title: untitled(row.researchQuestion),
      detail: `一次 Agent 运行失败（第 ${row.attempt} 次尝试）：${reason}`,
      occurredAt: row.startedAt,
      href: `/research/${row.sessionId}`
    },
    readKeys
  );
}

export function buildReviewRequestItem(
  row: PendingReviewRequestRow,
  readKeys: ReadonlySet<string>
): NotificationItem {
  const key = reviewRequestKey(row.requestId);
  return item(
    key,
    "review-request",
    {
      sessionId: row.sessionId,
      title: untitled(row.researchQuestion),
      // 说的是「等你给出结论」,不是「已分配给你」:前者是状态,后者是动作。
      detail: `${row.requestedBy} 发起了${reviewRequestTypeLabel(row.requestType)}（对象：${commentTargetTypeLabel(row.targetType)}），等你给出结论。`,
      occurredAt: row.createdAt,
      href: `/research/${row.sessionId}`
    },
    readKeys
  );
}

export function buildCommentItem(
  row: RecentCommentRow,
  readKeys: ReadonlySet<string>
): NotificationItem {
  const key = commentKey(row.commentId);
  return item(
    key,
    "comment",
    {
      sessionId: row.sessionId,
      title: untitled(row.researchQuestion),
      detail: `${row.authorUserId} 在${commentTargetTypeLabel(row.targetType)}下评论：${snippet(row.body)}`,
      occurredAt: row.createdAt,
      href: `/research/${row.sessionId}`
    },
    readKeys
  );
}

export function buildVersionItem(
  row: RecentVersionRow,
  readKeys: ReadonlySet<string>
): NotificationItem {
  const key = versionKey(row.snapshotId);
  const reason = row.changeReason?.trim()
    ? `：${snippet(row.changeReason, 60)}`
    : "";
  return item(
    key,
    "version",
    {
      sessionId: row.sessionId,
      title: untitled(row.researchQuestion),
      detail: `${row.createdBy} 保存了报告第 ${row.version} 版${reason}。`,
      occurredAt: row.createdAt,
      href: `/research/${row.sessionId}`
    },
    readKeys
  );
}

function newestFirst(
  left: NotificationItem,
  right: NotificationItem
): number {
  // Newest first. A stable tie-break on the key keeps two items that share a
  // timestamp in a fixed order, so the list does not shuffle between reads.
  if (left.occurredAt === right.occurredAt) {
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  }
  return left.occurredAt < right.occurredAt ? 1 : -1;
}

export function buildNotificationFeed(input: {
  invitations: readonly PendingInvitationRow[];
  reviewRequests?: readonly PendingReviewRequestRow[];
  failedRuns: readonly FailedRunRow[];
  comments?: readonly RecentCommentRow[];
  versions?: readonly RecentVersionRow[];
  readKeys: readonly string[];
  limit?: number;
  now?: Date;
}): NotificationFeed {
  const readKeys = new Set(input.readKeys);
  const limit = input.limit ?? NOTIFICATION_LIMIT;

  const actions = [
    ...input.invitations.map((row) => buildInvitationItem(row, readKeys)),
    ...(input.reviewRequests ?? []).map((row) =>
      buildReviewRequestItem(row, readKeys)
    ),
    ...input.failedRuns.map((row) => buildFailedRunItem(row, readKeys))
  ].sort(newestFirst);

  const news = [
    ...(input.comments ?? []).map((row) => buildCommentItem(row, readKeys)),
    ...(input.versions ?? []).map((row) => buildVersionItem(row, readKeys))
  ].sort(newestFirst);

  return {
    actions: actions.slice(0, limit),
    news: news.slice(0, limit),
    // Counted over everything, not over the visible page: a badge that only
    // counts what fits on screen understates the work waiting. The badge uses
    // the action count only — news is not something to be "behind" on.
    unreadActionCount: actions.filter((entry) => !entry.read).length,
    unreadNewsCount: news.filter((entry) => !entry.read).length,
    overflow: {
      actions: Math.max(0, actions.length - limit),
      news: Math.max(0, news.length - limit)
    },
    windowDays: NEWS_WINDOW_DAYS
  };
}
