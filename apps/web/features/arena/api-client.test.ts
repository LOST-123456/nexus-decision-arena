import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionEventTypeSchema,
  newId,
  type ExecutionEvent
} from "@nexus/shared";
import {
  createSession,
  getCurrentUser,
  invalidateCurrentUser,
  login,
  startSession,
  subscribeToEvents
} from "./api-client";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, EventListener>();
  closed = false;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string | URL) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

afterEach(() => {
  FakeEventSource.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SSE client", () => {
  it("subscribes to named execution events instead of default messages", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const sessionId = newId();
    const onEvent = vi.fn();
    const unsubscribe = subscribeToEvents(sessionId, 12, onEvent);
    const source = FakeEventSource.instances[0]!;
    const event: ExecutionEvent = {
      id: newId(),
      sessionId,
      sequence: 13,
      correlationId: newId(),
      type: "CONFLICT_DETECTED",
      payload: { id: newId() },
      occurredAt: new Date().toISOString()
    };

    expect(String(source.url)).toContain("after=12");
    for (const type of ExecutionEventTypeSchema.options) {
      expect(source.listeners.has(type)).toBe(true);
    }

    source.emit("CONFLICT_DETECTED", event);
    expect(onEvent).toHaveBeenCalledWith(event);

    unsubscribe();
    expect(source.closed).toBe(true);
    vi.unstubAllGlobals();
  });

  /*
   * 公网隧道会把 text/event-stream 攒住：连接是 open 的，一个字节都不来。
   * 如果只信这条流，页面就永远停在这一刻，用户以为卡死。所以连接建立之后
   * 必须有一条普通 GET 兜底，并且要如实报告"进度是定时刷新的"。
   */
  it("falls back to polling when the connection stays silent", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const sessionId = newId();
    const event: ExecutionEvent = {
      id: newId(),
      sessionId,
      sequence: 13,
      correlationId: newId(),
      type: "CONFLICT_DETECTED",
      payload: { id: newId() },
      occurredAt: new Date().toISOString()
    };
    // 每轮巡检都拿到一个新 Response：body 只能被读一次，复用同一个对象会在
    // 第二次读取时抛 "Body has already been read"。
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify([event]), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const unsubscribe = subscribeToEvents(sessionId, 12, onEvent, onStatus);
    const source = FakeEventSource.instances[0]!;

    // 握手成功，但流一直不出声。
    source.onopen?.({} as Event);
    await vi.advanceTimersByTimeAsync(2000);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("after=12");
    expect(onEvent).toHaveBeenCalledWith(event);

    // 连续几轮都只有轮询拿到事件，才敢说"实时其实没在工作"。断言最终会报，
    // 不咬死在第几轮——巡检是 2 秒一轮，具体轮次属于实现细节。
    let reported = false;
    for (let round = 0; round < 6 && !reported; round += 1) {
      await vi.advanceTimersByTimeAsync(2000);
      reported = onStatus.mock.calls.some(([status]) => status === "polling");
    }
    expect(reported).toBe(true);

    unsubscribe();
  });

  it("delivers an event once when the poll and the stream both carry it", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const sessionId = newId();
    const event: ExecutionEvent = {
      id: newId(),
      sessionId,
      sequence: 13,
      correlationId: newId(),
      type: "CONFLICT_DETECTED",
      payload: { id: newId() },
      occurredAt: new Date().toISOString()
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify([event]), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        )
      )
    );

    const onEvent = vi.fn();
    const unsubscribe = subscribeToEvents(sessionId, 12, onEvent);
    const source = FakeEventSource.instances[0]!;

    source.onopen?.({} as Event);
    source.emit("CONFLICT_DETECTED", event);
    await vi.advanceTimersByTimeAsync(2000);

    expect(onEvent).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("session creation client", () => {
  it("creates and starts a session with independent idempotency keys", async () => {
    const sessionId = newId();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: sessionId }), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: sessionId, status: "STARTED" }), {
          status: 202,
          headers: { "content-type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const created = await createSession(
      {
        project: {
          name: "Campus AI",
          summary: "Risk review for laboratories",
          targetUsers: "University laboratories",
          businessModel: "Annual subscription",
          expectedData: "100 laboratories in 12 months"
        },
        locale: "zh-CN"
      },
      "create-key"
    );
    const started = await startSession(sessionId, "start-key");

    expect(created.id).toBe(sessionId);
    expect(started.status).toBe("STARTED");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/sessions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "idempotency-key": "create-key"
        })
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/sessions/${sessionId}/start`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "idempotency-key": "start-key"
        })
      })
    );

    vi.unstubAllGlobals();
  });
});

/**
 * 「我是谁」每次页面加载只该问一次。
 *
 * 页头徽标、最近会话、工作区、材料面板各自挂载时都会问；未登录时这些请求
 * 全是 401，控制台刷一排红字，看起来像接口坏了。并发要合成一次，登录/登出
 * 之后缓存的答案必须作废。
 */
describe("current user lookup", () => {
  it("merges concurrent lookups into one request", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "u1", displayName: "Owner" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    invalidateCurrentUser();

    const [first, second, third] = await Promise.all([
      getCurrentUser(),
      getCurrentUser(),
      getCurrentUser()
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("does not cache a 401 as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Authentication required" }), {
            status: 401,
            headers: { "content-type": "application/json" }
          })
        )
      )
    );
    invalidateCurrentUser();

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("forgets the cached answer after logging in", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: "Authentication required" }), {
            status: 401,
            headers: { "content-type": "application/json" }
          })
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "u2",
              username: "owner",
              displayName: "Owner",
              role: "OWNER"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              id: "u2",
              username: "owner",
              displayName: "Owner",
              role: "OWNER"
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        )
      );
    vi.stubGlobal("fetch", fetchMock);
    invalidateCurrentUser();

    // 未登录时问过一次，答案（null）进了短缓存。
    await expect(getCurrentUser()).resolves.toBeNull();
    await login("owner", "secret");
    // 登录之后不能还拿缓存里的 null 当答案。
    await expect(getCurrentUser()).resolves.toMatchObject({ id: "u2" });
  });
});
