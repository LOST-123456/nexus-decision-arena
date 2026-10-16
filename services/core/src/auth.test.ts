import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthBootstrapForbiddenError,
  AuthService,
  AuthUsersFileError
} from "./auth";

/**
 * The user file is the only place accounts live. These tests are about what
 * happens to it when something goes wrong: a file that cannot be parsed must
 * never be silently replaced by the built-in accounts, and two concurrent
 * account creations must not lose one of them.
 */

const OWNER_PASSWORD = "owner-password";
const VIEWER_PASSWORD = "viewer-password";

let directory: string;
let usersPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nexus-auth-"));
  usersPath = join(directory, "users.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function makeService(over: Partial<{ allowDemoBootstrap: boolean }> = {}) {
  return new AuthService({
    usersPath,
    secret: "test-secret",
    defaultOwnerPassword: OWNER_PASSWORD,
    defaultViewerPassword: VIEWER_PASSWORD,
    allowDemoBootstrap: over.allowDemoBootstrap ?? true
  });
}

describe("AuthService · first start", () => {
  it("creates the owner and viewer accounts when no file exists", async () => {
    const service = makeService();
    await service.initialize();
    const owner = await service.authenticate("owner", OWNER_PASSWORD);
    const viewer = await service.authenticate("viewer", VIEWER_PASSWORD);
    expect(owner?.role).toBe("owner");
    expect(viewer?.role).toBe("viewer");
    expect(await service.authenticate("owner", "wrong")).toBeNull();
  });

  it("writes the user file with owner-only permissions", async () => {
    await makeService().initialize();
    // POSIX mode bits are meaningful; on Windows the same bits are not
    // honoured, so the assertion is only made where it means something. The
    // rename-based write itself is platform-independent and is what keeps the
    // file from ever being half-written.
    if (process.platform === "win32") {
      await expect(stat(usersPath)).resolves.toBeTruthy();
      return;
    }
    const mode = (await stat(usersPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("leaves no temporary file behind after a successful write", async () => {
    await makeService().initialize();
    const entries = await readdir(directory);
    expect(entries).toEqual(["users.json"]);
  });

  it("re-reads accounts that are already on disk instead of recreating them", async () => {
    await makeService().initialize();
    const stored = JSON.parse(await readFile(usersPath, "utf8")) as Array<{
      username: string;
    }>;
    const second = makeService();
    await second.initialize();
    // A second start must not duplicate the bootstrap accounts.
    expect(second.listUsers().map((user) => user.username).sort()).toEqual(
      stored.map((user) => user.username).sort()
    );
  });

  it("bootstraps from an empty array, which is a valid file with no accounts", async () => {
    await writeFile(usersPath, "[]\n", "utf8");
    const service = makeService();
    await service.initialize();
    expect(await service.authenticate("owner", OWNER_PASSWORD)).not.toBeNull();
  });

  it("refuses to invent an administrator when the deployment forbids it", async () => {
    const service = makeService({ allowDemoBootstrap: false });
    await expect(service.initialize()).rejects.toBeInstanceOf(
      AuthBootstrapForbiddenError
    );
    // The refusal must not leave a half-written file behind.
    await expect(readFile(usersPath, "utf8")).rejects.toThrow();
  });
});

describe("AuthService · an unreadable user file is never overwritten", () => {
  const corrupt = "{ this is not json";

  beforeEach(async () => {
    await writeFile(usersPath, corrupt, "utf8");
  });

  it("raises instead of resetting the accounts", async () => {
    await expect(makeService().initialize()).rejects.toBeInstanceOf(
      AuthUsersFileError
    );
  });

  it("leaves the original bytes exactly as they were", async () => {
    await expect(makeService().initialize()).rejects.toThrow();
    expect(await readFile(usersPath, "utf8")).toBe(corrupt);
  });

  it("still refuses when the deployment would otherwise bootstrap", async () => {
    // A public deployment reaching this file must fail the same way: the
    // corruption is reported, not papered over with built-in credentials.
    await expect(
      makeService({ allowDemoBootstrap: false }).initialize()
    ).rejects.toBeInstanceOf(AuthUsersFileError);
    expect(await readFile(usersPath, "utf8")).toBe(corrupt);
  });
});

describe("AuthService · structurally broken user files", () => {
  it("rejects a file that is not an array", async () => {
    await writeFile(usersPath, '{"owner":true}\n', "utf8");
    await expect(makeService().initialize()).rejects.toBeInstanceOf(
      AuthUsersFileError
    );
    expect(await readFile(usersPath, "utf8")).toBe('{"owner":true}\n');
  });

  it("rejects an entry with no salt or hash", async () => {
    const broken = JSON.stringify([
      { id: "u1", username: "owner", displayName: "Owner", role: "owner" }
    ]);
    await writeFile(usersPath, `${broken}\n`, "utf8");
    await expect(makeService().initialize()).rejects.toBeInstanceOf(
      AuthUsersFileError
    );
    expect(await readFile(usersPath, "utf8")).toBe(`${broken}\n`);
  });

  it("rejects an entry with a role outside the enum", async () => {
    const broken = JSON.stringify([
      {
        id: "u1",
        username: "owner",
        displayName: "Owner",
        role: "admin",
        salt: "aa",
        passwordHash: "bb",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    ]);
    await writeFile(usersPath, `${broken}\n`, "utf8");
    await expect(makeService().initialize()).rejects.toBeInstanceOf(
      AuthUsersFileError
    );
    expect(await readFile(usersPath, "utf8")).toBe(`${broken}\n`);
  });
});

describe("AuthService · concurrent account creation", () => {
  it("keeps every account when the same username is created twice at once", async () => {
    await makeService().initialize();
    const service = makeService();
    await service.initialize();

    const results = await Promise.allSettled([
      service.createUser({
        username: "editor",
        displayName: "Editor",
        role: "reviewer",
        password: "a-strong-password"
      }),
      service.createUser({
        username: "editor",
        displayName: "Editor",
        role: "reviewer",
        password: "another-strong-password"
      })
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Whatever won, it must still be there after a fresh read — the losing
    // request must not have overwritten the file with a stale list.
    const reread = makeService();
    await reread.initialize();
    const names = reread.listUsers().map((user) => user.username);
    expect(names.filter((name) => name === "editor")).toHaveLength(1);
    expect(names).toContain("owner");
  });

  it("keeps distinct concurrent accounts", async () => {
    await makeService().initialize();
    const service = makeService();
    await service.initialize();
    await Promise.all([
      service.createUser({
        username: "reviewer-one",
        displayName: "One",
        role: "reviewer",
        password: "a-strong-password"
      }),
      service.createUser({
        username: "reviewer-two",
        displayName: "Two",
        role: "reviewer",
        password: "a-strong-password"
      })
    ]);
    const reread = makeService();
    await reread.initialize();
    expect(reread.listUsers().map((user) => user.username)).toEqual(
      expect.arrayContaining(["owner", "viewer", "reviewer-one", "reviewer-two"])
    );
  });
});

describe("AuthService · authentication", () => {
  it("rejects an unknown username without revealing that it is unknown", async () => {
    const service = makeService();
    await service.initialize();
    // Both of these must fail; the service spends the same key derivation on
    // each so the answer cannot be told apart by how long it took.
    expect(await service.authenticate("nobody", OWNER_PASSWORD)).toBeNull();
    expect(await service.authenticate("owner", "not-the-password")).toBeNull();
  });

  it("matches the username case-insensitively", async () => {
    const service = makeService();
    await service.initialize();
    expect(await service.authenticate("OWNER", OWNER_PASSWORD)).not.toBeNull();
  });
});

describe("AuthService · session tokens", () => {
  function fakeRequest(cookie: string) {
    return { headers: { cookie } } as never;
  }

  it("round-trips an issued token", async () => {
    const service = makeService();
    await service.initialize();
    const owner = await service.authenticate("owner", OWNER_PASSWORD);
    const token = service.issueToken(owner!);
    expect(service.userFromRequest(fakeRequest(`nexus_session=${token}`))).toEqual(
      owner
    );
  });

  it("rejects a tampered token", async () => {
    const service = makeService();
    await service.initialize();
    const owner = await service.authenticate("owner", OWNER_PASSWORD);
    const [payload] = service.issueToken(owner!).split(".");
    expect(
      service.userFromRequest(fakeRequest(`nexus_session=${payload}.forged`))
    ).toBeNull();
  });

  it("rejects an expired token", async () => {
    const service = makeService();
    await service.initialize();
    const owner = await service.authenticate("owner", OWNER_PASSWORD);
    const stalePayload = Buffer.from(
      JSON.stringify({ sub: owner!.id, role: "owner", exp: 1 })
    ).toString("base64url");
    const signature = createHmac("sha256", "test-secret")
      .update(stalePayload)
      .digest("base64url");
    expect(
      service.userFromRequest(
        fakeRequest(`nexus_session=${stalePayload}.${signature}`)
      )
    ).toBeNull();
  });

  it("rejects a request with no cookie at all", async () => {
    const service = makeService();
    await service.initialize();
    expect(service.userFromRequest(fakeRequest(""))).toBeNull();
  });
});
