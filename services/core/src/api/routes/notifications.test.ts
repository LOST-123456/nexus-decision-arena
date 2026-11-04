import { describe, expect, it, vi } from "vitest";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";

/**
 * The notification API's contracts.
 *
 * Three of them matter more than the happy path:
 *   * an anonymous caller is refused rather than shown an empty list, because
 *     "nothing waiting" and "you are not signed in" are different facts;
 *   * the list is filtered by the same access decision the session guard uses,
 *     so a card can never name a research its reader would get a 404 on;
 *   * read state is per account, and a deployment without accounts says so
 *     instead of writing markers against nobody.
 */

const SESSION_ID = "00000000-0000-7000-8000-000000000901";
const MEMBERSHIP_ID = "00000000-0000-7000-8000-000000000902";
const RUN_ID = "00000000-0000-7000-8000-000000000903";

function fakeAuth(signedIn: boolean) {
  return {
    userFromRequest: () =>
      signedIn
        ? {
            id: "user-1",
            username: "researcher",
            displayName: "Researcher One",
            role: "owner" as const
          }
        : null
  } as never;
}

function invitationRow() {
  return {
    membershipId: MEMBERSHIP_ID,
    sessionId: SESSION_ID,
    researchQuestion: "采购周期是否支持 12 个月试点？",
    role: "editor",
    invitedBy: "owner (owner)",
    invitedAt: "2026-10-27T08:00:00.000Z"
  };
}

function failedRunRow() {
  return {
    runId: RUN_ID,
    sessionId: SESSION_ID,
    researchQuestion: "采购周期是否支持 12 个月试点？",
    error: "model timeout",
    attempt: 1,
    startedAt: "2026-10-27T09:00:00.000Z"
  };
}

function commentRow() {
  return {
    commentId: "00000000-0000-7000-8000-000000000904",
    sessionId: SESSION_ID,
    researchQuestion: "采购周期是否支持 12 个月试点？",
    authorUserId: "reviewer-a",
    targetType: "claim",
    body: "这条主张只覆盖了一个城市。",
    createdAt: "2026-10-27T10:00:00.000Z"
  };
}

function versionRow() {
  return {
    snapshotId: "00000000-0000-7000-8000-000000000905",
    sessionId: SESSION_ID,
    researchQuestion: "采购周期是否支持 12 个月试点？",
    version: 2,
    createdBy: "reviewer-a",
    changeReason: "补充来源",
    createdAt: "2026-10-27T11:00:00.000Z"
  };
}

function buildApp(options: {
  signedIn?: boolean;
  configured?: boolean;
  readKeys?: string[];
  marks?: string[][];
  runSessionIds?: unknown;
  session?: Record<string, unknown> | null;
  /** 默认给一条评论和一个新版本,让「新闻」那一组有东西可断言。 */
  withNews?: boolean;
  commentRows?: unknown[];
} = {}) {
  const marks = options.marks ?? [];
  const withNews = options.withNews ?? false;
  const commentArgs: unknown[][] = [];
  const calls: { commentSince?: unknown } = {};
  const app = createApp({
    auth: fakeAuth(options.signedIn ?? true),
    sessions: {
      getById: vi.fn().mockResolvedValue(
        options.session === null
          ? null
          : {
              id: SESSION_ID,
              phase: "ANALYZING",
              ownershipChecked: true,
              ownerUserId: "user-1",
              ...(options.session ?? {})
            }
      )
    } as never,
    /**
     * The access decision reads persisted ownership through `sessionHistory`,
     * which is what `readableSessionIds` composes from. Without it the caller
     * may read nothing — and the centre must then show nothing.
     */
    sessionHistory: {
      listSessionIdsForOwner: vi.fn().mockResolvedValue([SESSION_ID]),
      listOwnerlessSessionIds: vi.fn().mockResolvedValue([])
    } as never,
    inspector: {} as never,
    events: {} as never,
    runSession: {} as never,
    ...(options.configured === false
      ? {}
      : {
          notifications: {
            listPendingInvitations: vi.fn().mockResolvedValue([invitationRow()]),
            listPendingReviewRequests: vi.fn().mockResolvedValue([]),
            listFailedRuns: vi.fn(async (ids: unknown) => {
              options.runSessionIds = ids;
              return [failedRunRow()];
            }),
            listRecentComments: vi.fn(
              async (...args: unknown[]) => {
                commentArgs.push(args);
                calls.commentSince = args[2];
                return options.commentRows ?? (withNews ? [commentRow()] : []);
              }
            ),
            listRecentVersions: vi.fn().mockResolvedValue(
              withNews ? [versionRow()] : []
            ),
            listReadKeys: vi.fn().mockResolvedValue(options.readKeys ?? []),
            markRead: vi.fn(async (_userId: string, keys: string[]) => {
              marks.push(keys);
            })
          } as never
        })
  });
  return { app, marks, commentArgs, calls };
}

type FeedBody = {
  actions: Array<{
    key: string;
    kind: string;
    urgency: string;
    read: boolean;
    title: string;
  }>;
  news: Array<{ key: string; kind: string; urgency: string }>;
  unreadActionCount: number;
  unreadNewsCount: number;
  overflow: { actions: number; news: number };
  windowDays: number;
};

describe("GET /api/notifications", () => {
  it("refuses an anonymous caller instead of showing an empty inbox", async () => {
    const { app } = buildApp({ signedIn: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/notifications"
    });
    expect(response.statusCode).toBe(401);
  });

  it("says the centre is unavailable when it is not configured, rather than lying empty", async () => {
    const { app } = buildApp({ configured: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/notifications"
    });
    expect(response.statusCode).toBe(501);
  });

  it("groups the invitation and the failed run as things waiting on you", async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/notifications"
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<FeedBody>();
    expect(body.actions.map((entry) => entry.kind)).toEqual([
      "run-failed",
      "invitation"
    ]);
    // Both are things the reader has to do something about.
    expect(body.actions.every((entry) => entry.urgency === "action")).toBe(true);
    expect(body.unreadActionCount).toBe(2);
  });

  it("keeps comments and versions in their own group", async () => {
    const { app } = buildApp({ withNews: true });
    const body = (
      await app.inject({ method: "GET", url: "/api/notifications" })
    ).json<FeedBody>();

    expect(body.news.map((entry) => entry.kind)).toEqual(["version", "comment"]);
    expect(body.news.every((entry) => entry.urgency === "news")).toBe(true);
    // Reading news is not a task, so it never appears among the waiting items.
    expect(body.actions.some((entry) => entry.kind === "comment")).toBe(false);
    expect(body.windowDays).toBeGreaterThan(0);
  });

  it("carries the read marker through to the card", async () => {
    const { app } = buildApp({ readKeys: [`invitation:${MEMBERSHIP_ID}`] });
    const body = (
      await app.inject({ method: "GET", url: "/api/notifications" })
    ).json<FeedBody>();

    expect(body.actions.find((entry) => entry.kind === "invitation")?.read).toBe(
      true
    );
    expect(body.unreadActionCount).toBe(1);
  });

  it("asks for runs only in researches the caller may read", async () => {
    const options: { runSessionIds?: unknown } = {};
    const { app } = buildApp(options);
    await app.inject({ method: "GET", url: "/api/notifications" });

    // The ids come from `readableSessionIds`, i.e. from persisted ownership —
    // never from anything the caller sent, and never "all" by accident.
    expect(options.runSessionIds).toEqual([SESSION_ID]);
  });

  it("scopes comments to the same readable set, and passes a real window", async () => {
    const { app, commentArgs } = buildApp({ withNews: true });
    await app.inject({ method: "GET", url: "/api/notifications" });

    // Same scope as the runs: one access decision, used by every source.
    expect(commentArgs[0]?.[0]).toEqual([SESSION_ID]);
    // "Not mine" needs to know who "I" am.
    expect(commentArgs[0]?.[1]).toBe("user-1");
    // And the window is a timestamp, not the string "recent".
    expect(typeof commentArgs[0]?.[2]).toBe("string");
    expect(Number.isNaN(Date.parse(String(commentArgs[0]?.[2])))).toBe(false);
  });
});

describe("GET /api/notifications/unread-count", () => {
  it("returns the number the badge needs, and nothing else", async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/notifications/unread-count"
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toEqual({ unreadCount: 2, authenticated: true });
    // No cards: the bar renders a dot, not a feed.
    expect(body).not.toHaveProperty("items");
  });

  it("counts only what is still unread", async () => {
    const { app } = buildApp({ readKeys: [`invitation:${MEMBERSHIP_ID}`] });
    const body = (
      await app.inject({
        method: "GET",
        url: "/api/notifications/unread-count"
      })
    ).json<{ unreadCount: number }>();

    expect(body.unreadCount).toBe(1);
  });

  it("counts only actions, so the dot cannot become permanent decoration", async () => {
    const { app } = buildApp({ withNews: true });
    const body = (
      await app.inject({
        method: "GET",
        url: "/api/notifications/unread-count"
      })
    ).json<{ unreadCount: number }>();

    // Two invitations/runs plus two unseen news items; the badge says two.
    // Counting the comments too would leave the dot on forever on any active
    // research, and a dot that is always on is a dot nobody reads.
    expect(body.unreadCount).toBe(2);
  });

  it("tells a signed-out caller apart from one with nothing waiting", async () => {
    // Both would render 0. Only one of them is a real zero, so the flag is the
    // difference between "no badge" and "a badge that happens to be empty".
    const { app } = buildApp({ signedIn: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/notifications/unread-count"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ unreadCount: 0, authenticated: false });
  });

  it("says the centre is unavailable rather than reporting zero", async () => {
    const { app } = buildApp({ configured: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/notifications/unread-count"
    });
    expect(response.statusCode).toBe(501);
  });
});

describe("POST /api/notifications/read", () => {
  it("records the keys it was given", async () => {
    const { app, marks } = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      payload: { keys: ["invitation:a", "run-failed:b"] },
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ marked: 2 });
    expect(marks[0]).toEqual(["invitation:a", "run-failed:b"]);
  });

  it("accepts an empty list without pretending it marked anything", async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      payload: { keys: [] },
      headers: { "sec-fetch-site": "same-origin" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ marked: 0 });
  });

  it("refuses unknown fields instead of ignoring a typo'd request", async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      payload: { key: ["invitation:a"] },
      headers: { "sec-fetch-site": "same-origin" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses an anonymous caller", async () => {
    const { app } = buildApp({ signedIn: false });
    const response = await app.inject({
      method: "POST",
      url: "/api/notifications/read",
      payload: { keys: [newId()] },
      headers: { "sec-fetch-site": "same-origin" }
    });
    expect(response.statusCode).toBe(401);
  });
});
