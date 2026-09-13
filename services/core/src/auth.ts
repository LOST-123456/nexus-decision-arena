import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { newId } from "@nexus/shared";
import type { FastifyRequest } from "fastify";

export type AuthRole = "owner" | "reviewer" | "viewer";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
};

type StoredUser = AuthUser & {
  salt: string;
  passwordHash: string;
  createdAt: string;
};

type AuthServiceOptions = {
  usersPath: string;
  secret: string;
  defaultOwnerPassword: string;
  defaultViewerPassword: string;
};

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export class AuthService {
  private users: StoredUser[] = [];

  constructor(private readonly options: AuthServiceOptions) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.options.usersPath), { recursive: true });
    try {
      const parsed = JSON.parse(
        await readFile(this.options.usersPath, "utf8")
      ) as StoredUser[];
      this.users = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.users = [];
    }

    if (this.users.length === 0) {
      this.users = [
        this.buildUser("owner", "Owner", "owner", this.options.defaultOwnerPassword),
        this.users.length === 0
          ? this.buildUser("viewer", "Viewer", "viewer", this.options.defaultViewerPassword)
          : null
      ].filter((user): user is StoredUser => user !== null);
      await this.persist();
    }
  }

  async authenticate(
    username: string,
    password: string
  ): Promise<AuthUser | null> {
    const user = this.users.find(
      (candidate) => candidate.username.toLowerCase() === username.toLowerCase()
    );
    if (!user) return null;
    const candidateHash = hashPassword(password, user.salt);
    return safeEqual(candidateHash, user.passwordHash)
      ? this.publicUser(user)
      : null;
  }

  async createUser(input: {
    username: string;
    displayName: string;
    role: AuthRole;
    password: string;
  }): Promise<AuthUser> {
    if (
      this.users.some(
        (user) => user.username.toLowerCase() === input.username.toLowerCase()
      )
    ) {
      throw new Error("Username already exists");
    }
    const user = this.buildUser(
      input.username,
      input.displayName,
      input.role,
      input.password
    );
    this.users.push(user);
    await this.persist();
    return this.publicUser(user);
  }

  listUsers(): AuthUser[] {
    return this.users.map((user) => this.publicUser(user));
  }

  issueToken(user: AuthUser): string {
    const payload = Buffer.from(
      JSON.stringify({
        sub: user.id,
        role: user.role,
        exp: Math.floor(Date.now() / 1000) + 604800
      })
    ).toString("base64url");
    const signature = createHmac("sha256", this.options.secret)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  userFromRequest(request: FastifyRequest): AuthUser | null {
    const cookie = request.headers.cookie ?? "";
    const token = cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("nexus_session="))
      ?.slice("nexus_session=".length);
    if (!token) return null;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = createHmac("sha256", this.options.secret)
      .update(payload)
      .digest("base64url");
    if (!safeEqual(signature, expected)) return null;
    try {
      const parsed = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8")
      ) as { sub?: string; exp?: number };
      if (!parsed.exp || parsed.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }
      return this.users.find((user) => user.id === parsed.sub)
        ? this.publicUser(
            this.users.find((user) => user.id === parsed.sub)!
          )
        : null;
    } catch {
      return null;
    }
  }

  private buildUser(
    username: string,
    displayName: string,
    role: AuthRole,
    password: string
  ): StoredUser {
    const salt = randomBytes(16).toString("hex");
    return {
      id: newId(),
      username,
      displayName,
      role,
      salt,
      passwordHash: hashPassword(password, salt),
      createdAt: new Date().toISOString()
    };
  }

  private publicUser(user: StoredUser): AuthUser {
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role
    };
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.options.usersPath,
      `${JSON.stringify(this.users, null, 2)}\n`,
      "utf8"
    );
  }
}
