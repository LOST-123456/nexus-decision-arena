const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

/**
 * The notification feed, as the API describes it.
 *
 * Kept in one file next to the page that consumes it, like the other feature
 * clients: nothing here computes an item or counts an unread. The server
 * derives every card from a row that already exists, and this layer only
 * carries that answer across.
 */
export type NotificationKind =
  | "invitation"
  | "review-request"
  | "run-failed"
  | "comment"
  | "version";

/**
 * 两类，界面必须分开画。
 *
 * `action` 是等你动手的（邀请、审核请求、失败的运行）；`news` 只是你该知道的
 * （别人的评论、别人存的新版本）。混在一起画，红点就从「有两件事等我」变成
 * 「一堆红点」，然后就没人看了。
 */
export type NotificationUrgency = "action" | "news";

export type NotificationItem = {
  key: string;
  kind: NotificationKind;
  urgency: NotificationUrgency;
  sessionId: string;
  title: string;
  detail: string;
  occurredAt: string;
  href: string;
  read: boolean;
};

/**
 * 两组分开截断。合并成一组再切，较新的新闻会把一条待办挤出页面——角标说
 * 「1 项待处理」，页面上却找不到它。
 */
export type NotificationFeed = {
  actions: NotificationItem[];
  news: NotificationItem[];
  unreadActionCount: number;
  unreadNewsCount: number;
  overflow: { actions: number; news: number };
  /** 「最近 N 天」里的 N，由服务端给出，界面不自己写死。 */
  windowDays: number;
  generatedAt: string;
};

/** 标为已读时两组都要带上，否则「全部」只标了一半。 */
export function allNotificationItems(
  feed: NotificationFeed
): NotificationItem[] {
  return [...feed.actions, ...feed.news];
}

/**
 * A failure the page has to tell apart from "nothing waiting".
 *
 * A 401 means the feed exists but this reader is not signed in; a 501 means
 * this deployment has no notification centre at all. Rendering either as an
 * empty inbox would tell the reader their desk is clear when nobody asked.
 */
export class NotificationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "NotificationRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    cache: "no-store",
    ...init
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    // core 的错误体带 `error`，也可能带 `message`（更具体的原因）。两者都可能
    // 是空串——Fastify 默认体就是这样——而 `??` 不会跳过空串，页面就会显示一片
    // 空白。所以取第一个非空白值，再退到状态码。
    throw new NotificationRequestError(
      [payload?.message, payload?.error].find(
        (text): text is string => typeof text === "string" && text.trim() !== ""
      ) ?? `请求失败（${response.status}）`,
      response.status
    );
  }
  return (await response.json()) as T;
}

export function listNotifications(): Promise<NotificationFeed> {
  return request<NotificationFeed>("/api/notifications");
}

export async function markNotificationsRead(keys: string[]): Promise<number> {
  const result = await request<{ marked: number }>("/api/notifications/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keys })
  });
  return result.marked;
}

/**
 * The badge's number, or `null` when there is no account to count for.
 *
 * `null` is not `0`. A signed-out visitor and a reader with an empty desk both
 * arrive as zero, and only one of them should produce a badge at all, so the
 * server says which case it is and this returns `null` for the first. Failures
 * fold into `null` too: a bar that shows a broken count is worse than a bar
 * that shows none.
 */
export async function getUnreadNotificationCount(): Promise<number | null> {
  try {
    const response = await fetch(`${apiUrl}/api/notifications/unread-count`, {
      cache: "no-store"
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      unreadCount?: number;
      authenticated?: boolean;
    };
    if (payload.authenticated === false) return null;
    return typeof payload.unreadCount === "number" ? payload.unreadCount : null;
  } catch {
    return null;
  }
}
