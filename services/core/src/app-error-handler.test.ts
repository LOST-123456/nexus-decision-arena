import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";

/**
 * What a failure is allowed to look like on the wire.
 *
 * Before this handler existed, Fastify's default body carried `code` straight
 * from the thrown error, so a stopped database answered `/api/...` with
 * `{"code":"ECONNREFUSED"}` and an empty `message`. Two separate problems came
 * out of that: the deployment told the browser which driver it uses, and the
 * web client — which prefers `message` over `error` — rendered a blank line
 * where the recovery copy should have been.
 */

const dependencies = {
  sessions: {} as never,
  inspector: {} as never,
  events: { listAfter: vi.fn(), append: vi.fn() } as never,
  runSession: {} as never
};

/** The two extras Fastify reads off a thrown value. */
type Wiring = { statusCode?: number; code?: string };

/**
 * An Error carrying a status and/or a code.
 *
 * Written as one helper rather than `const failure = new Error(...)` followed
 * by `failure.code = ...`, because the latter does not typecheck: `Error` has
 * no such property. Vitest runs without type checking, so this only shows up
 * in `tsc --noEmit`.
 */
function failure(message: string, wiring: Wiring = {}): Error & Wiring {
  return Object.assign(new Error(message), wiring);
}

function failWith(error: Error & Wiring) {
  return () => {
    throw error;
  };
}

describe("core error handler", () => {
  it("answers a 5xx in one sentence, without the driver's code or wording", async () => {
    const reportError = vi.fn();
    const app = createApp(dependencies, undefined, { reportError });
    app.get("/boom", failWith(failure("Cannot read properties of undefined (reading 'rows')", { code: "EPIPE" })));

    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(500);
    // Exactly one key: no `code`, no `message`, no `statusCode`, no stack.
    expect(response.json()).toEqual({ error: "Internal server error" });
    expect(response.body).not.toContain("EPIPE");
    expect(response.body).not.toContain("rows");
    await app.close();
  });

  it("hands the real failure to the operator's log, since the body no longer carries it", async () => {
    const reportError = vi.fn();
    const app = createApp(dependencies, undefined, { reportError });
    app.get("/boom", failWith(new Error("database system is starting up")));

    await app.inject({ method: "GET", url: "/boom" });

    expect(reportError).toHaveBeenCalledTimes(1);
    const [error, context] = reportError.mock.calls[0]!;
    expect((error as Error).message).toBe("database system is starting up");
    expect(context).toMatchObject({ method: "GET", url: "/boom", statusCode: 500 });
    await app.close();
  });

  it("keeps a 4xx readable, along with the business code a client switches on", async () => {
    const app = createApp(dependencies);
    app.get(
      "/missing",
      failWith(failure("Session not found", { statusCode: 404, code: "session_not_found" }))
    );

    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: "Session not found",
      code: "session_not_found"
    });
    await app.close();
  });

  it("drops an internal-looking code from a 4xx rather than forwarding it", async () => {
    const app = createApp(dependencies);
    // Fastify's own parser failures look like this; they are not ours to name.
    app.get(
      "/bad",
      failWith(failure("Invalid request body", { statusCode: 400, code: "FST_ERR_VALIDATION" }))
    );

    const response = await app.inject({ method: "GET", url: "/bad" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Invalid request body" });
    await app.close();
  });

  it("survives a thrown non-Error without leaking its shape", async () => {
    const app = createApp(dependencies);
    app.get("/weird", () => {
      throw "a bare string";
    });

    const response = await app.inject({ method: "GET", url: "/weird" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    await app.close();
  });

  it("names an unreachable database rather than answering a generic 500", async () => {
    const reportError = vi.fn();
    const app = createApp(dependencies, undefined, { reportError });
    // Exactly what PostgreSQL answers while replaying its log after a restart.
    app.get("/db", failWith(failure("the database system is starting up", { code: "57P03" })));

    const response = await app.inject({ method: "GET", url: "/db" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: "Database unavailable",
      code: "database_unavailable"
    });
    // The stable code is deliberate; the SQLSTATE is not.
    expect(response.body).not.toContain("57P03");
    expect(reportError).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("treats a refused socket as the same condition", async () => {
    const app = createApp(dependencies);
    app.get("/db", failWith(failure("connect ECONNREFUSED 127.0.0.1:5433", { code: "ECONNREFUSED" })));

    const response = await app.inject({ method: "GET", url: "/db" });

    expect(response.statusCode).toBe(503);
    expect(response.json().code).toBe("database_unavailable");
    await app.close();
  });

  it("keeps a 5xx that is not about the database as a plain 500", async () => {
    const app = createApp(dependencies);
    // No status, no code: the plainest possible internal failure.
    app.get("/bug", failWith(new Error("unexpected null in report builder")));

    const response = await app.inject({ method: "GET", url: "/bug" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "Internal server error" });
    await app.close();
  });
});
