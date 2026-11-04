import { describe, expect, it, vi } from "vitest";
import { newId } from "@nexus/shared";
import { InvalidSessionCursorError } from "@nexus/db";
import { createApp } from "../../app";

const createPayload = {
  project: {
    name: "Lab Safety",
    summary: "AI inventory platform",
    targetUsers: "University labs",
    businessModel: "Annual subscription",
    expectedData: "200 labs in 24 months"
  },
  locale: "zh-CN"
} as const;

const flushAsyncWork = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe("session routes", () => {
  it("allows the configured web origin for browser transport", async () => {
    const app = createApp(
      {
        sessions: {} as never,
        inspector: {} as never,
        events: {} as never,
        runSession: {} as never
      },
      undefined,
      { webOrigin: "http://localhost:4321" }
    );

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/sessions",
      headers: {
        origin: "http://localhost:4321",
        "access-control-request-method": "POST"
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:4321"
    );
  });

  it("creates and starts a session once", async () => {
    const sessionId = newId();
    const sessions = {
      createWithProject: vi.fn().mockResolvedValue({ id: sessionId }),
      getById: vi.fn().mockResolvedValue({ id: sessionId })
    };
    const start = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      sessions: sessions as never,
      inspector: {} as never,
      events: {} as never,
      runSession: { start } as never
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": "create-1" },
      payload: createPayload
    });
    expect(created.statusCode).toBe(201);

    const replay = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": "create-1" },
      payload: createPayload
    });
    expect(replay.statusCode).toBe(201);
    expect(sessions.createWithProject).toHaveBeenCalledTimes(1);

    const started = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/start`,
      headers: { "idempotency-key": "start-1" }
    });
    expect(started.statusCode).toBe(202);

    const startReplay = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/start`,
      headers: { "idempotency-key": "start-1" }
    });
    expect(startReplay.statusCode).toBe(202);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("shares one create operation across concurrent requests", async () => {
    const sessionId = newId();
    let signalStarted!: () => void;
    let releaseOperation!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const createWithProject = vi.fn(async () => {
      signalStarted();
      await operationGate;
      return { id: sessionId };
    });
    const app = createApp({
      sessions: { createWithProject } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });

    const first = app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": "concurrent-create" },
      payload: createPayload
    });
    const second = app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": "concurrent-create" },
      payload: createPayload
    });
    await operationStarted;
    await flushAsyncWork();

    const callCount = createWithProject.mock.calls.length;
    releaseOperation();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(callCount).toBe(1);
    expect(firstResponse.statusCode).toBe(201);
    expect(secondResponse.statusCode).toBe(201);
    expect(firstResponse.json()).toEqual(secondResponse.json());
  });

  it("shares one start operation across concurrent requests", async () => {
    const sessionId = newId();
    let signalStarted!: () => void;
    let releaseOperation!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const start = vi.fn(async () => {
      signalStarted();
      await operationGate;
    });
    const app = createApp({
      sessions: {
        getById: vi.fn().mockResolvedValue({ id: sessionId })
      } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: { start } as never
    });

    const first = app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/start`,
      headers: { "idempotency-key": "concurrent-start" }
    });
    const second = app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/start`,
      headers: { "idempotency-key": "concurrent-start" }
    });
    await operationStarted;
    await flushAsyncWork();

    const callCount = start.mock.calls.length;
    releaseOperation();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(callCount).toBe(1);
    expect(firstResponse.statusCode).toBe(202);
    expect(secondResponse.statusCode).toBe(202);
    expect(firstResponse.json()).toEqual(secondResponse.json());
  });

  it("returns 409 when a key is reused for a different create request", async () => {
    const createWithProject = vi.fn().mockResolvedValue({ id: newId() });
    const app = createApp({
      sessions: { createWithProject } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": "create-conflict" },
      payload: createPayload
    });
    const conflicted = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": "create-conflict" },
      payload: {
        ...createPayload,
        project: {
          ...createPayload.project,
          name: "Different project"
        }
      }
    });

    expect(created.statusCode).toBe(201);
    expect(conflicted.statusCode).toBe(409);
    expect(createWithProject).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when a key is reused for a different start request", async () => {
    const firstSessionId = newId();
    const secondSessionId = newId();
    const start = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      sessions: {
        getById: vi.fn().mockResolvedValue({ id: firstSessionId })
      } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: { start } as never
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/sessions/${firstSessionId}/start`,
      headers: { "idempotency-key": "start-conflict" }
    });
    const conflicted = await app.inject({
      method: "POST",
      url: `/api/sessions/${secondSessionId}/start`,
      headers: { "idempotency-key": "start-conflict" }
    });

    expect(started.statusCode).toBe(202);
    expect(conflicted.statusCode).toBe(409);
    expect(start).toHaveBeenCalledTimes(1);
  });
  it("validates the project input before creating a session", async () => {
    const createWithProject = vi.fn();
    const app = createApp({
      sessions: { createWithProject } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "idempotency-key": "invalid-create" },
      payload: {
        project: {
          ...createPayload.project,
          name: ""
        }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(createWithProject).not.toHaveBeenCalled();
  });

  it("returns 404 from the inspector route when the claim is missing", async () => {
    const sessionId = newId();
    const claimId = newId();
    const getInspector = vi.fn().mockResolvedValue(null);
    const app = createApp({
      sessions: {} as never,
      inspector: { getInspector } as never,
      events: {} as never,
      runSession: {} as never
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/claims/${claimId}/inspector`
    });

    expect(response.statusCode).toBe(404);
    expect(getInspector).toHaveBeenCalledWith(sessionId, claimId);
  });

  it("returns the persisted session view used by the live workspace", async () => {
    const sessionId = newId();
    const view = {
      sessionId,
      phase: "HUMAN_REVIEW",
      operationalStatus: "PAUSED",
      agents: [],
      claims: [],
      evidence: [],
      challenges: [],
      conflicts: [],
      humanDecisions: [],
      currentConclusion: "暂缓规模化扩张"
    };
    const app = createApp({
      sessions: {
        getView: vi.fn().mockResolvedValue(view)
      } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(view);
  });
});

/**
 * Deleting a research asks a second question after "may I read it?".
 *
 * Being able to read is shared on purpose — collaborators and share grantees
 * open the workspace every day — but erasing it is not a collaboration verb.
 * The old rule only looked at the caller's global role, so a researcher could
 * not delete their own research while any `owner`-role account could delete
 * anybody's.
 */
describe("delete permission", () => {
  const sessionId = newId();

  function appFor(options: {
    /** `undefined` = no identity system at all; `null` = signed out. */
    user?: { id: string; role: "owner" | "reviewer" | "viewer" } | null;
    ownerUserId?: string | null;
    membership?: { role: string } | null;
    deleteById?: ReturnType<typeof vi.fn>;
    getById?: ReturnType<typeof vi.fn>;
  }) {
    const deleteById = options.deleteById ?? vi.fn().mockResolvedValue(true);
    const getById =
      options.getById ??
      vi
        .fn()
        .mockResolvedValue({
          id: sessionId,
          ownerUserId:
            options.ownerUserId === undefined ? "user-researcher" : options.ownerUserId
        });
    const app = createApp({
      ...(options.user === undefined
        ? {}
        : {
            auth: {
              userFromRequest: () => options.user ?? null
            } as never
          }),
      sessions: { getById } as never,
      sessionHistory: { deleteById } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never,
      ...(options.membership === undefined
        ? {}
        : {
            teamCollaboration: {
              getLiveMembership: vi.fn().mockResolvedValue(options.membership)
            } as never
          })
    });
    return { app, deleteById };
  }

  it("lets a researcher delete the research they own", async () => {
    const { app, deleteById } = appFor({
      user: { id: "user-researcher", role: "reviewer" }
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`
    });

    expect(response.statusCode).toBe(204);
    expect(deleteById).toHaveBeenCalledWith(sessionId);
  });

  it("refuses a collaborator who can read but does not own it", async () => {
    const { app, deleteById } = appFor({
      user: { id: "user-collaborator", role: "reviewer" },
      membership: { role: "editor" }
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe(
      "Only the session owner can delete this research"
    );
    expect(deleteById).not.toHaveBeenCalled();
  });

  it("lets the deployment administrator retire a legacy research with no owner", async () => {
    const { app, deleteById } = appFor({
      user: { id: "user-admin", role: "owner" },
      ownerUserId: null
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`
    });

    expect(response.statusCode).toBe(204);
    expect(deleteById).toHaveBeenCalledWith(sessionId);
  });

  it("answers 401 to an anonymous caller", async () => {
    const { app, deleteById } = appFor({ user: null });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`
    });

    expect(response.statusCode).toBe(401);
    expect(deleteById).not.toHaveBeenCalled();
  });

  it("answers 404 — not 403 — to a caller who cannot even read it", async () => {
    const { app, deleteById } = appFor({
      user: { id: "user-stranger", role: "reviewer" }
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("session_not_found");
    expect(deleteById).not.toHaveBeenCalled();
  });

  it("answers 404 when the research is gone by the time the delete runs", async () => {
    const getById = vi
      .fn()
      .mockResolvedValueOnce({ id: sessionId, ownerUserId: "user-researcher" })
      .mockResolvedValueOnce(null);
    const { app, deleteById } = appFor({
      user: { id: "user-researcher", role: "reviewer" },
      getById
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}`
    });

    expect(response.statusCode).toBe(404);
    expect(deleteById).not.toHaveBeenCalled();
  });
});

/**
 * Editing the research question.
 *
 * A research whose question was never filled in shows "（未填写研究问题）" in the
 * workspace and in its report, and before this there was no way to correct it:
 * the question could only be set once, when the research was created.
 */
describe("research question editing", () => {
  const sessionId = newId();

  function appFor(options: {
    user?: { id: string; role: "owner" | "reviewer" | "viewer" } | null;
    ownerUserId?: string | null;
    membership?: { role: string } | null;
    setResearchQuestion?: ReturnType<typeof vi.fn>;
  }) {
    const setResearchQuestion =
      options.setResearchQuestion ??
      vi
        .fn()
        .mockImplementation(async (id: string, researchQuestion: string) => ({
          sessionId: id,
          researchQuestion
        }));
    const app = createApp({
      ...(options.user === undefined
        ? {}
        : { auth: { userFromRequest: () => options.user ?? null } as never }),
      sessions: {
        getById: vi.fn().mockResolvedValue({
          id: sessionId,
          ownerUserId:
            options.ownerUserId === undefined
              ? "user-researcher"
              : options.ownerUserId
        })
      } as never,
      sessionHistory: { setResearchQuestion } as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never,
      ...(options.membership === undefined
        ? {}
        : {
            teamCollaboration: {
              getLiveMembership: vi.fn().mockResolvedValue(options.membership)
            } as never
          })
    });
    return { app, setResearchQuestion };
  }

  function patch(
    app: ReturnType<typeof createApp>,
    payload: unknown = { researchQuestion: "第四季度出货量是否真实增长？" }
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}`,
      headers: { "idempotency-key": "question-1" },
      payload: payload as never
    });
  }

  it("lets the researcher who owns the research rewrite its question", async () => {
    const { app, setResearchQuestion } = appFor({
      user: { id: "user-researcher", role: "reviewer" }
    });

    const response = await patch(app);

    expect(response.statusCode).toBe(200);
    expect(response.json().researchQuestion).toBe("第四季度出货量是否真实增长？");
    expect(setResearchQuestion).toHaveBeenCalledWith(
      sessionId,
      "第四季度出货量是否真实增长？"
    );
  });

  it("trims the text before it is stored", async () => {
    const { app, setResearchQuestion } = appFor({
      user: { id: "user-researcher", role: "reviewer" }
    });

    await patch(app, { researchQuestion: "  出货量增长了吗？  " });

    expect(setResearchQuestion).toHaveBeenCalledWith(
      sessionId,
      "出货量增长了吗？"
    );
  });

  it("rejects an empty question instead of blanking the field", async () => {
    const { app, setResearchQuestion } = appFor({
      user: { id: "user-researcher", role: "reviewer" }
    });

    for (const researchQuestion of ["", "   "]) {
      const response = await patch(app, { researchQuestion });
      expect(response.statusCode).toBe(400);
    }
    expect(setResearchQuestion).not.toHaveBeenCalled();
  });

  it("rejects anything that is not the question", async () => {
    const { app, setResearchQuestion } = appFor({
      user: { id: "user-researcher", role: "reviewer" }
    });

    const response = await patch(app, {
      researchQuestion: "出货量增长了吗？",
      currentConclusion: "改写结论"
    });

    // A field the schema does not name must not reach the row as a side door.
    expect(response.statusCode).toBe(400);
    expect(setResearchQuestion).not.toHaveBeenCalled();
  });

  it("requires an idempotency key like every other write", async () => {
    const { app, setResearchQuestion } = appFor({
      user: { id: "user-researcher", role: "reviewer" }
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}`,
      payload: { researchQuestion: "出货量增长了吗？" } as never
    });

    expect(response.statusCode).toBe(400);
    expect(setResearchQuestion).not.toHaveBeenCalled();
  });

  it("lets an editor collaborator edit, and refuses a viewer member", async () => {
    const editor = appFor({
      user: { id: "user-editor", role: "reviewer" },
      membership: { role: "editor" }
    });
    expect((await patch(editor.app)).statusCode).toBe(200);

    const viewer = appFor({
      user: { id: "user-viewer", role: "reviewer" },
      membership: { role: "viewer" }
    });
    const refused = await patch(viewer.app);
    expect(refused.statusCode).toBe(403);
    expect(viewer.setResearchQuestion).not.toHaveBeenCalled();
  });

  it("answers 404 — not 403 — to a caller who cannot read the research", async () => {
    const { app, setResearchQuestion } = appFor({
      user: { id: "user-stranger", role: "reviewer" }
    });

    const response = await patch(app);

    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("session_not_found");
    expect(setResearchQuestion).not.toHaveBeenCalled();
  });

  it("answers 401 to an anonymous caller", async () => {
    const { app, setResearchQuestion } = appFor({ user: null });
    expect((await patch(app)).statusCode).toBe(401);
    expect(setResearchQuestion).not.toHaveBeenCalled();
  });
});

/**
 * The list contract.
 *
 * The endpoint used to answer with a bare array of at most fifty rows and
 * nothing saying there were more, which is how a screen ends up printing a page
 * size as a total. These pin down the two things that replaced it: the window
 * is described in the response, and a cursor this endpoint did not issue is
 * refused instead of being read as "start over".
 */
describe("GET /api/sessions · 分页", () => {
  const row = (id: string) => ({
    id,
    projectId: "project-1",
    projectName: `研究 ${id}`,
    phase: "CREATED",
    operationalStatus: "ACTIVE",
    currentConclusion: null,
    conflictCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z"
  });

  /**
   * The app, with only the paged query faked. `auth` is left out on purpose:
   * no identity system means the operator, which is the one caller whose
   * readable set is the whole workspace and therefore the simplest to assert.
   */
  function appListing(
    listPage: (page: unknown, ids?: readonly string[]) => Promise<unknown>
  ) {
    const calls: Array<{ page: unknown; ids: readonly string[] | undefined }> = [];
    const app = createApp({
      sessions: {} as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never,
      // Present but never called: without an identity system the caller is the
      // operator, whose readable set is the workspace and needs no lookup. It
      // is here because the route refuses to start paging without it.
      sessionHistory: {} as never,
      sessionPages: {
        listPage: (page: never, ids?: never) => {
          calls.push({ page, ids: ids as readonly string[] | undefined });
          return listPage(page, ids) as never;
        }
      } as never
    });
    return { app, calls };
  }

  it("answers with a window, not a bare array", async () => {
    const { app, calls } = appListing(async () => ({
      items: [row("s-1")],
      nextCursor: "1700000000000000|s-1",
      hasNextPage: true
    }));

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions?limit=999"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      // `relation: null` because this app was built without an identity
      // system: there are no accounts, so there is nobody to relate a research
      // to. It is stated rather than omitted — the client must be able to tell
      // "no author to report" from "this field is missing because the server
      // is older than the client".
      sessions: [{ ...row("s-1"), relation: null }],
      nextCursor: "1700000000000000|s-1",
      hasNextPage: true
    });
    // Above the ceiling, the limit is clamped by the shared contract rather
    // than passed through to the query.
    expect(calls[0]?.page).toEqual({ limit: 200 });
    // No restriction, not "restricted to nothing": the operator sees it all.
    expect(calls[0]?.ids).toBeUndefined();
  });

  it("hands the cursor back to the query untouched", async () => {
    const { app, calls } = appListing(async () => ({
      items: [],
      nextCursor: null,
      hasNextPage: false
    }));

    await app.inject({
      method: "GET",
      url: "/api/sessions?limit=2&after=1700000000000000%7Cs-1"
    });

    expect(calls[0]?.page).toEqual({ limit: 2, after: "1700000000000000|s-1" });
  });

  it("answers 400 to a cursor it did not issue, rather than serving page one again", async () => {
    const { app } = appListing(async () => {
      throw new InvalidSessionCursorError();
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions?after=nonsense"
    });

    expect(response.statusCode).toBe(400);
  });

  it("answers 501 when the paged list is not wired", async () => {
    const app = createApp({
      sessions: {} as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    });

    const response = await app.inject({ method: "GET", url: "/api/sessions" });

    expect(response.statusCode).toBe(501);
  });

  it("answers 501 when only half the list is wired, rather than an empty workspace", async () => {
    // The page query without the readable-set filter would answer every
    // signed-in caller with "no research" — a wrong answer that looks like data.
    const app = createApp({
      sessions: {} as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never,
      sessionPages: {
        listPage: async () => ({ items: [], nextCursor: null, hasNextPage: false })
      } as never
    });

    const response = await app.inject({ method: "GET", url: "/api/sessions" });

    expect(response.statusCode).toBe(501);
  });
});

/**
 * 列表上的「为什么你能看见这一条」。
 *
 * 三个来源（自己建的 / 别人共享的 / 被拉进团队的）在权限上是同一个答案，
 * 在要不要点开上完全不同。合并成一个 Set 之后就没法回答这个问题了——这正是
 * 这一组测试要钉住的地方：来源必须一路传到响应里，而且筛选要在取数前收窄。
 */
describe("GET /api/sessions · 来源", () => {
  function row(id: string) {
    return {
      id,
      projectId: `project-${id}`,
      projectName: `研究 ${id}`,
      phase: "CREATED" as const,
      operationalStatus: "ACTIVE" as const,
      currentConclusion: null,
      conflictCount: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z"
    };
  }

  function appFor(options: {
    user?: { id: string; role: "owner" | "reviewer" | "viewer" } | null;
    owned?: string[];
    unowned?: string[];
    granted?: string[];
    member?: string[];
  }) {
    const calls: Array<readonly string[] | undefined> = [];
    const listOwnerlessSessionIds = vi
      .fn()
      .mockResolvedValue(options.unowned ?? []);
    const app = createApp({
      ...(options.user === undefined
        ? {}
        : { auth: { userFromRequest: () => options.user ?? null } as never }),
      sessions: {} as never,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never,
      sessionHistory: {
        listSessionIdsForOwner: vi
          .fn()
          .mockResolvedValue(options.owned ?? []),
        listOwnerlessSessionIds
      } as never,
      sourceLibrary: {
        listGrantedSessionIds: vi
          .fn()
          .mockResolvedValue(options.granted ?? []),
        hasLiveGrant: vi.fn().mockResolvedValue(false)
      } as never,
      teamCollaboration: {
        getLiveMembership: vi.fn().mockResolvedValue(null),
        listSessionIdsForMember: vi
          .fn()
          .mockResolvedValue(options.member ?? [])
      } as never,
      sessionPages: {
        listPage: (_page: never, ids?: readonly string[]) => {
          calls.push(ids);
          return Promise.resolve({
            items: (ids ?? []).map(row),
            nextCursor: null,
            hasNextPage: false
          }) as never;
        }
      } as never
    });
    return { app, calls, listOwnerlessSessionIds };
  }

  it("each row reports the reason it is on the list", async () => {
    const { app } = appFor({
      user: { id: "me", role: "owner" },
      owned: ["mine"],
      granted: ["shared"],
      member: ["team"],
      unowned: ["legacy"]
    });

    const response = await app.inject({ method: "GET", url: "/api/sessions" });
    const sessions = response.json().sessions as Array<{
      id: string;
      relation: string | null;
    }>;

    expect(response.statusCode).toBe(200);
    expect(
      Object.fromEntries(sessions.map((s) => [s.id, s.relation]))
    ).toEqual({
      mine: "owner",
      shared: "granted",
      team: "collaborator",
      legacy: "unowned"
    });
  });

  it("one research reached by two routes reports the stronger reason", async () => {
    // Sharing a research with someone who is also a member must not downgrade
    // it: the ordering is fixed here so the answer does not depend on which
    // query happened to return first.
    const { app } = appFor({
      user: { id: "me", role: "owner" },
      owned: ["both"],
      granted: ["both"],
      member: ["both"]
    });

    const response = await app.inject({ method: "GET", url: "/api/sessions" });

    expect(response.json().sessions[0].relation).toBe("owner");
  });

  it("a reviewer is not handed research nobody owns", async () => {
    // `listOwnerlessSessionIds` belongs to the administrator: `decide()` only
    // admits the `owner` role to an ownerless research, so listing them for a
    // reviewer would produce rows that answer 404 the moment they are opened.
    const { app, calls, listOwnerlessSessionIds } = appFor({
      user: { id: "me", role: "reviewer" },
      owned: ["mine"],
      unowned: ["legacy"]
    });

    const response = await app.inject({ method: "GET", url: "/api/sessions" });

    expect(response.statusCode).toBe(200);
    expect(calls[0]).toEqual(["mine"]);
    expect(listOwnerlessSessionIds).not.toHaveBeenCalled();
  });

  it("relation narrows the query, not the returned page", async () => {
    const { app, calls } = appFor({
      user: { id: "me", role: "owner" },
      owned: ["mine"],
      granted: ["shared"],
      member: ["team"]
    });

    await app.inject({ method: "GET", url: "/api/sessions?relation=granted" });

    // The filter reaches Postgres as a concrete id list. Filtering the page in
    // the browser instead would answer "nothing shared with you" whenever the
    // shared research sits beyond the first window.
    expect(calls[0]).toEqual(["shared"]);
  });

  it("a relation nobody implements is a 400, not a silently unfiltered list", async () => {
    const { app, calls } = appFor({
      user: { id: "me", role: "owner" },
      owned: ["mine"]
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions?relation=somethingElse"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("owner");
    // Nothing was read: the request is refused before the query.
    expect(calls).toHaveLength(0);
  });

  it("an operator deployment has no reasons to report", async () => {
    // No identity system: every row is readable and none of them is "mine".
    const { app } = appFor({ owned: ["mine"], granted: ["shared"] });

    const response = await app.inject({ method: "GET", url: "/api/sessions" });
    const sessions = response.json().sessions as Array<{
      relation: string | null;
    }>;

    expect(response.statusCode).toBe(200);
    expect(sessions.every((s) => s.relation === null)).toBe(true);
  });
});
