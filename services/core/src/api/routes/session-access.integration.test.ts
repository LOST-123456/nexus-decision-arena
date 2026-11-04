import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  ReviewRepository,
  SourceLibraryRepository,
  TeamCollaborationRepository,
  listSessionPage,
  projects,
  type Database
} from "@nexus/db";
import { createApp } from "../../app";
import type { AuthRole } from "../../auth";

/**
 * DB-backed integration test for research-session access control.
 *
 * What only a real database and real HTTP can prove, which is the whole point
 * of the hardening:
 *  - an anonymous caller reads no research at all — not the list, not the
 *    detail, not the material behind a session id;
 *  - two researchers each see their own work and neither sees the other's,
 *    through the list *and* through every direct path (detail, sources,
 *    workspace, delete);
 *  - a refused session and an absent one answer identically, so the error
 *    code cannot be used to discover which ids exist;
 *  - the two sanctioned ways to widen access still work: a live share grant
 *    (and its revocation closes it again) and a team membership;
 *  - a legacy session with no recorded owner belongs to the deployment
 *    administrator, and is not handed to every signed-in account;
 *  - the list is filtered in the query, so `limit` and ordering cannot be used
 *    to page another account's research into view.
 *
 * The identity boundary itself (`AuthService`, the signed cookie) is covered
 * by `auth.test.ts`; here `userFromRequest` is the only thing stubbed, so every
 * authorization decision still runs against persisted ownership, grants and
 * memberships in the dedicated test database named by TEST_DATABASE_URL.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const events = new EventRepository(database);
const sourceLibrary = new SourceLibraryRepository(database);
const teamCollaboration = new TeamCollaborationRepository(database);
const arena = new ArenaRepository(database);
const reviews = new ReviewRepository(database);

const USER_A = "user-a";
const USER_B = "user-b";
const ADMIN = "user-admin";

type Identity = {
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
};

/** The identity every request is made as; `null` means anonymous. */
let currentUser: Identity | null = null;

function asUser(id: string, role: AuthRole = "reviewer") {
  currentUser = { id, username: id, displayName: id, role };
}

function anonymous() {
  currentUser = null;
}

/** Two researchers and one deployment administrator, for subject resolution. */
const DIRECTORY: Identity[] = [
  { id: USER_A, username: "researcher-a", displayName: "Researcher A", role: "reviewer" },
  { id: USER_B, username: "researcher-b", displayName: "Researcher B", role: "reviewer" },
  { id: ADMIN, username: "administrator", displayName: "Administrator", role: "owner" }
];

function testApp() {
  return createApp({
    auth: {
      userFromRequest: () => currentUser,
      listUsers: () => DIRECTORY
    } as never,
    sessions,
    sessionHistory: sessions,
    // The list route reads pages through this entry, not through
    // `sessionHistory`; wiring only the latter answers 501, which would make
    // every list assertion below vacuous.
    sessionPages: {
      listPage: (page, sessionIds) => listSessionPage(database, page, sessionIds)
    },
    inspector: {} as never,
    events,
    runSession: { start: async () => undefined },
    evidence: evidenceRepository,
    arena,
    reviews,
    sourceLibrary,
    teamCollaboration
  });
}

const app = testApp();

/**
 * A clean workspace per test.
 *
 * `agent_roles` is truncated alongside the session tables so each test starts
 * from an empty role roster. It is a table of role *templates*, and other
 * suites on the shared test database leave a `challenger-<id>` variant behind;
 * the session view keeps only the roles it understands now, but a roster that
 * depends on what another suite happened to insert is not a fixed starting
 * point and this file should not inherit one.
 */
async function resetWorkspace(): Promise<void> {
  await database.execute("TRUNCATE projects, agent_roles CASCADE");
}

beforeEach(async () => {
  await resetWorkspace();
  asUser(USER_A);
});

afterAll(async () => {
  await resetWorkspace();
});

/**
 * Creates a research through the real route as the current user, so the owner
 * is whatever the server-side identity says — never a body field.
 */
async function createResearchAs(id: string, name: string): Promise<string> {
  asUser(id);
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { "idempotency-key": `session-${randomUUID()}` },
    payload: {
      project: {
        name,
        summary: "Access control",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "documents"
      },
      locale: "zh-CN",
      researchQuestion: `${name} 要回答的问题`
    }
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

/**
 * The ids on a list page.
 *
 * Strict on purpose: the endpoint answers `{ sessions, nextCursor, hasNextPage }`
 * and a body of any other shape is a failure, not "an empty workspace". A
 * tolerant reader here would turn a 501 or a 400 into a passing
 * `not.toContain` assertion.
 */
function idsOf(body: unknown): string[] {
  const listed = (body as { sessions?: Array<{ id: string }> }).sessions;
  if (!Array.isArray(listed)) {
    throw new Error(`not a session page: ${JSON.stringify(body)}`);
  }
  return listed.map((row) => row.id);
}

describe("session access — anonymous callers", () => {
  it("cannot list the workspace", async () => {
    await createResearchAs(USER_A, "A 的研究");
    anonymous();
    const response = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Authentication required" });
    // Nothing about the workspace leaks through the refusal.
    expect(response.body).not.toContain("A 的研究");
  });

  it("cannot read a session detail", async () => {
    const sessionId = await createResearchAs(USER_A, "A 的研究");
    anonymous();
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}`
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("A 的研究");
  });

  it("cannot read the material behind a session id", async () => {
    const sessionId = await createResearchAs(USER_A, "A 的研究");
    anonymous();
    for (const path of ["research", "sources"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/${path}`
      });
      expect(response.statusCode, path).toBe(401);
    }
  });
});

describe("session access — two researchers", () => {
  it("shows each caller only the researches they may read", async () => {
    const aSession = await createResearchAs(USER_A, "A 的研究");
    const bSession = await createResearchAs(USER_B, "B 的研究");

    asUser(USER_A);
    const aList = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(aList.statusCode).toBe(200);
    expect(idsOf(aList.json())).toContain(aSession);
    expect(idsOf(aList.json())).not.toContain(bSession);
    expect(aList.body).not.toContain("B 的研究");

    asUser(USER_B);
    const bList = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(bList.statusCode).toBe(200);
    expect(idsOf(bList.json())).toContain(bSession);
    expect(idsOf(bList.json())).not.toContain(aSession);
    expect(bList.body).not.toContain("A 的研究");
  });

  it("reads its own session and refuses the other's, without saying which", async () => {
    const aSession = await createResearchAs(USER_A, "A 的研究");
    const bSession = await createResearchAs(USER_B, "B 的研究");

    asUser(USER_A);
    const own = await app.inject({
      method: "GET",
      url: `/api/sessions/${aSession}`
    });
    expect(own.statusCode).toBe(200);
    expect((own.json() as { sessionId: string }).sessionId).toBe(aSession);

    const other = await app.inject({
      method: "GET",
      url: `/api/sessions/${bSession}`
    });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({
      error: "Session not found",
      code: "session_not_found"
    });
    expect(other.body).not.toContain("B 的研究");

    // The same answer an id that does not exist gets: no existence oracle.
    const absent = await app.inject({
      method: "GET",
      url: `/api/sessions/${randomUUID()}`
    });
    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toEqual(other.json());
  });

  it("refuses the other's material endpoints through the same boundary", async () => {
    const aSession = await createResearchAs(USER_A, "A 的研究");
    asUser(USER_B);
    for (const path of ["research", "sources", "evidence-map"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/${aSession}/${path}`
      });
      expect(response.statusCode, path).toBe(404);
      expect(response.body).not.toContain("A 的研究");
    }
  });

  it("refuses to delete the other's session and leaves it in place", async () => {
    const aSession = await createResearchAs(USER_A, "A 的研究");
    asUser(USER_B);
    const response = await app.inject({
      method: "DELETE",
      url: `/api/sessions/${aSession}`
    });
    expect(response.statusCode).toBe(404);
    expect(await sessions.getById(aSession)).not.toBeNull();
  });

  it("answers a malformed session id as not found, not as a server error", async () => {
    asUser(USER_A);
    for (const badId of ["not-a-uuid", "1234", "%20"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/sessions/${encodeURIComponent(badId)}`
      });
      expect(response.statusCode, badId).toBe(404);
    }
  });

  it("cannot page another account's research into the list with limit", async () => {
    const aSession = await createResearchAs(USER_A, "A 的研究");
    const bNewer = await createResearchAs(USER_B, "B 的研究");

    asUser(USER_A);
    const narrowed = await app.inject({
      method: "GET",
      url: "/api/sessions?limit=1"
    });
    expect(narrowed.statusCode).toBe(200);
    expect(idsOf(narrowed.json())).toHaveLength(1);
    expect(idsOf(narrowed.json())).toEqual([aSession]);
    expect(idsOf(narrowed.json())).not.toContain(bNewer);
  });
});

describe("session access — sanctioned sharing", () => {
  it("admits a live grant holder and closes again on revocation", async () => {
    const aSession = await createResearchAs(USER_A, "A 的研究");

    asUser(USER_B);
    const before = await app.inject({
      method: "GET",
      url: `/api/sessions/${aSession}`
    });
    expect(before.statusCode).toBe(404);

    asUser(USER_A);
    const granted = await app.inject({
      method: "POST",
      url: "/api/library/grants",
      headers: { "idempotency-key": `grant-${randomUUID()}` },
      payload: {
        sessionId: aSession,
        subjectType: "user",
        subjectId: USER_B,
        scope: "read"
      }
    });
    expect(granted.statusCode).toBe(201);
    const grantId = (granted.json() as { id: string }).id;

    asUser(USER_B);
    const shared = await app.inject({
      method: "GET",
      url: `/api/sessions/${aSession}`
    });
    expect(shared.statusCode).toBe(200);
    const sharedList = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(idsOf(sharedList.json())).toContain(aSession);

    asUser(USER_A);
    const revoked = await app.inject({
      method: "POST",
      url: `/api/library/grants/${grantId}/revoke`,
      headers: { "idempotency-key": `revoke-${randomUUID()}` },
      payload: { reason: "sharing withdrawn" }
    });
    expect(revoked.statusCode).toBe(200);

    asUser(USER_B);
    const after = await app.inject({
      method: "GET",
      url: `/api/sessions/${aSession}`
    });
    expect(after.statusCode).toBe(404);
  });

  it("admits an accepted team member, because collaboration happens inside the research", async () => {
    const aSession = await createResearchAs(USER_A, "A 的研究");

    asUser(USER_A);
    const invited = await app.inject({
      method: "POST",
      url: `/api/sessions/${aSession}/collaboration/members/invite`,
      headers: { "idempotency-key": `invite-${randomUUID()}` },
      payload: { userId: USER_B, role: "reviewer" }
    });
    expect(invited.statusCode).toBe(201);

    asUser(USER_B);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/sessions/${aSession}/collaboration/members/${USER_B}/accept`,
      headers: { "idempotency-key": `accept-${randomUUID()}` },
      payload: {}
    });
    expect(accepted.statusCode).toBe(200);

    const read = await app.inject({
      method: "GET",
      url: `/api/sessions/${aSession}`
    });
    expect(read.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(idsOf(list.json())).toContain(aSession);
  });
});

describe("session access — legacy rows without an owner", () => {
  /**
   * A legacy row is built the only way the product could have built one: a
   * project and a session with no owner recorded, which no current route can
   * produce.
   */
  async function seedLegacySession(name: string): Promise<string> {
    const projectId = randomUUID();
    await database.insert(projects).values({
      id: projectId,
      name,
      input: {}
    });
    const sessionId = randomUUID();
    await sessions.create({
      id: sessionId,
      projectId,
      locale: "zh-CN",
      phase: "EVIDENCE",
      operationalStatus: "ACTIVE",
      currentConclusion: null,
      ownerUserId: null
    });
    return sessionId;
  }

  it("is refused to a signed-in researcher and admitted to the administrator role", async () => {
    const legacyId = await seedLegacySession("Legacy research");

    asUser(USER_A);
    const researcher = await app.inject({
      method: "GET",
      url: `/api/sessions/${legacyId}`
    });
    expect(researcher.statusCode).toBe(404);
    const researcherList = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    expect(idsOf(researcherList.json())).not.toContain(legacyId);

    asUser(ADMIN, "owner");
    const administrator = await app.inject({
      method: "GET",
      url: `/api/sessions/${legacyId}`
    });
    expect(administrator.statusCode).toBe(200);
    const administratorList = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    expect(idsOf(administratorList.json())).toContain(legacyId);
  });
});

describe("session access — the legal workflow still works", () => {
  it("creates, reads and lists a research as its owner", async () => {
    asUser(USER_A);
    const sessionId = await createResearchAs(USER_A, "正常研究流程");

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}`
    });
    expect(detail.statusCode).toBe(200);

    const research = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/research`
    });
    expect(research.statusCode).toBe(200);

    const sources = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/sources`
    });
    expect(sources.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(list.statusCode).toBe(200);
    expect(idsOf(list.json())).toContain(sessionId);
  });

  it("creates the research owned by the identity that created it, not by the body", async () => {
    const sessionId = await createResearchAs(USER_A, "归属来自身份");
    const row = await sessions.getById(sessionId);
    expect(row?.ownerUserId).toBe(USER_A);

    asUser(USER_B);
    const refused = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}`
    });
    expect(refused.statusCode).toBe(404);
  });
});
