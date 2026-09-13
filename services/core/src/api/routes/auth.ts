import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
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

function setSessionCookie(token: string): string {
  return [
    `nexus_session=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=604800"
  ].join("; ");
}

function clearSessionCookie(): string {
  return "nexus_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
}

function requireOwner(auth: AuthService, request: FastifyRequest) {
  const user = auth.userFromRequest(request);
  return user?.role === "owner" ? user : null;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService
): void {
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
      return reply.code(400).send({ error: "Invalid login request" });
    }
    const user = await auth.authenticate(
      parsed.data.username,
      parsed.data.password
    );
    if (!user) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }
    reply.header("set-cookie", setSessionCookie(auth.issueToken(user)));
    return reply.send(user);
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    reply.header("set-cookie", clearSessionCookie());
    return reply.code(204).send();
  });

  app.get("/api/auth/users", async (request, reply) => {
    if (!requireOwner(auth, request)) {
      return reply.code(403).send({ error: "Owner role required" });
    }
    return reply.send(auth.listUsers());
  });

  app.post("/api/auth/users", async (request, reply) => {
    if (!requireOwner(auth, request)) {
      return reply.code(403).send({ error: "Owner role required" });
    }
    const parsed = CreateUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid user request" });
    }
    try {
      return reply.code(201).send(await auth.createUser(parsed.data));
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : "User exists" });
    }
  });
}
