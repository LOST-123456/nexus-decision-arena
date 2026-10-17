/**
 * DB-backed proof that the origin guard runs *before* any business write.
 *
 * The wire-level suite (`browser-security.test.ts`) proves what the guard
 * answers. That is not the same claim as "nothing was written", and the
 * difference matters: a handler that writes and then returns 403 would pass a
 * status-code test while being exactly the vulnerability. So every refusal here
 * is followed by a read of the row it would have changed.
 *
 * Covered write classes, one representative each — cookie-authenticated run
 * control, a high-privilege team role change, a library grant revocation, a
 * file import, and login (which establishes the credential itself):
 *
 *  - a trusted origin performs the write and the database reflects it;
 *  - a hostile origin, a missing origin and a contradictory Fetch Metadata are
 *    refused with zero side effect;
 *  - passing the origin check is not the same as having permission: a viewer
 *    and an anonymous caller still get 403/401 from the route;
 *  - a refused request leaves no idempotency lease behind, so the same key
 *    still behaves as a first attempt afterwards.
 *
 * Runs only on the dedicated test database named by TEST_DATABASE_URL; the
 * fail-closed guard in `@nexus/db` refuses anything else.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentRoles,
  agentRuns,
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  promptVersions,
  ReviewRepository,
  SourceFileRepository,
  SourceLibraryRepository,
  TeamCollaborationRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";
import type { AuthRole } from "../../auth";
import type { AuthAuditEvent } from "../../auth-audit";
import { InMemoryIdempotencyStore } from "../plugins/idempotency";
import { AgentRunService } from "../../research/agent-run-service";
import { FileIngestionService } from "../../research/file-ingestion-service";
import { InMemoryFileStorage } from "../../research/file-storage";
import { CSRF_REJECTION_BODY, type OriginPolicy } from "./origin-policy";

const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const events = new EventRepository(database);
const arena = new ArenaRepository(database);
const reviewRepository = new ReviewRepository(database);
const teamCollaboration = new TeamCollaborationRepository(database);
const sourceLibrary = new SourceLibraryRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const fileRepository = new SourceFileRepository(database);

const TRUSTED = "https://nexus.example";
const HOSTILE = "https://attacker.test";

const POLICY: OriginPolicy = {
  allowed: new Set([TRUSTED]),
  source: "environment",
  empty: false
};

/**
 * A cookie that the guard will treat as ambient credentials. The routes here
 * authenticate through a stubbed identity, so the signature is never verified —
 * what is under test is that the *presence* of the cookie makes the request
 * subject to the origin check, before anything is written.
 */
const SESSION_COOKIE = "nexus_session=test-signature";

const USER_ONE = "user-1";
const USER_TWO = "user-2";

let currentUser: {
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
} | null = { id: USER_ONE, username: "owner-one", displayName: "Owner One", role: "owner" };

function asUser(id: string, role: AuthRole, username = id) {
  currentUser = { id, username, displayName: username, role };
}
function anonymous() {
  currentUser = null;
}

/** Login attempts that reached the route, and the audit trail it produced. */
const authProbe = { authenticates: 0, audit: [] as AuthAuditEvent[] };

function ingestion() {
  return new FileIngestionService({
    files: fileRepository,
    evidence: evidenceRepository,
    storage: new InMemoryFileStorage()
  });
}

function testApp() {
  return createApp(
    {
      auth: {
        userFromRequest: () => currentUser,
        authenticate: async () => {
          authProbe.authenticates += 1;
          return null;
        }
      } as never,
      sessions,
      inspector: {} as never,
      events,
      runSession: { start: async () => undefined },
      reviews: reviewRepository,
      arena,
      agentRuns: new AgentRunService({
        reviews: reviewRepository,
        arena,
        events
      }),
      evidence: evidenceRepository,
      sourceLibrary,
      teamCollaboration,
      fileIngestion: ingestion()
    },
    new InMemoryIdempotencyStore(),
    {
      originPolicy: POLICY,
      authRuntime: {
        auditSink: (event) => {
          authProbe.audit.push(event);
        }
      }
    }
  );
}

const app = testApp();

/**
 * A structural view of an injected response.
 *
 * `app.inject` is declared with overloads that also return a chainable builder,
 * so a small wrapper keeps the helpers below typed without dragging in the
 * underlying HTTP-injection package just for its types.
 */
type InjectResult = {
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  json: () => unknown;
};

function call(options: Record<string, unknown>): Promise<InjectResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return app.inject(options as any) as unknown as Promise<InjectResult>;
}

/** Request helpers: every write goes through one of these two. */
function trusted(init: {
  method: "POST" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}) {
  return call({
    ...init,
    headers: {
      origin: TRUSTED,
      cookie: SESSION_COOKIE,
      ...(init.headers ?? {})
    }
  });
}

function hostile(init: {
  method: "POST" | "PATCH" | "DELETE";
  url: string;
  origin?: string | null;
  secFetchSite?: string;
  headers?: Record<string, string>;
  payload?: unknown;
}) {
  const headers: Record<string, string> = {
    cookie: SESSION_COOKIE,
    ...(init.headers ?? {})
  };
  // `null` means "send no Origin header at all", which is a different case from
  // the literal `Origin: null` and is exercised separately.
  if (init.origin !== null) headers.origin = init.origin ?? HOSTILE;
  if (init.secFetchSite) headers["sec-fetch-site"] = init.secFetchSite;
  return call({ ...init, headers });
}

function expectCsrfRefused(response: { statusCode: number; body: string }) {
  expect(response.statusCode).toBe(403);
  expect(JSON.parse(response.body)).toEqual(CSRF_REJECTION_BODY);
}

beforeEach(async () => {
  await database.execute("TRUNCATE projects CASCADE");
  asUser(USER_ONE, "owner", "Owner One");
  authProbe.authenticates = 0;
  authProbe.audit = [];
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
  await database.end();
});

let PROJECT_ID = newId();

async function seedSession(): Promise<{
  sessionId: string;
  roleId: string;
  promptVersionId: string;
}> {
  PROJECT_ID = newId();
  const sessionId = newId();
  const roleId = newId();
  const promptVersionId = newId();
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "CSRF origin guard integration",
    input: {}
  });
  await database.insert(promptVersions).values({
    id: promptVersionId,
    name: "challenger",
    version: `csrf-${promptVersionId}`,
    content: "Challenge the claim."
  });
  await database.insert(agentRoles).values({
    id: roleId,
    key: `challenger-${roleId}`,
    name: "质疑者",
    goal: "找出主张的薄弱环节",
    perspective: "怀疑",
    evaluationCriteria: {},
    evidenceRequired: {},
    conflictPreference: {},
    lenses: {},
    promptVersionId
  });
  await sessions.create({
    id: sessionId,
    projectId: PROJECT_ID,
    locale: "zh-CN",
    phase: "HUMAN_REVIEW",
    operationalStatus: "PAUSED",
    currentConclusion: null
  });
  return { sessionId, roleId, promptVersionId };
}

/** A research created through the real route, so `owner_user_id` is set. */
async function createResearch(name: string): Promise<string> {
  const response = await trusted({
    method: "POST",
    url: "/api/sessions",
    headers: { "idempotency-key": `session-${randomUUID()}` },
    payload: {
      project: {
        name,
        summary: "Origin guard research",
        targetUsers: "researchers",
        businessModel: "n/a",
        expectedData: "documents"
      },
      locale: "zh-CN",
      researchQuestion: `${name} 的问题`
    }
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

async function startRun(
  sessionId: string,
  ids: { roleId: string; promptVersionId: string }
): Promise<string> {
  const run = await reviewRepository.startCrossReviewRun({
    id: newId(),
    sessionId,
    roleId: ids.roleId,
    promptVersionId: ids.promptVersionId,
    targetClaimId: newId(),
    requestedBy: "Owner One (owner)",
    correlationId: newId()
  });
  return run.id;
}

async function runStatus(runId: string): Promise<string> {
  const rows = await database
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  return rows[0]?.status ?? "missing";
}

async function runCount(sessionId: string): Promise<number> {
  const rows = await database
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(eq(agentRuns.sessionId, sessionId));
  return rows.length;
}

describe("agent run control", () => {
  it("cancels a run for a trusted origin, and the row really changes", async () => {
    const ids = await seedSession();
    const runId = await startRun(ids.sessionId, ids);

    const response = await trusted({
      method: "POST",
      url: `/api/sessions/${ids.sessionId}/agent-runs/${runId}/cancel`,
      headers: {
        "content-type": "application/json",
        "idempotency-key": `cancel-${randomUUID()}`
      },
      payload: { reason: "user requested" }
    });

    expect(response.statusCode).toBe(200);
    expect(await runStatus(runId)).toBe("cancelled");
  });

  it("refuses a cancel from a hostile origin and leaves the run running", async () => {
    const ids = await seedSession();
    const runId = await startRun(ids.sessionId, ids);
    const before = (await events.listAfter(ids.sessionId, 0)).length;

    const response = await hostile({
      method: "POST",
      url: `/api/sessions/${ids.sessionId}/agent-runs/${runId}/cancel`,
      headers: {
        "content-type": "application/json",
        "idempotency-key": `cancel-${randomUUID()}`
      },
      payload: { reason: "user requested" }
    });

    expectCsrfRefused(response);
    expect(await runStatus(runId)).toBe("running");
    // No event was appended either: the refusal precedes the write, not the
    // response.
    expect((await events.listAfter(ids.sessionId, 0)).length).toBe(before);
  });

  it("refuses a cancel that presents no origin at all", async () => {
    const ids = await seedSession();
    const runId = await startRun(ids.sessionId, ids);

    const response = await hostile({
      method: "POST",
      url: `/api/sessions/${ids.sessionId}/agent-runs/${runId}/cancel`,
      origin: null,
      // Browser-shaped but origin-less: a state a browser never produces.
      secFetchSite: "same-origin",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `cancel-${randomUUID()}`
      },
      payload: { reason: "user requested" }
    });

    expectCsrfRefused(response);
    expect(await runStatus(runId)).toBe("running");
  });

  it("refuses a cancel whose Fetch Metadata contradicts its origin", async () => {
    const ids = await seedSession();
    const runId = await startRun(ids.sessionId, ids);

    const response = await hostile({
      method: "POST",
      url: `/api/sessions/${ids.sessionId}/agent-runs/${runId}/cancel`,
      origin: TRUSTED,
      secFetchSite: "cross-site",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `cancel-${randomUUID()}`
      },
      payload: { reason: "user requested" }
    });

    expectCsrfRefused(response);
    expect(await runStatus(runId)).toBe("running");
  });

  it("does not burn the idempotency key of a retry it refused", async () => {
    const ids = await seedSession();
    const runId = await startRun(ids.sessionId, ids);
    const key = `retry-${randomUUID()}`;

    const refused = await hostile({
      method: "POST",
      url: `/api/sessions/${ids.sessionId}/agent-runs/${runId}/retry`,
      headers: { "content-type": "application/json", "idempotency-key": key },
      payload: {}
    });
    expectCsrfRefused(refused);

    // The same key, now from a trusted origin. If the refusal had taken a lease
    // this would replay the refusal (403) or report an in-flight duplicate;
    // instead the request runs for the first time and answers on its merits —
    // here a 409, because a running run is not retryable.
    const firstAttempt = await trusted({
      method: "POST",
      url: `/api/sessions/${ids.sessionId}/agent-runs/${runId}/retry`,
      headers: { "content-type": "application/json", "idempotency-key": key },
      payload: {}
    });
    expect(firstAttempt.statusCode).not.toBe(403);
    expect(JSON.parse(firstAttempt.body)).not.toEqual(CSRF_REJECTION_BODY);
    expect(firstAttempt.statusCode).toBe(409);

    // And nothing was written: still one run, still running.
    expect(await runCount(ids.sessionId)).toBe(1);
    expect(await runStatus(runId)).toBe("running");
  });

  it("still answers 401 to an anonymous cancel, rather than pretending it was CSRF", async () => {
    const ids = await seedSession();
    const runId = await startRun(ids.sessionId, ids);
    anonymous();

    // No cookie and no origin: nothing ambient to protect, so the route decides.
    const response = await call({
      method: "POST",
      url: `/api/sessions/${ids.sessionId}/agent-runs/${runId}/cancel`,
      headers: { "content-type": "application/json" },
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(await runStatus(runId)).toBe("running");
  });
});

describe("team role changes", () => {
  async function invitedMember(): Promise<{ sessionId: string }> {
    const sessionId = await createResearch("团队角色研究");
    const invite = await trusted({
      method: "POST",
      url: `/api/sessions/${sessionId}/collaboration/members/invite`,
      headers: { "idempotency-key": `invite-${randomUUID()}` },
      payload: { userId: USER_TWO, role: "reviewer" }
    });
    expect(invite.statusCode).toBe(201);

    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const accept = await trusted({
      method: "POST",
      url: `/api/sessions/${sessionId}/collaboration/members/${USER_TWO}/accept`,
      payload: {}
    });
    expect(accept.statusCode).toBe(200);
    asUser(USER_ONE, "owner", "Owner One");
    return { sessionId };
  }

  async function storedRole(sessionId: string, userId: string): Promise<string | null> {
    const members = await teamCollaboration.listMemberships(sessionId);
    return members.find((member) => member.userId === userId)?.role ?? null;
  }

  it("changes a role for a trusted origin, and the membership really changes", async () => {
    const { sessionId } = await invitedMember();

    const response = await trusted({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/collaboration/members/${USER_TWO}/role`,
      headers: { "content-type": "application/json" },
      payload: { role: "editor" }
    });

    expect(response.statusCode).toBe(200);
    expect(await storedRole(sessionId, USER_TWO)).toBe("editor");
  });

  it("refuses a hostile-origin role change and leaves the stored role alone", async () => {
    const { sessionId } = await invitedMember();

    const response = await hostile({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/collaboration/members/${USER_TWO}/role`,
      headers: { "content-type": "application/json" },
      payload: { role: "owner" }
    });

    expectCsrfRefused(response);
    // The escalation the attacker asked for did not happen.
    expect(await storedRole(sessionId, USER_TWO)).toBe("reviewer");
  });

  it("refuses a hostile-origin role change even on a research the caller owns", async () => {
    const { sessionId } = await invitedMember();

    // The caller really does own this research. A valid origin check is still
    // required: ownership is not a substitute for provenance.
    const response = await hostile({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/collaboration/members/${USER_TWO}/role`,
      headers: { "content-type": "application/json" },
      payload: { role: "owner" }
    });

    expectCsrfRefused(response);
    expect(await storedRole(sessionId, USER_TWO)).toBe("reviewer");
  });

  it("passing the origin check does not grant a viewer write permission", async () => {
    const { sessionId } = await invitedMember();
    asUser(USER_TWO, "viewer", "Viewer Two");

    const response = await trusted({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/collaboration/members/${USER_ONE}/role`,
      headers: { "content-type": "application/json" },
      payload: { role: "viewer" }
    });

    // 403 from the collaboration role gate, not from the origin guard: the two
    // layers are independent, and the refusal body proves which one fired.
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).not.toEqual(CSRF_REJECTION_BODY);
    expect(await storedRole(sessionId, USER_ONE)).not.toBe("viewer");
  });

  it("answers an anonymous caller 401, not a CSRF refusal", async () => {
    const { sessionId } = await invitedMember();
    anonymous();

    const response = await call({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/collaboration/members/${USER_TWO}/role`,
      headers: { "content-type": "application/json" },
      payload: { role: "owner" }
    });

    expect(response.statusCode).toBe(401);
    expect(await storedRole(sessionId, USER_TWO)).toBe("reviewer");
  });
});

describe("library grant revocation", () => {
  async function liveGrant(): Promise<{ sessionId: string; grantId: string }> {
    const sessionId = await createResearch("共享授权研究");
    const grant = await trusted({
      method: "POST",
      url: "/api/library/grants",
      headers: { "idempotency-key": `grant-${randomUUID()}` },
      payload: {
        sessionId,
        subjectType: "user",
        subjectId: USER_TWO,
        scope: "read"
      }
    });
    expect(grant.statusCode).toBe(201);
    return { sessionId, grantId: (grant.json() as { id: string }).id };
  }

  async function revokedAt(sessionId: string, grantId: string): Promise<string | undefined> {
    const read = await call({
      method: "GET",
      url: `/api/library/grants?sessionId=${sessionId}`,
      headers: { origin: TRUSTED, cookie: SESSION_COOKIE }
    });
    const grants = (
      read.json() as { grants: Array<{ id: string; revokedAt?: string }> }
    ).grants;
    return grants.find((row) => row.id === grantId)?.revokedAt;
  }

  it("revokes a grant for a trusted origin, and the grant really closes", async () => {
    const { sessionId, grantId } = await liveGrant();

    const response = await trusted({
      method: "POST",
      url: `/api/library/grants/${grantId}/revoke`,
      headers: { "idempotency-key": `revoke-${randomUUID()}` },
      payload: { reason: "研究已结束" }
    });

    expect(response.statusCode).toBe(200);
    expect(await revokedAt(sessionId, grantId)).toBeTruthy();
  });

  it("refuses a hostile-origin revoke and the grant stays live", async () => {
    const { sessionId, grantId } = await liveGrant();

    const response = await hostile({
      method: "POST",
      url: `/api/library/grants/${grantId}/revoke`,
      headers: { "idempotency-key": `revoke-${randomUUID()}` },
      payload: { reason: "attacker" }
    });

    expectCsrfRefused(response);
    expect(await revokedAt(sessionId, grantId)).toBeUndefined();
  });
});

describe("file import", () => {
  const BYTES = new TextEncoder().encode("Costs rose by 12%.\n");

  let UPLOAD_SESSION_ID = "";

  function upload(origin: string | null, secFetchSite?: string) {
    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("costs.txt"),
      "idempotency-key": `upload-${randomUUID()}`,
      cookie: SESSION_COOKIE
    };
    if (origin !== null) headers.origin = origin;
    if (secFetchSite) headers["sec-fetch-site"] = secFetchSite;
    return call({
      method: "POST",
      url: `/api/sessions/${UPLOAD_SESSION_ID}/files`,
      headers,
      payload: Buffer.from(BYTES)
    });
  }

  beforeEach(async () => {
    const ids = await seedSession();
    UPLOAD_SESSION_ID = ids.sessionId;
    asUser(USER_ONE, "reviewer", "Researcher One");
  });

  async function storedFiles(): Promise<number> {
    const response = await call({
      method: "GET",
      url: `/api/sessions/${UPLOAD_SESSION_ID}/files`,
      headers: { origin: TRUSTED, cookie: SESSION_COOKIE }
    });
    return (response.json() as { files: unknown[] }).files.length;
  }

  it("imports a file for a trusted origin, and the file really exists", async () => {
    const response = await upload(TRUSTED);

    expect([200, 201]).toContain(response.statusCode);
    expect(await storedFiles()).toBe(1);
  });

  it("refuses a hostile-origin upload and stores nothing", async () => {
    const response = await upload(HOSTILE);

    expectCsrfRefused(response);
    expect(await storedFiles()).toBe(0);
  });

  it("refuses a browser-shaped upload with no origin and stores nothing", async () => {
    const response = await upload(null, "same-origin");

    expectCsrfRefused(response);
    expect(await storedFiles()).toBe(0);
  });

  it("lets a script without browser signals import a file, as the documented exemption", async () => {
    // No Origin and no Fetch Metadata: not a page. The route still decides who
    // the caller is; nothing here bypasses the role check.
    const response = await upload(null);

    expect([200, 201]).toContain(response.statusCode);
    expect(await storedFiles()).toBe(1);
  });
});

describe("login", () => {
  it("refuses a hostile-origin login before the credential is even checked", async () => {
    const response = await hostile({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: { username: "owner-one", password: "correct-horse" }
    });

    expectCsrfRefused(response);
    // No password was verified, no throttle slot consumed, no audit row: the
    // refusal happened before the handler, which is the only way to be sure no
    // session could have been established.
    expect(authProbe.authenticates).toBe(0);
    expect(authProbe.audit).toEqual([]);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("reaches the handler for a trusted origin, and a failed login sets no cookie", async () => {
    const response = await trusted({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: { username: "owner-one", password: "wrong" }
    });

    expect(authProbe.authenticates).toBe(1);
    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("does not set a session cookie on a refused login carrying an old one", async () => {
    const response = await hostile({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: { username: "owner-one", password: "correct-horse" }
    });

    expectCsrfRefused(response);
    // Replacing or refreshing the credential is a state change too, and it did
    // not happen.
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});
