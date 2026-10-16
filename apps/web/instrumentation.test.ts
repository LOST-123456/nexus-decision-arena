import { afterEach, describe, expect, it, vi } from "vitest";
import { onRequestError, register } from "./instrumentation";

/**
 * The instrumentation hook is the only place a server-side failure becomes
 * visible, so it is tested directly rather than through a rendered page — there
 * is no page to render it in.
 *
 * The request argument is Next's own descriptor rather than a web `Request`,
 * which is why these are plain object literals.
 */
describe("instrumentation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.NEXT_RUNTIME;
  });

  it("announces the runtime when serving from node", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await register();

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toContain("[nexus]");
  });

  it("stays silent outside the node runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await register();

    expect(info).not.toHaveBeenCalled();
  });

  it("logs a failed request with the route it failed on and the digest", async () => {
    const error = Object.assign(new Error("boom"), { digest: "abc123" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await onRequestError(
      error,
      { path: "/api/sessions", method: "GET", headers: {} },
      {
        routerKind: "App Router",
        routePath: "/api/sessions",
        routeType: "route",
        revalidateReason: undefined
      }
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const line = String(errorSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("/api/sessions");
    expect(line).toContain("abc123");
    // The error object itself is forwarded so the runtime prints the stack once.
    expect(errorSpy.mock.calls[0]?.[1]).toBe(error);
  });

  it("still reports when the error carries no digest", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await onRequestError(
      new Error("plain"),
      { path: "/", method: "GET", headers: {} },
      {
        routerKind: "App Router",
        routePath: "/",
        routeType: "render",
        revalidateReason: undefined
      }
    );

    const line = String(errorSpy.mock.calls[0]?.[0] ?? "");
    expect(line).toContain("/");
    expect(line).not.toContain("digest");
  });
});
