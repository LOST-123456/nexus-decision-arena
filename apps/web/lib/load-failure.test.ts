import { describe, expect, it } from "vitest";
import { ApiTransportError } from "./api-transport";
import { toLoadFailure } from "./load-failure";

const NOT_FOUND = "找不到这个评审（HTTP 404）。";
const FALLBACK = "会话加载失败";
const SIGN_IN = "需要登录才能查看这个评审。";

describe("toLoadFailure", () => {
  it("flags a 404 as not-found with its own copy", () => {
    const failure = toLoadFailure(
      new ApiTransportError("http", "Session not found", {
        status: 404,
        payload: { error: "Session not found" }
      }),
      NOT_FOUND,
      FALLBACK,
      SIGN_IN
    );

    expect(failure.status).toBe(404);
    expect(failure.kind).toBe("not-found");
    expect(failure.message).toBe(NOT_FOUND);
    // The server's developer-facing English must not be what the operator reads.
    expect(failure.message).not.toContain("Session not found");
  });

  /**
   * Reads are owner-scoped, so an unauthenticated visitor is answered 401 —
   * not 404. If that were folded into "unavailable", the page would tell
   * someone to go and check a core process that is running fine. It gets its
   * own kind, its own words, and a way to sign in.
   */
  it("treats a 401 as a sign-in prompt, never as an outage", () => {
    const failure = toLoadFailure(
      new ApiTransportError("http", "Authentication required", {
        status: 401,
        payload: { error: "Authentication required" }
      }),
      NOT_FOUND,
      FALLBACK,
      SIGN_IN
    );

    expect(failure.status).toBe(401);
    expect(failure.kind).toBe("sign-in");
    expect(failure.message).toBe(SIGN_IN);
    expect(failure.message).not.toContain("Authentication required");
  });

  it("keeps a 500 distinct from a 404 so the page can offer a retry", () => {
    const failure = toLoadFailure(
      new ApiTransportError("http", "核心 API 返回 500 错误。请确认服务正常运行后重试。", {
        status: 500
      }),
      NOT_FOUND,
      FALLBACK,
      SIGN_IN
    );

    expect(failure.status).toBe(500);
    expect(failure.kind).toBe("unavailable");
    expect(failure.message).toContain("500");
  });

  it("reports a refused connection as an unknown status, not as not-found", () => {
    const failure = toLoadFailure(
      new ApiTransportError("unavailable", "无法连接到核心 API。请确认服务仍在运行，然后重新检查。"),
      NOT_FOUND,
      FALLBACK,
      SIGN_IN
    );

    expect(failure.status).toBeNull();
    expect(failure.kind).toBe("unavailable");
    expect(failure.message).toContain("无法连接到核心 API");
  });

  it("passes a timeout through with its own message", () => {
    const failure = toLoadFailure(
      new ApiTransportError("timeout", "请求超时（30 秒）。核心 API 可能繁忙或已停止响应，请稍后重试。"),
      NOT_FOUND,
      FALLBACK,
      SIGN_IN
    );

    expect(failure.status).toBeNull();
    expect(failure.kind).toBe("unavailable");
    expect(failure.message).toContain("请求超时");
  });

  it("falls back for a non-transport throwable", () => {
    expect(toLoadFailure(new Error("boom"), NOT_FOUND, FALLBACK)).toEqual({
      status: null,
      kind: "unavailable",
      message: "boom"
    });
    expect(toLoadFailure("not an error", NOT_FOUND, FALLBACK)).toEqual({
      status: null,
      kind: "unavailable",
      message: FALLBACK
    });
  });
});
