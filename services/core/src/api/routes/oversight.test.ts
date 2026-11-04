import { describe, expect, it, vi } from "vitest";
import { EMPTY_OVERSIGHT_COUNTS, type OversightCounts } from "@nexus/shared";
import { createApp } from "../../app";

/**
 * `GET /api/oversight` 的三件事，按风险从高到低：
 *
 *  1. 匿名调用者拿到 401，不是一片零。给访客看「0 个分歧」是对一个可能满是
 *     分歧的工作区撒谎，而且同一个人登录后会看到另一套数字，像系统自相矛盾。
 *  2. 统计范围来自 `readableSessionIds` —— 和列表页、消息中心同一处。
 *     这里断言的是「传给仓储的 id 集合」，也就是越权真正会发生的地方。
 *  3. 没接线时 501，而不是零。
 */

const SESSION_A = "0192f0aa-1111-7000-8000-000000000001";
const SESSION_B = "0192f0aa-1111-7000-8000-000000000002";

function fakeAuth(signedIn: boolean, role: "owner" | "reviewer" = "owner") {
  return {
    userFromRequest: () =>
      signedIn
        ? {
            id: "user-1",
            username: "researcher",
            displayName: "Researcher One",
            role
          }
        : null
  } as never;
}

function buildApp(options: {
  signedIn?: boolean;
  role?: "owner" | "reviewer";
  configured?: boolean;
  owned?: string[];
  granted?: string[];
  counts?: Partial<OversightCounts>;
}) {
  const loadCounts = vi.fn(
    async (_sessionIds?: readonly string[]): Promise<OversightCounts> => ({
      ...EMPTY_OVERSIGHT_COUNTS,
      sessionCount: 1,
      conflicts: {
        total: 5,
        requiringHuman: 3,
        awaitingHuman: 2,
        resolved: 1
      },
      decisions: {
        total: 4,
        acceptChallenge: 1,
        upholdClaim: 2,
        requestMoreAnalysis: 1
      },
      runs: {
        total: 10,
        completed: 6,
        failed: 2,
        timedOut: 1,
        cancelled: 1,
        retried: 3
      },
      ...options.counts
    })
  );

  const app = createApp({
    auth: fakeAuth(options.signedIn ?? true, options.role ?? "owner"),
    sessions: {} as never,
    inspector: {} as never,
    events: {} as never,
    runSession: {} as never,
    sessionHistory: {
      listSessionIdsForOwner: vi
        .fn()
        .mockResolvedValue(options.owned ?? [SESSION_A]),
      listOwnerlessSessionIds: vi.fn().mockResolvedValue([])
    } as never,
    sourceLibrary: {
      listGrantedSessionIds: vi
        .fn()
        .mockResolvedValue(options.granted ?? []),
      hasLiveGrant: vi.fn().mockResolvedValue(false)
    } as never,
    ...(options.configured === false ? {} : { oversight: { loadCounts } })
  });

  return { app, loadCounts };
}

describe("GET /api/oversight", () => {
  it("answers a signed-out caller with 401, not with zeroes", async () => {
    const { app, loadCounts } = buildApp({ signedIn: false });

    const response = await app.inject({ method: "GET", url: "/api/oversight" });

    expect(response.statusCode).toBe(401);
    // Nothing was read: the refusal happens before any aggregate query.
    expect(loadCounts).not.toHaveBeenCalled();
  });

  it("counts only the researches the caller may read", async () => {
    const { app, loadCounts } = buildApp({
      owned: [SESSION_A, SESSION_B],
      granted: ["0192f0aa-1111-7000-8000-000000000003"]
    });

    const response = await app.inject({ method: "GET", url: "/api/oversight" });

    expect(response.statusCode).toBe(200);
    // The scoping is the security boundary here: an unscoped aggregate over
    // every account's conflicts is a leak that no screen shows directly.
    //
    // Compared as a set, not as a sequence: which source contributed an id
    // first is an implementation detail of the readable-set lookup, and
    // pinning the order here would make an unrelated refactor look like a
    // security regression.
    expect([...loadCounts.mock.calls[0]![0]!].sort()).toEqual(
      [
        SESSION_A,
        SESSION_B,
        "0192f0aa-1111-7000-8000-000000000003"
      ].sort()
    );
  });

  it("leaves the scope open on a deployment with no identity system", async () => {
    // No `auth` at all is the operator: nobody to distinguish from anybody.
    const loadCounts = vi.fn(async () => EMPTY_OVERSIGHT_COUNTS);
    const app = createApp({
      sessions: {} as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never,
      sessionHistory: {} as never,
      oversight: { loadCounts }
    });

    const response = await app.inject({ method: "GET", url: "/api/oversight" });

    expect(response.statusCode).toBe(200);
    // `undefined`, not `[]`: no restriction, rather than "may read nothing".
    expect(loadCounts).toHaveBeenCalledWith(undefined);
  });

  it("refuses to answer zeroes when the counts were never wired", async () => {
    const { app } = buildApp({ configured: false });

    const response = await app.inject({ method: "GET", url: "/api/oversight" });

    expect(response.statusCode).toBe(501);
  });

  it("returns the counts unchanged for the panel to read", async () => {
    const { app } = buildApp({});

    const response = await app.inject({ method: "GET", url: "/api/oversight" });
    const body = response.json();

    expect(body.conflicts.awaitingHuman).toBe(2);
    expect(body.decisions.acceptChallenge).toBe(1);
    expect(body.runs.retried).toBe(3);
    // Parsed through the shared schema on the way out, so a repository that
    // returns a string count is caught here instead of in a chart.
    expect(typeof body.runs.total).toBe("number");
  });

  it("rejects an out-of-shape count from the repository", async () => {
    const { app } = buildApp({
      counts: {
        conflicts: {
          total: -1,
          requiringHuman: 0,
          awaitingHuman: 0,
          resolved: 0
        }
      }
    });

    const response = await app.inject({ method: "GET", url: "/api/oversight" });

    // 500 rather than a silently rendered negative bar.
    expect(response.statusCode).toBe(500);
  });
});
