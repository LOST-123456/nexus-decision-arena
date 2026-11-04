"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  allNotificationItems,
  listNotifications,
  markNotificationsRead,
  NotificationRequestError,
  type NotificationFeed,
  type NotificationItem
} from "./api";
import { notifyNotificationsChanged } from "./unread-count-badge";

type State =
  | { kind: "loading" }
  | { kind: "ready"; feed: NotificationFeed }
  | { kind: "error"; status: number; message: string };

function whenText(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(parsed);
}

const KIND_LABEL: Record<NotificationItem["kind"], string> = {
  invitation: "协作邀请",
  "review-request": "待你审核",
  "run-failed": "运行失败",
  comment: "新评论",
  version: "新版本"
};

/**
 * 一段卡片列表。两段用的是同一段渲染，因为一条消息长什么样不该取决于它在
 * 哪一组——分组是结构，不是样式。
 */
function ItemList({
  items,
  testId
}: {
  items: readonly NotificationItem[];
  testId: string;
}) {
  return (
    <ul className="research-plain-list" data-testid={testId}>
      {items.map((item) => (
        <li
          key={item.key}
          data-testid="notification-item"
          data-urgency={item.urgency}
          data-read={item.read ? "true" : "false"}
        >
          <div className="research-claim-meta">
            <span className="research-pill research-pill-neutral">
              {KIND_LABEL[item.kind]}
            </span>
            {item.read ? null : (
              <span className="research-pill research-pill-unverified">未读</span>
            )}
            <span className="research-muted">{whenText(item.occurredAt)}</span>
          </div>
          <Link href={item.href}>{item.title}</Link>
          <div>{item.detail}</div>
        </li>
      ))}
    </ul>
  );
}

/**
 * What is waiting on this account, and what merely happened.
 *
 * Every card is a row that already exists: an invitation someone has to accept,
 * a review request somebody is blocked on, a run that failed and needs a retry,
 * a comment somebody wrote, a version somebody saved. Nothing here is a message
 * the system invented, and opening the page never marks anything read — a
 * reader who glances at the list and leaves has not dealt with any of it.
 *
 * The two groups are drawn separately on purpose. `等你处理` is work; `最近动态`
 * is context. Merging them by timestamp — which is what this page used to do —
 * pushed a single pending invitation down the page behind fifty comments, and
 * trained the reader that the red dot means nothing in particular.
 */
export function NotificationCenter() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", feed: await listNotifications() });
    } catch (cause) {
      const status =
        cause instanceof NotificationRequestError ? cause.status : 0;
      setState({
        kind: "error",
        status,
        message:
          cause instanceof Error ? cause.message : "消息读取失败，请稍后重试。"
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function markAllRead(items: readonly NotificationItem[]): Promise<void> {
    const unread = items.filter((item) => !item.read).map((item) => item.key);
    if (unread.length === 0) return;
    setActing(true);
    try {
      await markNotificationsRead(unread);
      // The bar's badge reads its own endpoint, so tell it the answer changed
      // rather than hoping the reader navigates before looking at it.
      notifyNotificationsChanged();
      await load();
    } catch (cause) {
      setState({
        kind: "error",
        status:
          cause instanceof NotificationRequestError ? cause.status : 0,
        message: cause instanceof Error ? cause.message : "标记已读失败。"
      });
    } finally {
      setActing(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="review-list-content">
        <div className="research-empty">正在读取待处理事项…</div>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="review-list-content">
        <p className="research-error" role="alert" data-testid="notifications-error">
          {state.message}
        </p>
        <p className="research-muted" style={{ marginTop: 8 }}>
          {state.status === 401
            ? "消息是给具体账号的：未登录时无法判断哪些事项在等你处理。"
            : state.status === 501
              ? "这个部署没有启用消息中心。"
              : state.status >= 500
                ? "核心 API 在运行，但它背后的数据层暂时不可用。如果是刚启动，等几秒再试一次。"
                : "请确认核心 API 正在运行。"}
        </p>
        <div className="research-actions">
          {state.status === 401 ? (
            <Link className="research-button" href="/login">
              去登录
            </Link>
          ) : null}
          <button
            type="button"
            className="research-button research-button-secondary"
            onClick={() => void load()}
          >
            重新读取
          </button>
        </div>
      </div>
    );
  }

  const { feed } = state;
  const everything = allNotificationItems(feed);
  const totalUnread = feed.unreadActionCount + feed.unreadNewsCount;

  return (
    <div className="review-list-content">
      <div className="review-list-heading">
        <div>
          <p className="research-label">NOTIFICATIONS</p>
          <h1>消息</h1>
        </div>
        {/*
          The number in the heading is the count of things waiting, matching the
          badge. News has its own small count in its own heading: a reader who
          has four unread comments has not fallen behind on anything.
        */}
        <span data-testid="notifications-unread">
          {feed.unreadActionCount > 0
            ? `${feed.unreadActionCount} 项待处理`
            : "没有待处理项"}
        </span>
      </div>

      {everything.length === 0 ? (
        <div className="research-empty" data-testid="notifications-empty">
          这里没有东西。消息页只显示真实存在的事实：等你接受的协作邀请、等你给出结论的
          审核请求、失败的 Agent 运行，以及最近 {feed.windowDays} 天里别人留下的评论和
          新版本。
        </div>
      ) : (
        <>
          <div className="research-actions" style={{ marginTop: "1rem" }}>
            <button
              type="button"
              className="research-button research-button-secondary"
              data-testid="notifications-mark-all"
              disabled={acting || totalUnread === 0}
              onClick={() => void markAllRead(everything)}
            >
              {acting ? "正在标记…" : "全部标为已读"}
            </button>
          </div>

          <section
            className="notifications-group"
            aria-labelledby="notifications-actions-heading"
            data-testid="notifications-actions"
          >
            <div className="notifications-group-head">
              <h2 id="notifications-actions-heading">等你处理</h2>
              <span className="research-muted">
                {feed.unreadActionCount > 0
                  ? `${feed.unreadActionCount} 项未读`
                  : "都已看过"}
              </span>
            </div>
            {feed.actions.length === 0 ? (
              <div
                className="research-empty"
                data-testid="notifications-actions-empty"
              >
                没有等你处理的事项。
              </div>
            ) : (
              <ItemList items={feed.actions} testId="notifications-actions-list" />
            )}
            {feed.overflow.actions > 0 ? (
              <p className="research-muted">
                另有 {feed.overflow.actions} 项待处理未在此列出。
              </p>
            ) : null}
          </section>

          <section
            className="notifications-group"
            aria-labelledby="notifications-news-heading"
            data-testid="notifications-news"
          >
            <div className="notifications-group-head">
              <h2 id="notifications-news-heading">
                最近 {feed.windowDays} 天的新动态
              </h2>
              <span className="research-muted">
                {feed.unreadNewsCount > 0
                  ? `${feed.unreadNewsCount} 项未读`
                  : "都已看过"}
              </span>
            </div>
            {feed.news.length === 0 ? (
              <div
                className="research-empty"
                data-testid="notifications-news-empty"
              >
                最近 {feed.windowDays} 天没有新评论或新版本。更早的动态不会列在这里，
                免得一条三年前的评论和今早的一样「新」。
              </div>
            ) : (
              <ItemList items={feed.news} testId="notifications-news-list" />
            )}
            {feed.overflow.news > 0 ? (
              <p className="research-muted">
                另有 {feed.overflow.news} 项动态未在此列出。
              </p>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
