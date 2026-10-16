import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAuthRoutes } from "./auth";
import type { AuthAuditEvent } from "../../auth-audit";
import { LoginThrottle } from "../../login-rate-limit";
import { AuthService } from "../../auth";

/**
 * The authentication routes over real HTTP, with a real `AuthService` backed by
 * a throwaway user file. The point is not to re-test the service but the parts
 * that only exist at the edge: what the cookie carries, what a throttled caller
 * is told, what gets written to the audit trail, and that a caller without a
 * session cannot reach the account list.
 */

const OWNER_PASSWORD = "owner-password";
const VIEWER_PASSWORD = "viewer-password";

let directory: string;
let usersPath: string;
let audit: AuthAuditEvent[];
let app: FastifyInstance;

async function buildApp(options: {
  secureCookies?: boolean;
  maxFailures?: number;
} = {}): Promise<FastifyInstance> {
  const service = new AuthService({
    usersPath,
    secret: "route-test-secret",
    defaultOwnerPassword: OWNER_PASSWORD,
    defaultViewerPassword: VIEWER_PASSWORD,
    allowDemoBootstrap: true
  });
  await service.initialize();
  const instance = Fastify();
  registerAuthRoutes(instance, service, {
    secureCookies: options.secureCookies === true,
    loginThrottle: new LoginThrottle({ maxFailures: options.maxFailures ?? 5 }),
    auditSink: (event) => audit.push(event)
  });
  await instance.ready();
  return instance;
}

/**
 * `light-my-request` splits `set-cookie` into `response.cookies`, where each
 * entry's `value` is the cookie value *without* its attributes — so the
 * attributes this test is about have to be read off the raw header instead.
 */
function cookieOf(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers["set-cookie"];
  if (Array.isArray(raw)) return raw.join("; ");
  return typeof raw === "string" ? raw : "";
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nexus-auth-route-"));
  usersPath = join(directory, "users.json");
  audit = [];
});

afterEach(async () => {
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

describe("POST /api/auth/login", () => {
  it("signs in and sets a session cookie the browser cannot read from script", async () => {
    app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: OWNER_PASSWORD }
    });
    expect(response.statusCode).toBe(200);
    const cookie = cookieOf(response);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
    expect(response.json().role).toBe("owner");
  });

  it("marks the cookie Secure when the deployment is behind https", async () => {
    app = await buildApp({ secureCookies: true });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: OWNER_PASSWORD }
    });
    expect(response.statusCode).toBe(200);
    expect(cookieOf(response)).toContain("Secure");
  });

  it("answers an unknown account and a wrong password identically", async () => {
    app = await buildApp();
    const unknown = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "no-such-user", password: OWNER_PASSWORD }
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: "not-the-password" }
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
    expect(unknown.json().error).toBe("Invalid username or password");
  });

  it("rejects a malformed body before touching the account store", async () => {
    app = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid login request");
  });

  it("throttles repeated failures and tells the caller how long to wait", async () => {
    app = await buildApp({ maxFailures: 3 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "owner", password: "wrong" }
      });
      expect(failed.statusCode).toBe(401);
    }
    const throttled = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: "wrong" }
    });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(throttled.json().error).toContain("Too many login attempts");
  });

  it("lets a successful sign-in clear the failure count", async () => {
    app = await buildApp({ maxFailures: 3 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "owner", password: "wrong" }
      });
      expect(failed.statusCode).toBe(401);
    }
    // Two failures in, the correct password still works.
    const good = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: OWNER_PASSWORD }
    });
    expect(good.statusCode).toBe(200);
    // And the count restarted from zero: two more typos are still answered
    // with 401 rather than a lockout the user did nothing to earn.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "owner", password: "wrong" }
      });
      expect(failed.statusCode).toBe(401);
    }
  });

  it("records an audit event for every outcome and never the password", async () => {
    app = await buildApp({ maxFailures: 3 });
    await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: OWNER_PASSWORD }
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "owner", password: "wrong" }
      });
      expect(failed.statusCode).toBe(401);
    }
    const throttled = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "owner", password: "wrong" }
    });
    expect(throttled.statusCode).toBe(429);

    expect(audit.map((event) => event.type)).toEqual([
      "login_succeeded",
      "login_failed",
      "login_failed",
      "login_failed",
      "login_throttled"
    ]);
    expect(audit[0]?.username).toBe("owner");
    expect(audit[4]?.retryAfterSeconds).toBeGreaterThan(0);
    for (const event of audit) {
      expect(JSON.stringify(event)).not.toContain(OWNER_PASSWORD);
      expect(JSON.stringify(event)).not.toContain("wrong");
    }
  });
});

describe("session and permission endpoints", () => {
  async function signIn(username: string, password: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username, password }
    });
    return cookieOf(response);
  }

  it("answers 401 for an anonymous caller and the account for a signed-in one", async () => {
    app = await buildApp();
    const anonymous = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(anonymous.statusCode).toBe(401);

    const cookie = await signIn("owner", OWNER_PASSWORD);
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().username).toBe("owner");
  });

  it("keeps the account list away from anonymous callers, viewers and forgers", async () => {
    app = await buildApp();
    const anonymous = await app.inject({ method: "GET", url: "/api/auth/users" });
    expect(anonymous.statusCode).toBe(403);

    const viewerCookie = await signIn("viewer", VIEWER_PASSWORD);
    const viewer = await app.inject({
      method: "GET",
      url: "/api/auth/users",
      headers: { cookie: viewerCookie }
    });
    expect(viewer.statusCode).toBe(403);

    const forged = await app.inject({
      method: "GET",
      url: "/api/auth/users",
      headers: { cookie: "nexus_session=payload.forged-signature" }
    });
    expect(forged.statusCode).toBe(403);
  });

  it("lets the owner read and create accounts", async () => {
    app = await buildApp();
    const cookie = await signIn("owner", OWNER_PASSWORD);
    const listed = await app.inject({
      method: "GET",
      url: "/api/auth/users",
      headers: { cookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().map((user: { username: string }) => user.username)).toContain(
      "owner"
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/auth/users",
      headers: { cookie },
      payload: {
        username: "reviewer-new",
        displayName: "Reviewer New",
        role: "reviewer",
        password: "a-strong-password"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().username).toBe("reviewer-new");
    expect(audit.some((event) => event.type === "user_created")).toBe(true);
  });

  it("clears the session cookie on logout", async () => {
    app = await buildApp({ secureCookies: true });
    const response = await app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(response.statusCode).toBe(204);
    expect(cookieOf(response)).toContain("Secure");
    expect(cookieOf(response)).toContain("Max-Age=0");
  });
});
