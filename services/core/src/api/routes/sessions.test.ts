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

describe("session routes", () => {
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
});
