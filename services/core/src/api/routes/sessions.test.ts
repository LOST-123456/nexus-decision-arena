import { describe, expect, it, vi } from "vitest";
import { newId } from "@nexus/shared";
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
