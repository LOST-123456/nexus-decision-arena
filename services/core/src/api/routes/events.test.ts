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

  it("replays events after Last-Event-ID", async () => {
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

  it("holds replay and live events until a sequence gap is filled", async () => {
    const sessionId = newId();
    const eventBus = new EventBus();
    let signalListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      signalListStarted = resolve;
    });
    let resolveReplay!: (events: ExecutionEvent[]) => void;
    const replayPromise = new Promise<ExecutionEvent[]>((resolve) => {
      resolveReplay = resolve;
    });
    const listAfter = vi.fn(async () => {
      signalListStarted();
      return replayPromise;
    });
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
    const responsePromise = fetch(
      `http://127.0.0.1:${address.port}/api/sessions/${sessionId}/events/stream`,
      { signal: controller.signal }
    );

    await listStarted;
    await eventBus.publishAfterCommit({
      append: async () => createEvent(sessionId, 2)
    });
    resolveReplay([createEvent(sessionId, 2), createEvent(sessionId, 3)]);

    const response = await responsePromise;
    await eventBus.publishAfterCommit({
      append: async () => createEvent(sessionId, 1)
    });

    const body = await readUntil(response, "id: 3");

    expect(body).toContain("id: 1");
    expect(body.indexOf("id: 1")).toBeLessThan(body.indexOf("id: 2"));
    expect(body.indexOf("id: 2")).toBeLessThan(body.indexOf("id: 3"));
    controller.abort();
  });

  it("unsubscribes when the client disconnects during replay", async () => {
    const sessionId = newId();
    const unsubscribe = vi.fn();
    const eventBus = {
      subscribe: vi.fn(() => unsubscribe)
    } as unknown as EventBus;
    let signalListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      signalListStarted = resolve;
    });
    let resolveReplay!: (events: ExecutionEvent[]) => void;
    const replayPromise = new Promise<ExecutionEvent[]>((resolve) => {
      resolveReplay = resolve;
    });
    const listAfter = vi.fn(async () => {
      signalListStarted();
      return replayPromise;
    });
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
    const responsePromise = fetch(
      `http://127.0.0.1:${address.port}/api/sessions/${sessionId}/events/stream`,
      { signal: controller.signal }
    ).catch(() => undefined);

    await listStarted;
    controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const unsubscribedDuringReplay = unsubscribe.mock.calls.length;
    resolveReplay([]);
    await responsePromise;

    expect(unsubscribedDuringReplay).toBe(1);
  });
  it("emits a lower live sequence after a higher one in order", async () => {
    const sessionId = newId();
    const eventBus = new EventBus();
    const listAfter = vi.fn().mockResolvedValue([]);
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
      `http://127.0.0.1:${address.port}/api/sessions/${sessionId}/events/stream`,
      { signal: controller.signal }
    );

    await eventBus.publishAfterCommit({
      append: async () => createEvent(sessionId, 2)
    });
    await eventBus.publishAfterCommit({
      append: async () => createEvent(sessionId, 1)
    });

    const body = await readUntil(response, "id: 1");

    expect(body.indexOf("id: 1")).toBeLessThan(body.indexOf("id: 2"));
    controller.abort();
  });
});
