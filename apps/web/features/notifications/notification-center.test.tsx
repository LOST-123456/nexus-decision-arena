import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationFeed, NotificationItem } from "./api";

/**
 * What the message page must never do: tell a reader their desk is clear when
 * the feed was never read.
 *
 * A 401, a 501 and a genuinely empty inbox are three different facts, and the
 * bug this file exists to prevent is collapsing them into one friendly sentence
 * with nothing behind it. The other half is the read marker: looking at the
 * list is not dealing with it, so opening the page must not mark anything.
 *
 * This round added a second half to the contract: **waiting and news are drawn
 * apart**. A comment nobody read is not something the reader is behind on, and
 * a page that mixes the two lets fifty recent comments push the one pending
 * invitation out of sight while the badge still says one thing is waiting.
 */

const listNotifications = vi.fn();
const markNotificationsRead = vi.fn();

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    listNotifications: (...args: unknown[]) => listNotifications(...args),
    markNotificationsRead: (...args: unknown[]) => markNotificationsRead(...args)
  };
});

const { NotificationCenter } = await import("./notification-center");

function feed(overrides: Partial<NotificationFeed> = {}): NotificationFeed {
  return {
    actions: [],
    news: [],
    unreadActionCount: 0,
    unreadNewsCount: 0,
    overflow: { actions: 0, news: 0 },
    windowDays: 7,
    generatedAt: "2026-10-27T10:00:00.000Z",
    ...overrides
  };
}

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    key: "invitation:m1",
    kind: "invitation",
    urgency: "action",
    sessionId: "s1",
    title: "采购周期是否支持 12 个月试点？",
    detail: "owner 邀请你以「编辑者」身份加入这项研究，等待你接受。",
    occurredAt: "2026-10-27T08:00:00.000Z",
    href: "/research/s1",
    read: false,
    ...overrides
  };
}

function newsItem(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return item({
    key: "comment:c1",
    kind: "comment",
    urgency: "news",
    detail: "reviewer-a 在主张下评论：证据只覆盖了一个城市。",
    occurredAt: "2026-10-27T10:00:00.000Z",
    ...overrides
  });
}

beforeEach(() => {
  listNotifications.mockReset();
  markNotificationsRead.mockReset();
});

afterEach(cleanup);

describe("NotificationCenter", () => {
  it("offers a way in when the reader is not signed in, not an empty inbox", async () => {
    const { NotificationRequestError } = await import("./api");
    listNotifications.mockRejectedValue(
      new NotificationRequestError("Authentication required", 401)
    );

    render(<NotificationCenter />);

    await waitFor(() => {
      expect(screen.getByTestId("notifications-error")).toBeTruthy();
    });
    expect(screen.getByRole("link", { name: "去登录" })).toBeTruthy();
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
  });

  it("says the centre is not enabled rather than pretending nothing is waiting", async () => {
    const { NotificationRequestError } = await import("./api");
    listNotifications.mockRejectedValue(
      new NotificationRequestError("Notification centre unavailable", 501)
    );

    render(<NotificationCenter />);

    await waitFor(() => {
      expect(screen.getByText("这个部署没有启用消息中心。")).toBeTruthy();
    });
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
  });

  it("says the inbox is empty only when the server said so", async () => {
    listNotifications.mockResolvedValue(feed());
    render(<NotificationCenter />);

    await waitFor(() => {
      expect(screen.getByTestId("notifications-empty")).toBeTruthy();
    });
    expect(screen.getByTestId("notifications-unread").textContent).toBe(
      "没有待处理项"
    );
  });

  it("draws waiting and news apart, and says which is which", async () => {
    listNotifications.mockResolvedValue(
      feed({
        actions: [item(), item({ key: "review-request:r1", kind: "review-request" })],
        news: [newsItem(), newsItem({ key: "version:v1", kind: "version" })],
        unreadActionCount: 2,
        unreadNewsCount: 2
      })
    );

    render(<NotificationCenter />);

    await waitFor(() => {
      expect(screen.getAllByTestId("notification-item")).toHaveLength(4);
    });
    const actions = screen.getByTestId("notifications-actions");
    const news = screen.getByTestId("notifications-news");
    // The two groups are separate sections, and a comment is never filed
    // under "things waiting on you".
    expect(within(actions).getAllByTestId("notification-item")).toHaveLength(2);
    expect(within(news).getAllByTestId("notification-item")).toHaveLength(2);
    expect(actions.textContent).not.toContain("新评论");
    expect(news.textContent).not.toContain("协作邀请");
    // The heading's number counts waiting, matching the badge.
    expect(screen.getByTestId("notifications-unread").textContent).toBe(
      "2 项待处理"
    );
  });

  it("shows each item with its kind and whether it was read", async () => {
    listNotifications.mockResolvedValue(
      feed({
        actions: [
          item(),
          item({ key: "run-failed:r1", kind: "run-failed", read: true })
        ],
        unreadActionCount: 1
      })
    );

    render(<NotificationCenter />);

    await waitFor(() => {
      expect(screen.getAllByTestId("notification-item")).toHaveLength(2);
    });
    const rows = screen.getAllByTestId("notification-item");
    expect(rows[0]?.getAttribute("data-read")).toBe("false");
    expect(rows[1]?.getAttribute("data-read")).toBe("true");
    expect(screen.getByText("协作邀请")).toBeTruthy();
    expect(screen.getByText("运行失败")).toBeTruthy();
    // Exactly one 未读 marker, for the unread row.
    expect(screen.getAllByText("未读")).toHaveLength(1);
    expect(screen.getByTestId("notifications-unread").textContent).toBe(
      "1 项待处理"
    );
  });

  it("takes the window from the server rather than hard-coding one", async () => {
    listNotifications.mockResolvedValue(
      feed({ news: [newsItem()], windowDays: 30 })
    );
    render(<NotificationCenter />);

    await waitFor(() => {
      expect(screen.getByTestId("notifications-news").textContent).toContain(
        "最近 30 天"
      );
    });
  });

  it("does not mark anything read just because the page was opened", async () => {
    listNotifications.mockResolvedValue(
      feed({ actions: [item()], unreadActionCount: 1 })
    );

    render(<NotificationCenter />);
    await waitFor(() => {
      expect(screen.getAllByTestId("notification-item")).toHaveLength(1);
    });

    expect(markNotificationsRead).not.toHaveBeenCalled();
  });

  it("marks only the unread items, in both groups, and re-reads the feed", async () => {
    listNotifications
      .mockResolvedValueOnce(
        feed({
          actions: [item(), item({ key: "run-failed:r1", read: true })],
          news: [newsItem()],
          unreadActionCount: 1,
          unreadNewsCount: 1
        })
      )
      .mockResolvedValueOnce(feed());
    markNotificationsRead.mockResolvedValue(2);

    render(<NotificationCenter />);
    await waitFor(() => {
      expect(screen.getAllByTestId("notification-item")).toHaveLength(3);
    });

    fireEvent.click(screen.getByTestId("notifications-mark-all"));

    await waitFor(() => {
      // Both groups: "全部" that only marks the waiting half is not "全部".
      expect(markNotificationsRead).toHaveBeenCalledWith([
        "invitation:m1",
        "comment:c1"
      ]);
    });
    await waitFor(() => {
      expect(screen.getByTestId("notifications-empty")).toBeTruthy();
    });
  });

  it("disables the mark-all control when there is nothing unread", async () => {
    listNotifications.mockResolvedValue(
      feed({ actions: [item({ read: true })], unreadActionCount: 0 })
    );

    render(<NotificationCenter />);
    await waitFor(() => {
      expect(screen.getByTestId("notifications-mark-all")).toBeTruthy();
    });
    expect(
      (screen.getByTestId("notifications-mark-all") as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("reports how many items did not fit on the page", async () => {
    listNotifications.mockResolvedValue(
      feed({
        actions: [item()],
        unreadActionCount: 51,
        overflow: { actions: 1, news: 0 }
      })
    );

    render(<NotificationCenter />);
    await waitFor(() => {
      expect(screen.getByText("另有 1 项待处理未在此列出。")).toBeTruthy();
    });
  });

  it("gives the two groups their own empty sentences", async () => {
    listNotifications.mockResolvedValue(
      feed({ actions: [item()], news: [], unreadActionCount: 1 })
    );

    render(<NotificationCenter />);
    await waitFor(() => {
      expect(screen.getByTestId("notifications-news-empty")).toBeTruthy();
    });
    // The news group being empty is not the same fact as the whole page being
    // empty, and it must not borrow that sentence.
    expect(screen.queryByTestId("notifications-empty")).toBeNull();
    expect(screen.getByTestId("notifications-news-empty").textContent).toContain(
      "没有新评论或新版本"
    );
  });
});
