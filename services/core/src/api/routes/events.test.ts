import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId, type ExecutionEvent } from "@nexus/shared";
import { createApp } from "../../app";
import { EventBus } from "../../execution/event-bus";

function createEvent(
  sessionId: string,
  sequence: number,
  type: ExecutionEvent["type"] = "SESSION_STATE_CHANGED"
): ExecutionEvent {
  return {
    id: newId(),
    sessionId,
    sequence,
    correlationId: newId(),
    type,
    payload: { sequence },
    occurredAt: new Date().toISOString()
  };
}

async function readUntil(
  response: Response,
  marker: string
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Expected an SSE response body");
  }

  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    body += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return body;
}

describe("SSE replay", () => {
  const apps: Array<ReturnType<typeof createApp>> = [];

  afterEach(async () => {
    await Promise.all(
      apps.splice(0).map(async (app) => {
        app.server.closeAllConnections();
        await app.close();
      })
    );
  });

  it("reads events after Last-Event-ID before subscribing", async () => {
    const sessionId = newId();
    const listAfter = vi.fn().mockResolvedValue([]);
    const app = createApp({
      sessions: {} as never,
      inspector: {} as never,
      events: { listAfter } as never,
      runSession: {} as never
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/sessions/${sessionId}/events/stream`,
      {
        headers: { "last-event-id": "4" },
        signal: controller.signal
      }
    );

    expect(response.status).toBe(200);
    expect(listAfter).toHaveBeenCalledWith(sessionId, 4);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    void response.body?.cancel();
    controller.abort();
  });

  it("prefers ?after and streams replay before live events", async () => {
    const sessionId = newId();
    const eventBus = new EventBus();
    const replay = [createEvent(sessionId, 2), createEvent(sessionId, 3)];
    const listAfter = vi.fn().mockResolvedValue(replay);
    const app = createApp(
      {
        sessions: {} as never,
        inspector: {} as never,
        events: { listAfter } as never,
        runSession: {} as never
      },
      undefined,
      { eventBus }
    );
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/sessions/${sessionId}/events/stream?after=1`,
      {
        headers: { "last-event-id": "9" },
        signal: controller.signal
      }
    );

    expect(listAfter).toHaveBeenCalledWith(sessionId, 1);
    const liveEvent = createEvent(sessionId, 4, "AGENT_RUN_COMPLETED");
    await eventBus.publishAfterCommit({
      append: async () => liveEvent
    });

    const body = await readUntil(response, "id: 4");

    expect(body.indexOf("id: 2")).toBeLessThan(body.indexOf("id: 3"));
    expect(body).toContain(
      'event: SESSION_STATE_CHANGED\ndata: {"id":"'
    );
    expect(body).toContain("event: AGENT_RUN_COMPLETED");
    expect(body).toContain('data: {"id":"');
    controller.abort();
  });
});
