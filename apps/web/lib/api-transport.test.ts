import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiTransportError,
  DEFAULT_TIMEOUT_MS,
  fetchJson
} from "./api-transport";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch(implementation: (...args: never[]) => unknown): void {
  vi.stubGlobal("fetch", vi.fn(implementation as never));
}

describe("fetchJson", () => {
  it("returns the parsed body on success", async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ id: "s-1", status: "STARTED" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
    );

    await expect(fetchJson<{ id: string }>("/api/sessions")).resolves.toEqual({
      id: "s-1",
      status: "STARTED"
    });
  });

  it("treats an empty 204 body as success rather than a parse error", async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));

    await expect(fetchJson("/api/auth/logout")).resolves.toBeNull();
  });

  it("keeps a body-less POST free of a JSON content-type", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ id: "s-1" })))
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchJson("/api/sessions/s-1/start", {
      method: "POST",
      idempotencyKey: "start-key"
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["content-type"]).toBeUndefined();
    expect(headers?.["idempotency-key"]).toBe("start-key");
  });

  it("declares JSON and forwards the key once there is a body", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ id: "s-2" })))
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchJson("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
      idempotencyKey: "create-key"
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["content-type"]).toBe("application/json");
    expect(headers?.["idempotency-key"]).toBe("create-key");
  });

  it("reports a refused connection as unavailable, with actionable copy", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));

    const error = await fetchJson("/api/sessions").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiTransportError);
    expect((error as ApiTransportError).kind).toBe("unavailable");
    expect((error as ApiTransportError).message).toContain("无法连接");
    expect((error as ApiTransportError).status).toBeNull();
  });

  it("reports a stalled request as a timeout instead of hanging forever", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock as never);

    const pending = fetchJson("/api/sessions");
    const assertion = expect(pending).rejects.toMatchObject({
      kind: "timeout",
      status: null
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS + 1);
    await assertion;
  });

  it("prefers the server's own message for a 4xx and keeps the code payload", async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "搜索提供方不可用", code: "search_failed" }), {
          status: 422
        })
      )
    );

    const error = await fetchJson("/api/search").catch((caught: unknown) => caught);
    expect((error as ApiTransportError).kind).toBe("http");
    expect((error as ApiTransportError).status).toBe(422);
    expect((error as ApiTransportError).message).toBe("搜索提供方不可用");
    expect((error as ApiTransportError).payload).toMatchObject({
      code: "search_failed"
    });
  });

  it("explains a 5xx in operator language when the body says nothing useful", async () => {
    stubFetch(() =>
      Promise.resolve(new Response("Internal Server Error", { status: 500 }))
    );

    const error = await fetchJson("/api/sessions").catch((caught: unknown) => caught);
    expect((error as ApiTransportError).kind).toBe("http");
    expect((error as ApiTransportError).status).toBe(500);
    expect((error as ApiTransportError).message).toContain("核心 API 返回 500");
    expect((error as ApiTransportError).message).not.toContain("Internal Server Error");
  });

  it("does not let an empty body message swallow the fallback copy", async () => {
    // Fastify's default 5xx body carries `message: ""`. `??` does not skip an
    // empty string, so this used to render as a blank error line.
    stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "", error: "" }), { status: 500 })
      )
    );

    const error = await fetchJson("/api/sessions").catch((caught: unknown) => caught);
    expect((error as ApiTransportError).message).toContain("核心 API 返回 500");
    expect((error as ApiTransportError).message.trim()).not.toBe("");
  });

  it("turns database_unavailable into recovery steps, not a raw server string", async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "Database unavailable",
            code: "database_unavailable"
          }),
          { status: 503 }
        )
      )
    );

    const error = await fetchJson("/api/sessions").catch((caught: unknown) => caught);
    expect((error as ApiTransportError).status).toBe(503);
    expect((error as ApiTransportError).message).toContain("数据库暂时连不上");
    // The form the operator can act on: start the thing, wait, then refresh.
    expect((error as ApiTransportError).message).toContain("Docker");
    expect((error as ApiTransportError).message).not.toContain("503");
  });

  it("turns a 501 into 尚未启用 copy instead of echoing the developer string", async () => {
    stubFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: "Claim extraction is not configured" }),
          { status: 501 }
        )
      )
    );

    const error = await fetchJson("/api/claims").catch((caught: unknown) => caught);
    expect((error as ApiTransportError).kind).toBe("http");
    expect((error as ApiTransportError).status).toBe(501);
    expect((error as ApiTransportError).message).toContain("尚未启用");
    expect((error as ApiTransportError).message).not.toContain("is not configured");
  });
});
