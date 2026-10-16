import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type AuthAuditRecorder,
  type AuthAuditSink,
  createAuditRecorder,
  createConsoleAuditSink
} from "../../auth-audit";
import { LoginThrottle } from "../../login-rate-limit";
import { AuthService, type AuthRole } from "../../auth";

const LoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1)
});

const CreateUserSchema = z.object({
  username: z.string().min(3).max(40),
  displayName: z.string().min(1).max(80),
  role: z.enum(["owner", "reviewer", "viewer"]),
  password: z.string().min(8).max(200)
});

export type AuthRouteOptions = {
  /** Counts failed sign-ins per account and per source address. */
  loginThrottle?: LoginThrottle;
  /** Adds `Secure` to the session cookie. Required behind https. */
  secureCookies?: boolean;
  /** Where authentication decisions are recorded. */
  auditSink?: AuthAuditSink;
};

/** How the session cookie is described, in one place. */
function setSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `nexus_session=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=604800"
  ];
  // Without `Secure` a session cookie travels over plain http and can be read
  // off the wire; with it, an http-only deployment drops it silently and the
  // login appears to succeed while leaving nobody signed in. Which is why the
  // caller decides, rather than this function.
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie(secure: boolean): string {
  const parts = [
    "nexus_session=",
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function requireOwner(auth: AuthService, request: FastifyRequest) {
  const user = auth.userFromRequest(request);
  return user?.role === "owner" ? user : null;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  options: AuthRouteOptions = {}
): void {
  const throttle = options.loginThrottle ?? new LoginThrottle();
  const secureCookies = options.secureCookies === true;
  const audit: AuthAuditRecorder = createAuditRecorder(
    options.auditSink ?? createConsoleAuditSink()
  );

  app.get("/api/auth/me", async (request, reply) => {
    const user = auth.userFromRequest(request);
    if (!user) {
      return reply.code(401).send({ error: "Not authenticated" });
    }
    return reply.send(user);
  });

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = LoginSchema.safeParse(request.body);
    if (!parsed.success) {
      audit("login_failed", {
        username: "<unparsed>",
        ip: request.ip,
        reason: "request_body_rejected"
      });
      return reply.code(400).send({ error: "Invalid login request" });
    }

    const { username, password } = parsed.data;
    // A username is attacker-controlled input; keep the key a bounded size so
    // the throttle map cannot be grown by submitting megabyte-long names.
    const accountKey = `account:${username.toLowerCase().slice(0, 256)}`;
    const addressKey = `address:${request.ip}`;
    const keys = [accountKey, addressKey];

    for (const key of keys) {
      const decision = throttle.check(key);
      if (decision.allowed) continue;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(decision.retryAfterMs / 1000)
      );
      audit("login_throttled", {
        username,
        ip: request.ip,
        reason: "too_many_failed_attempts",
        retryAfterSeconds
      });
      reply.header("retry-after", String(retryAfterSeconds));
      return reply
        .code(429)
        .send({ error: "Too many login attempts. Try again later." });
    }

    const user = await auth.authenticate(username, password);
    if (!user) {
      for (const key of keys) throttle.recordFailure(key);
      audit("login_failed", {
        username,
        ip: request.ip,
        reason: "invalid_credentials"
      });
      // One answer for "no such account" and for "wrong password": the
      // authentication service already spends the same work on both, so the
      // status, the body and the timing agree.
      return reply.code(401).send({ error: "Invalid username or password" });
    }

    for (const key of keys) throttle.recordSuccess(key);
    audit("login_succeeded", { username, ip: request.ip });
    reply.header(
      "set-cookie",
      setSessionCookie(auth.issueToken(user), secureCookies)
    );
    return reply.send(user);
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("set-cookie", clearSessionCookie(secureCookies));
    return reply.code(204).send();
  });

  app.get("/api/auth/users", async (request, reply) => {
    if (!requireOwner(auth, request)) {
      return reply.code(403).send({ error: "Owner role required" });
    }
    return reply.send(auth.listUsers());
  });

  app.post("/api/auth/users", async (request, reply) => {
    const owner = requireOwner(auth, request);
    if (!owner) {
      return reply.code(403).send({ error: "Owner role required" });
    }
    const parsed = CreateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid user request" });
    }
    try {
      const created = await auth.createUser(parsed.data);
      audit("user_created", {
        username: parsed.data.username,
        ip: request.ip,
        reason: `role=${parsed.data.role}; by=${owner.username}`
      });
      return reply.code(201).send(created);
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "User exists" });
    }
  });
}
