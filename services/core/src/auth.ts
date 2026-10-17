import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { newId } from "@nexus/shared";
import type { FastifyRequest } from "fastify";

export type AuthRole = "owner" | "reviewer" | "viewer";

/**
 * The one cookie this service authenticates with.
 *
 * Exported because three places must agree on it: the login route writes it,
 * `userFromRequest` reads it, and the CSRF guard has to know whether a request
 * is carrying ambient credentials at all.
 */
export const SESSION_COOKIE_NAME = "nexus_session";

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

export type AuthServiceOptions = {
  usersPath: string;
  secret: string;
  /**
   * Password for the first `owner`. Null means this deployment must not create
   * an owner at all — see `AuthBootstrapForbiddenError`.
   */
  defaultOwnerPassword: string | null;
  /** Password for the first `viewer`; null means no viewer is created. */
  defaultViewerPassword: string | null;
  /**
   * Whether an empty or absent user file may be filled with the built-in
   * convenience accounts. A public deployment resolves this to false unless an
   * operator set an initial password explicitly.
   */
  allowDemoBootstrap: boolean;
};

/** Raised when the user file cannot be trusted. The file is never rewritten. */
export class AuthUsersFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthUsersFileError";
  }
}

/**
 * Raised when there is no administrator to sign in as and this deployment is
 * not allowed to invent one from credentials shipped in the source.
 */
export class AuthBootstrapForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthBootstrapForbiddenError";
  }
}

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

function isStoredUser(value: unknown): value is StoredUser {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredUser>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.username === "string" &&
    candidate.username.length > 0 &&
    typeof candidate.salt === "string" &&
    candidate.salt.length > 0 &&
    typeof candidate.passwordHash === "string" &&
    candidate.passwordHash.length > 0 &&
    (candidate.role === "owner" ||
      candidate.role === "reviewer" ||
      candidate.role === "viewer")
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * A fixed salt/hash pair used to make an unknown username cost the same work
 * as a known one. Without it, "no such user" returns in microseconds while
 * "wrong password" runs a key derivation, and the response time tells an
 * attacker which usernames exist — which is exactly the side channel that
 * makes a uniform error message pointless.
 */
let timingEqualization: { salt: string; passwordHash: string } | null = null;
function equalizationTarget(): { salt: string; passwordHash: string } {
  timingEqualization ??= {
    salt: "nexus-timing-equalization",
    passwordHash: hashPassword(
      "nexus-timing-equalization",
      "nexus-timing-equalization"
    )
  };
  return timingEqualization;
}

export class AuthService {
  private users: StoredUser[] = [];
  /**
   * Serializes writes to the user file. `createUser` checks for a duplicate
   * and then persists; without this chain, two concurrent calls can both pass
   * the check and the second write silently drops the first account.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: AuthServiceOptions) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.options.usersPath), { recursive: true });
    this.users = await this.readUsersFile();
    if (this.users.length === 0) {
      await this.bootstrapInitialUsers();
    }
  }

  async authenticate(
    username: string,
    password: string
  ): Promise<AuthUser | null> {
    const user = this.users.find(
      (candidate) => candidate.username.toLowerCase() === username.toLowerCase()
    );
    // Derive against the real salt when the account exists and against a fixed
    // one when it does not, so the two paths cost the same.
    const target = user ?? equalizationTarget();
    const candidateHash = hashPassword(password, target.salt);
    const matches = safeEqual(candidateHash, target.passwordHash);
    if (!user || !matches) return null;
    return this.publicUser(user);
  }

  async createUser(input: {
    username: string;
    displayName: string;
    role: AuthRole;
    password: string;
  }): Promise<AuthUser> {
    const attempt = this.writeQueue.then(() =>
      this.createUserSerialized(input)
    );
    // Keep the chain alive even when this attempt fails, so one rejected
    // request does not break every later one.
    this.writeQueue = attempt.then(
      () => undefined,
      () => undefined
    );
    return attempt;
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
      .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`))
      ?.slice(`${SESSION_COOKIE_NAME}=`.length);
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

  /**
   * Reads the user file, telling "there is no file yet" apart from "there is a
   * file and it cannot be trusted".
   *
   * The distinction is the whole point. The previous implementation caught
   * every error and reset the account list to empty, so a truncated write, a
   * permission change or a hand-edited typo silently destroyed every account
   * and replaced it with the built-in ones — with the operator's passwords
   * gone and nothing in the log saying so. A missing file is a first start; a
   * file that cannot be read or parsed is a stop.
   */
  private async readUsersFile(): Promise<StoredUser[]> {
    let raw: string;
    try {
      raw = await readFile(this.options.usersPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw new AuthUsersFileError(
        `Cannot read the user file at ${this.options.usersPath}: ${describeError(
          error
        )}. Existing accounts were left untouched; fix the file or its permissions and start again.`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AuthUsersFileError(
        `The user file at ${this.options.usersPath} is not valid JSON. Existing accounts were left untouched; repair the file and start again.`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new AuthUsersFileError(
        `The user file at ${this.options.usersPath} does not contain an array of accounts. Existing accounts were left untouched; repair the file and start again.`
      );
    }
    const unusable = parsed.filter((entry) => !isStoredUser(entry)).length;
    if (unusable > 0) {
      throw new AuthUsersFileError(
        `The user file at ${this.options.usersPath} contains ${unusable} entr${
          unusable === 1 ? "y" : "ies"
        } without a username, salt, password hash or valid role. Existing accounts were left untouched; repair the file and start again.`
      );
    }
    return parsed as StoredUser[];
  }

  private async bootstrapInitialUsers(): Promise<void> {
    if (!this.options.allowDemoBootstrap) {
      throw new AuthBootstrapForbiddenError(
        `No administrator exists yet, and this deployment is not allowed to create one from credentials shipped in the source. Set AUTH_DEFAULT_OWNER_PASSWORD (and AUTH_DEFAULT_VIEWER_PASSWORD if a viewer account is wanted) before the first start. The user file at ${this.options.usersPath} was left untouched.`
      );
    }
    const created: StoredUser[] = [];
    if (this.options.defaultOwnerPassword) {
      created.push(
        this.buildUser(
          "owner",
          "Owner",
          "owner",
          this.options.defaultOwnerPassword
        )
      );
    }
    if (this.options.defaultViewerPassword) {
      created.push(
        this.buildUser(
          "viewer",
          "Viewer",
          "viewer",
          this.options.defaultViewerPassword
        )
      );
    }
    if (created.length === 0) {
      throw new AuthBootstrapForbiddenError(
        `No administrator exists yet and no initial password is configured. Set AUTH_DEFAULT_OWNER_PASSWORD before the first start. The user file at ${this.options.usersPath} was left untouched.`
      );
    }
    this.users = created;
    await this.persist();
  }

  private async createUserSerialized(input: {
    username: string;
    displayName: string;
    role: AuthRole;
    password: string;
  }): Promise<AuthUser> {
    // Re-checked inside the lock: the earlier check in the caller ran while
    // another request could still have been persisting the same username.
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

  /**
   * Writes the account file by renaming a temporary file over it.
   *
   * A direct `writeFile` truncates the target first, so a crash or a full disk
   * between the two leaves a half-written file where every account used to be.
   * `rename` is atomic within a filesystem, so the file is either the old
   * content or the new content — never a blend. The file holds password
   * hashes, so it is created 0600 rather than inheriting the process umask.
   */
  private async persist(): Promise<void> {
    const target = this.options.usersPath;
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    const payload = `${JSON.stringify(this.users, null, 2)}\n`;
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new AuthUsersFileError(
        `Cannot write the user file at ${target}: ${describeError(error)}. Existing accounts were left untouched.`
      );
    }
    // `rename` keeps the destination's original permissions, so tighten them
    // here in case the file already existed with wider ones.
    await chmod(target, 0o600).catch(() => undefined);
  }
}
