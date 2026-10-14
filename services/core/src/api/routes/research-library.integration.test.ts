import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  ReviewRepository,
  SourceLibraryRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";
import type { AuthRole } from "../../auth";
import type { FetchedPage } from "../../research/page-fetch";
import { SourceImportService } from "../../research/source-import-service";

/**
 * DB-backed integration test for the cross-research library routes.
 *
 * The acceptance question this file answers, end to end and over real HTTP:
 * material belongs to the research it was collected in, and the *only* way it
 * moves is an explicit, attributed, audited copy that keeps its origin and
 * inherits no judgment. Concretely, against a real database:
 *  - an owner may copy a source between their own researches, and the copy
 *    lands with its own capture, its lineage and an audit event, unverified;
 *  - a research the caller may not see answers 404 — for the source, and for
 *    the copy target alike — while a filter naming it answers empty rather
 *    than confirming that it exists;
 *  - a `read` grant lets the holder browse but not copy, so a friendlier
 *    share cannot be silently escalated into a right the owner never gave;
 *  - a viewer writes nothing, and an anonymous caller is refused outright;
 *  - after the origin moves (a new capture) the copy reports itself as out of
 *    date, and capturing different text in the target records a fork;
 *  - the language filter reads the languages the system actually recorded —
 *    a registered capture language, or the source language of a stored
 *    translation — and never guesses one from the text;
 *  - a duplicate in the target is refused with a pointer to the existing row.
 *
 * No model and no network are involved. Pages are served from an in-process
 * fixture table, and material is created through the *real* intake route: a
 * hand-seeded row could carry a shape the product cannot produce, and the
 * library only ever sees what that route writes (a canonical url, a captured
 * snapshot, a retrieval status). The database is the dedicated test database
 * named by TEST_DATABASE_URL; the guard refuses anything else.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const events = new EventRepository(database);
const sourceLibrary = new SourceLibraryRepository(database);
const arena = new ArenaRepository(database);
const reviews = new ReviewRepository(database);

/** Pages the injected fetcher hands back, keyed by the url it asks for. */
const pages = new Map<string, FetchedPage>();

/** Monotonic so "the latest capture" is never ambiguous within a test. */
let clock = 0;

const importService = new SourceImportService({
  evidence: evidenceRepository,
  fetch: async (url) => {
    const page = pages.get(url);
    if (!page) {
      // Loud, not silent: a test that asks for a page it never registered is
      // a broken test, not an empty page.
      throw new Error(`No page fixture is registered for ${url}`);
    }
    return page;
  }
});

const USER_ONE = "user-1";
const USER_TWO = "user-2";

/** The identity every request is made as; `null` means anonymous. */
let currentUser: {
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
} | null = {
  id: USER_ONE,
  username: "owner",
  displayName: "Owner One",
  role: "owner"
};

function asUser(id: string, role: AuthRole, username = id) {
  currentUser = { id, username, displayName: username, role };
}

function anonymous() {
  currentUser = null;
}

function testApp(directory?: Array<{
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
}>) {
  return createApp({
    // `auth` is present, so an anonymous request is refused rather than
    // silently treated as the workspace operator. A directory is only wired
    // in where a test asks for one: with none, the service cannot resolve a
    // subject and stores what it was given, which is its own case to cover.
    auth: {
      userFromRequest: () => currentUser,
      ...(directory ? { listUsers: () => directory } : {})
    } as never,
    sessions,
    inspector: {} as never,
    events,
    runSession: { start: async () => undefined },
    evidence: evidenceRepository,
    arena,
    reviews,
    sourceLibrary,
    sourceIntake: importService
  });
}

const app = testApp();

/** Two real accounts, for the tests that exercise subject resolution. */
const DIRECTORY = [
  { id: USER_ONE, username: "owner-one", displayName: "Owner One", role: "owner" as AuthRole },
  { id: USER_TWO, username: "reviewer-two", displayName: "Reviewer Two", role: "reviewer" as AuthRole }
];

beforeEach(async () => {
  await database.execute("TRUNCATE projects CASCADE");
  pages.clear();
  clock = 0;
  asUser(USER_ONE, "owner", "Owner One");
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

async function createResearch(name: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { "idempotency-key": `session-${randomUUID()}` },
    payload: {
      project: {
        name,
        summary: "Cross-research reuse",
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

/** One clock tick per capture, so "latest" always has an unambiguous winner. */
function nextRetrievedAt(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 12, 9, 0, clock)).toISOString();
}

function hashOf(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Serves one page for `url` and imports it through the real intake route.
 *
 * Importing the same url again is how a page is seen to have moved on: the
 * importer recognizes the canonical url, finds the source that already
 * represents it and appends the new capture as a version.
 */
async function importPage(
  sessionId: string,
  input: {
    url: string;
    content: string;
    title?: string;
    publisher?: string;
    author?: string;
    publishedAt?: string;
  }
): Promise<{ sourceId: string; snapshotId: string; contentHash: string }> {
  const contentHash = hashOf(input.content);
  pages.set(input.url, {
    requestedUrl: input.url,
    finalUrl: input.url,
    canonicalUrl: input.url,
    status: 200,
    contentType: "text/html; charset=utf-8",
    contentEncoding: null,
    content: input.content,
    contentHash,
    wireBytes: Buffer.byteLength(input.content),
    contentBytes: Buffer.byteLength(input.content),
    charCount: input.content.length,
    title: input.title ?? null,
    author: input.author ?? null,
    publisher: input.publisher ?? null,
    publishedAt: input.publishedAt ?? null,
    retrievedAt: nextRetrievedAt(),
    redirects: [],
    truncated: false
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/sources/import`,
    headers: { "idempotency-key": `import-${randomUUID()}` },
    payload: { url: input.url }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as {
    source: { id: string };
    snapshot: { id: string };
  };
  return {
    sourceId: body.source.id,
    snapshotId: body.snapshot.id,
    contentHash
  };
}

/**
 * Registers a source by hand, the way a researcher cites a page-pending item.
 *
 * This is the honest way to produce material that has *no* capture: the intake
 * route always captures, and canonicalization is a retrieval fact the product
 * deliberately refuses to accept from a client (see `SourceDraftSchema`).
 */
async function registerManualSource(
  sessionId: string,
  input: { title: string; url: string }
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/sources`,
    headers: { "idempotency-key": `source-${randomUUID()}` },
    payload: { title: input.title, kind: "url", url: input.url }
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { source: { id: string } }).source.id;
}

type LineageResponse = {
  lineage: Record<
    string,
    {
      originSessionId: string;
      originSourceId: string;
      originSnapshotHash?: string;
      copiedBy: string;
      copiedAt: string;
      forkState: string;
      originStatus: string;
    }
  >;
};

async function copyInto(
  targetSessionId: string,
  sourceSessionId: string,
  sourceId: string,
  mode: "copy" | "reference" = "copy",
  key = `copy-${randomUUID()}`
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${targetSessionId}/library/copies`,
    headers: { "idempotency-key": key },
    payload: { sourceSessionId, sourceId, mode }
  });
}

async function lineageOf(sessionId: string): Promise<LineageResponse> {
  const response = await app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/library/lineage`
  });
  expect(response.statusCode).toBe(200);
  return response.json() as LineageResponse;
}

describe("cross-research library routes", () => {
  it("copies a source between the caller's own researches, keeping origin and audit", async () => {
    const origin = await createResearch("来源研究");
    const target = await createResearch("目标研究");
    const imported = await importPage(origin, {
      url: "https://example.org/q4",
      content: "第四季度出货量同比增长 12%。",
      title: "季度回顾",
      publisher: "统计年报",
      author: "统计处"
    });

    const copied = await copyInto(target, origin, imported.sourceId, "copy", "copy-key");
    expect(copied.statusCode).toBe(201);
    const body = copied.json() as {
      sourceId: string;
      sessionId: string;
      mode: string;
      copy: { originStatus: string; originSnapshotHash: string; forkState: string };
    };
    expect(body.sessionId).toBe(target);
    expect(body.mode).toBe("copy");
    expect(body.copy.originStatus).toBe("current");
    expect(body.copy.originSnapshotHash).toBe(imported.contentHash);
    expect(body.copy.forkState).toBe("synced");

    // The copy is real material inside the target, not a pointer: it has its
    // own capture, and the origin still has exactly one of its own.
    const targetSources = await app.inject({
      method: "GET",
      url: `/api/sessions/${target}/sources`
    });
    expect(targetSources.statusCode).toBe(200);
    const listed = targetSources.json() as { sources: Array<{ id: string; title: string }> };
    expect(listed.sources.map((row) => row.id)).toEqual([body.sourceId]);
    expect(listed.sources[0]?.title).toBe("季度回顾");
    expect(await sourceLibrary.listVersions(imported.sourceId)).toHaveLength(1);
    const copiedVersions = await sourceLibrary.listVersions(body.sourceId);
    expect(copiedVersions).toHaveLength(1);
    expect(copiedVersions[0]?.content).toBe("第四季度出货量同比增长 12%。");

    // Nothing was inherited: the target holds no evidence for the copy, so
    // nothing about it can read as already verified.
    const targetEvidence = await app.inject({
      method: "GET",
      url: `/api/sessions/${target}/research`
    });
    expect(targetEvidence.statusCode).toBe(200);
    expect(
      (targetEvidence.json() as { evidence: unknown[] }).evidence
    ).toHaveLength(0);

    // The copy is audited in the target, and the target's lineage explains it.
    const targetEvents = await events.listAfter(target, 0);
    expect(targetEvents.map((event) => event.type)).toContain(
      "SOURCE_COPIED_TO_RESEARCH"
    );
    const lineageBody = await lineageOf(target);
    const record = lineageBody.lineage[body.sourceId];
    expect(record?.originSessionId).toBe(origin);
    expect(record?.originSourceId).toBe(imported.sourceId);
    expect(record?.originSnapshotHash).toBe(imported.contentHash);
    expect(record?.copiedBy).toContain("Owner One");
    expect(record?.copiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The origin's own lineage stays empty: a copy made *into* a research is
    // not a copy the origin made.
    expect((await lineageOf(origin)).lineage).toEqual({});

    // Repeating the *same* request (same key, same body) is the same copy, not
    // a second one — the idempotency key is what makes a retry safe. A
    // different key is a different request, and is answered as a duplicate.
    const replay = await copyInto(target, origin, imported.sourceId, "copy", "copy-key");
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as { sourceId: string }).sourceId).toBe(body.sourceId);
    const replayAgain = await copyInto(target, origin, imported.sourceId, "copy", "copy-key");
    expect(replayAgain.statusCode).toBe(201);
    expect((replayAgain.json() as { sourceId: string }).sourceId).toBe(body.sourceId);
    expect(await sourceLibrary.listCopiesForSession(target)).toHaveLength(1);
    const otherKey = await copyInto(target, origin, imported.sourceId);
    expect(otherKey.statusCode).toBe(409);
    expect((otherKey.json() as { code: string }).code).toBe("duplicate_source");
  });

  it("answers 404 for a research the caller may not see, and empty for its filters", async () => {
    const mine = await createResearch("我的研究");
    const imported = await importPage(mine, {
      url: "https://example.org/mine",
      content: "我的正文",
      title: "我的来源"
    });

    const foreignId = newId();
    asUser(USER_TWO, "reviewer");

    // A source in someone else's research is indistinguishable from an id
    // that does not exist.
    const detail = await app.inject({
      method: "GET",
      url: `/api/library/sources/${imported.sourceId}`
    });
    expect(detail.statusCode).toBe(404);
    expect(detail.json()).toEqual({ error: "Not found", code: "not_found" });

    const unknown = await app.inject({
      method: "GET",
      url: `/api/library/sources/${foreignId}`
    });
    expect(unknown.statusCode).toBe(404);
    // The same answer, byte for byte: the API is not an existence oracle.
    expect(unknown.json()).toEqual(detail.json());

    // Reading one capture of a foreign source is refused the same way.
    const version = await app.inject({
      method: "GET",
      url: `/api/library/sources/${imported.sourceId}/snapshots/${imported.snapshotId}`
    });
    expect(version.statusCode).toBe(404);

    // Searching "everything" returns nothing, and naming a foreign session in
    // a filter returns empty rather than confirming it exists.
    const search = await app.inject({ method: "GET", url: "/api/library/sources" });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toEqual({ sources: [], total: 0 });
    const filtered = await app.inject({
      method: "GET",
      url: `/api/library/sources?sessionId=${mine}`
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toEqual({ sources: [], total: 0 });

    const own = await app.inject({ method: "GET", url: "/api/library/sessions" });
    expect((own.json() as { sessions: unknown[] }).sessions).toHaveLength(0);

    const theirs = await createResearch("user-2 自己的研究");

    // A source in someone else's research cannot be taken, even into the
    // caller's own research: the source is invisible.
    const invisibleSource = await copyInto(theirs, mine, imported.sourceId);
    expect(invisibleSource.statusCode).toBe(404);
    expect(invisibleSource.json()).toEqual({ error: "Not found", code: "not_found" });

    // Nor may the caller write into a research they do not own, even though
    // that research really exists: the answer is the one an unknown id gets,
    // so the route cannot be used to probe for other people's researches.
    const foreignTarget = await app.inject({
      method: "POST",
      url: `/api/sessions/${mine}/library/copies`,
      headers: { "idempotency-key": `copy-${randomUUID()}` },
      payload: { sourceSessionId: theirs, sourceId: imported.sourceId, mode: "copy" }
    });
    expect(foreignTarget.statusCode).toBe(404);
    expect(foreignTarget.json()).toEqual({
      error: "Session not found",
      code: "session_not_found"
    });

    // Lineage is part of the research it belongs to, so a caller who cannot
    // browse a research cannot read where its material came from either.
    const foreignLineage = await app.inject({
      method: "GET",
      url: `/api/sessions/${mine}/library/lineage`
    });
    expect(foreignLineage.statusCode).toBe(404);
    // The same answer an id that does not exist gets, so the route is not a
    // way to learn which researches exist.
    const unknownLineage = await app.inject({
      method: "GET",
      url: `/api/sessions/${foreignId}/library/lineage`
    });
    expect(unknownLineage.statusCode).toBe(404);
    expect(unknownLineage.json()).toEqual(foreignLineage.json());

    // Sharing the caller's research is the owner's decision, not theirs.
    const grant = await app.inject({
      method: "POST",
      url: "/api/library/grants",
      headers: { "idempotency-key": `grant-${randomUUID()}` },
      payload: {
        sessionId: mine,
        subjectType: "user",
        subjectId: USER_TWO,
        scope: "read"
      }
    });
    expect(grant.statusCode).toBe(403);
    expect((grant.json() as { code: string }).code).toBe("grant_not_permitted");
  });

  it("keeps a read grant to browsing only, and lets a copy grant travel", async () => {
    asUser(USER_ONE, "owner", "Owner One");
    const origin = await createResearch("共享出去的研究");
    const imported = await importPage(origin, {
      url: "https://example.org/q4",
      content: "正文",
      title: "季度回顾",
      publisher: "统计年报",
      publishedAt: "2026-03-04T08:00:00.000Z"
    });

    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const mine = await createResearch("reviewer 的研究");

    // With no grant at all, the research is invisible.
    const beforeGrant = await app.inject({ method: "GET", url: "/api/library/sources" });
    expect(beforeGrant.json()).toEqual({ sources: [], total: 0 });

    // The owner grants read-only access.
    asUser(USER_ONE, "owner", "Owner One");
    const readGrant = await app.inject({
      method: "POST",
      url: "/api/library/grants",
      headers: { "idempotency-key": `grant-${randomUUID()}` },
      payload: {
        sessionId: origin,
        subjectType: "user",
        subjectId: USER_TWO,
        scope: "read"
      }
    });
    expect(readGrant.statusCode).toBe(201);
    const readGrantId = (readGrant.json() as { id: string }).id;
    expect((readGrant.json() as { revokedAt?: string }).revokedAt).toBeUndefined();

    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const visible = await app.inject({ method: "GET", url: "/api/library/sessions" });
    const sharedSession = (
      visible.json() as {
        sessions: Array<{ sessionId: string; access: string; grantScope?: string }>;
      }
    ).sessions.find((row) => row.sessionId === origin);
    expect(sharedSession?.access).toBe("granted");
    // The reader can tell browsing apart from copying before pressing a
    // button, rather than being refused afterwards.
    expect(sharedSession?.grantScope).toBe("read");

    // Filters combine, and answer inside the granted research only.
    const search = await app.inject({
      method: "GET",
      url:
        `/api/library/sources?publisher=统计&domain=example.org` +
        `&publishedFrom=2026-01-01T00:00:00.000Z&publishedTo=2026-12-31T00:00:00.000Z`
    });
    expect(search.statusCode).toBe(200);
    expect((search.json() as { total: number }).total).toBe(1);
    // The same query outside the published window is empty rather than widened:
    // a date filter that quietly ignored its bounds would be a lie about what
    // the material is.
    const outsideWindow = await app.inject({
      method: "GET",
      url: `/api/library/sources?publishedFrom=2027-01-01T00:00:00.000Z`
    });
    expect((outsideWindow.json() as { total: number }).total).toBe(0);
    const narrowed = await app.inject({
      method: "GET",
      url: `/api/library/sources?domain=other.test`
    });
    expect((narrowed.json() as { total: number }).total).toBe(0);

    // A read grant does not carry the right to take the material away.
    const refused = await copyInto(mine, origin, imported.sourceId);
    expect(refused.statusCode).toBe(404);
    expect(refused.json()).toEqual({ error: "Not found", code: "not_found" });

    // A second, `copy`-scoped grant is a different permission, so it is a new
    // grant rather than a duplicate.
    asUser(USER_ONE, "owner", "Owner One");
    const copyGrant = await app.inject({
      method: "POST",
      url: "/api/library/grants",
      headers: { "idempotency-key": `grant-${randomUUID()}` },
      payload: {
        sessionId: origin,
        subjectType: "user",
        subjectId: USER_TWO,
        scope: "copy"
      }
    });
    expect(copyGrant.statusCode).toBe(201);
    const copyGrantId = (copyGrant.json() as { id: string }).id;

    // The identical request is a duplicate live grant.
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/library/grants",
      headers: { "idempotency-key": `grant-${randomUUID()}` },
      payload: {
        sessionId: origin,
        subjectType: "user",
        subjectId: USER_TWO,
        scope: "copy"
      }
    });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { code: string }).code).toBe("grant_exists");

    // Holding a grant is not the same as administering it: the reader may use
    // what was shared, but the sharing decision stays the owner's.
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const readerRevoke = await app.inject({
      method: "POST",
      url: `/api/library/grants/${readGrantId}/revoke`,
      headers: { "idempotency-key": `revoke-${randomUUID()}` },
      payload: { reason: "我说了算" }
    });
    expect(readerRevoke.statusCode).toBe(403);
    expect((readerRevoke.json() as { code: string }).code).toBe(
      "grant_not_permitted"
    );
    const readerGrant = await app.inject({
      method: "POST",
      url: "/api/library/grants",
      headers: { "idempotency-key": `grant-${randomUUID()}` },
      payload: {
        sessionId: origin,
        subjectType: "user",
        subjectId: "user-3",
        scope: "copy"
      }
    });
    expect(readerGrant.statusCode).toBe(403);

    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const copied = await copyInto(mine, origin, imported.sourceId);
    expect(copied.statusCode).toBe(201);
    const copiedSourceId = (copied.json() as { sourceId: string }).sourceId;

    // The grant lets material travel *out*, never lets its holder write into
    // the research that granted it.
    const intoOwnerResearch = await copyInto(origin, origin, imported.sourceId);
    expect(intoOwnerResearch.statusCode).toBe(404);
    expect(intoOwnerResearch.json()).toEqual({
      error: "Session not found",
      code: "session_not_found"
    });

    // A viewer may read the library but write nothing at all.
    asUser(USER_TWO, "viewer", "Viewer Two");
    const viewerCopy = await copyInto(mine, origin, imported.sourceId);
    expect(viewerCopy.statusCode).toBe(403);
    expect((viewerCopy.json() as { code: string }).code).toBe("reviewer_required");
    const viewerBrowse = await app.inject({ method: "GET", url: "/api/library/sources" });
    expect(viewerBrowse.statusCode).toBe(200);

    // Revoking the copy grant takes the visibility with it, but never the copy
    // or the audit trail.
    asUser(USER_ONE, "owner", "Owner One");
    const revoke = await app.inject({
      method: "POST",
      url: `/api/library/grants/${copyGrantId}/revoke`,
      headers: { "idempotency-key": `revoke-${randomUUID()}` },
      payload: { reason: "研究已结束" }
    });
    expect(revoke.statusCode).toBe(200);
    expect((revoke.json() as { revokedBy: string }).revokedBy).toContain("Owner One");
    // Revoking twice is not a second decision.
    const revokeAgain = await app.inject({
      method: "POST",
      url: `/api/library/grants/${copyGrantId}/revoke`,
      headers: { "idempotency-key": `revoke-${randomUUID()}` },
      payload: { reason: "再撤一次" }
    });
    expect(revokeAgain.statusCode).toBe(404);
    // The audit row survives, revoked rather than deleted.
    const grants = await app.inject({
      method: "GET",
      url: `/api/library/grants?sessionId=${origin}`
    });
    const listed = (
      grants.json() as { grants: Array<{ id: string; revokedAt?: string }> }
    ).grants;
    expect(listed.map((row) => row.id).sort()).toEqual(
      [readGrantId, copyGrantId].sort()
    );
    expect(listed.filter((row) => row.revokedAt).length).toBeGreaterThan(0);

    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const gone = await app.inject({ method: "GET", url: "/api/library/sources" });
    const goneRows = (
      gone.json() as {
        sources: Array<{ sourceId: string; sessionId: string }>;
      }
    ).sources;
    // Revoking the copy grant withdrew the right to *take* material, not the
    // right to browse: the read grant is still live, so the origin is still
    // visible alongside the material the reviewer already copied into their
    // own research.
    expect(goneRows.map((row) => row.sessionId).sort()).toEqual(
      [origin, mine].sort()
    );
    expect(goneRows.map((row) => row.sourceId).sort()).toEqual(
      [imported.sourceId, copiedSourceId].sort()
    );
    const lineage = (await lineageOf(mine)).lineage[copiedSourceId];
    // The copy grant is what was revoked, so the origin is no longer
    // reachable for copying — but it is still readable through the read
    // grant, so the link is currently intact.
    expect(["current", "changed"]).toContain(lineage?.originStatus);
    expect(lineage?.originSnapshotHash).toBe(imported.contentHash);

    // Revoke the read grant too: now the origin is unreachable, and the copy
    // reports its link as dead while keeping everything it holds.
    asUser(USER_ONE, "owner", "Owner One");
    const revokeRead = await app.inject({
      method: "POST",
      url: `/api/library/grants/${readGrantId}/revoke`,
      headers: { "idempotency-key": `revoke-${randomUUID()}` },
      payload: { reason: "全部收回" }
    });
    expect(revokeRead.statusCode).toBe(200);

    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const afterRevoke = await app.inject({ method: "GET", url: "/api/library/sources" });
    // Only the reviewer's own research is left: the shared material is gone
    // from the library, while the copy they legitimately made stays theirs.
    const afterRows = (
      afterRevoke.json() as {
        sources: Array<{ sourceId: string; sessionId: string }>;
      }
    ).sources;
    expect(afterRows.map((row) => row.sessionId)).toEqual([mine]);
    expect(afterRows.map((row) => row.sourceId)).toEqual([copiedSourceId]);
    const deadLink = (await lineageOf(mine)).lineage[copiedSourceId];
    expect(deadLink?.originStatus).toBe("revoked");
    // The material itself is untouched: the copy is self-contained.
    const copyStillThere = await app.inject({
      method: "GET",
      url: `/api/sessions/${mine}/sources`
    });
    expect(
      (copyStillThere.json() as { sources: Array<{ id: string }> }).sources.map(
        (row) => row.id
      )
    ).toEqual([copiedSourceId]);
    const originAudit = await events.listAfter(origin, 0);
    expect(originAudit.map((event) => event.type)).toEqual(
      expect.arrayContaining(["SOURCE_LIBRARY_GRANTED", "SOURCE_LIBRARY_REVOKED"])
    );
  });

  it("resolves a typed grant subject to a real account, and refuses one that names nothing", async () => {
    const withDirectory = testApp(DIRECTORY);
    asUser(USER_ONE, "owner", "Owner One");
    const origin = await createResearch("授权对象解析");

    const grant = (subjectType: "user" | "role", subjectId: string) =>
      withDirectory.inject({
        method: "POST",
        url: "/api/library/grants",
        headers: { "idempotency-key": `grant-${randomUUID()}` },
        payload: { sessionId: origin, subjectType, subjectId, scope: "read" }
      });

    // A username is what an operator reaches for, so it has to work: the
    // stored subject is the account id the authorization actually matches on.
    const byUsername = await grant("user", "reviewer-two");
    expect(byUsername.statusCode).toBe(201);
    expect((byUsername.json() as { subjectId: string }).subjectId).toBe(USER_TWO);

    // ...and the grant really reaches that account.
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const visible = await withDirectory.inject({
      method: "GET",
      url: "/api/library/sessions"
    });
    expect(
      (
        visible.json() as { sessions: Array<{ sessionId: string }> }
      ).sessions.some((row) => row.sessionId === origin)
    ).toBe(true);

    // A subject naming nothing real is refused rather than filed: a grant
    // under a subject that can never match would look like sharing while
    // sharing nothing, and the operator would never see the difference.
    asUser(USER_ONE, "owner", "Owner One");
    const unknownUser = await grant("user", "nobody-here");
    expect(unknownUser.statusCode).toBe(400);
    expect((unknownUser.json() as { code: string }).code).toBe(
      "subject_not_found"
    );
    const unknownRole = await grant("role", "admin");
    expect(unknownRole.statusCode).toBe(400);
    expect((unknownRole.json() as { code: string }).code).toBe(
      "subject_not_found"
    );

    // The refusal must not become a way to ask whether an account exists:
    // someone who may not share this research gets the same authorization
    // answer whatever they type.
    asUser(USER_TWO, "reviewer", "Reviewer Two");
    const unauthorized = await grant("user", "nobody-here");
    expect(unauthorized.statusCode).toBe(403);
    expect((unauthorized.json() as { code: string }).code).toBe(
      "grant_not_permitted"
    );

    // A real role is accepted, and only the two valid grants were stored.
    asUser(USER_ONE, "owner", "Owner One");
    const roleGrant = await grant("role", "viewer");
    expect(roleGrant.statusCode).toBe(201);
    const listed = await withDirectory.inject({
      method: "GET",
      url: `/api/library/grants?sessionId=${origin}`
    });
    expect(
      (listed.json() as { grants: Array<{ subjectId: string }> }).grants
        .map((row) => row.subjectId)
        .sort()
    ).toEqual([USER_TWO, "viewer"].sort());
  });

  it("reports drift after the origin moves, and a fork after the target changes", async () => {
    const origin = await createResearch("来源研究");
    const target = await createResearch("目标研究");
    const imported = await importPage(origin, {
      url: "https://example.org/q4",
      content: "初版正文",
      title: "季度回顾"
    });

    const copied = await copyInto(target, origin, imported.sourceId);
    expect(copied.statusCode).toBe(201);
    const copiedSourceId = (copied.json() as { sourceId: string }).sourceId;

    const readStatus = async () => (await lineageOf(target)).lineage[copiedSourceId];

    expect((await readStatus())?.originStatus).toBe("current");

    // The origin gets a new capture: the copy is now behind, and says so. The
    // hash it was copied from is kept, so the drift is attributable.
    await importPage(origin, {
      url: "https://example.org/q4",
      content: "修订后的正文",
      title: "季度回顾"
    });
    expect((await readStatus())?.originStatus).toBe("changed");
    expect((await readStatus())?.originSnapshotHash).toBe(imported.contentHash);

    // The target captures different text of its own: the copy has forked, and
    // the moment is recorded.
    await importPage(target, {
      url: "https://example.org/q4",
      content: "本地版本",
      title: "季度回顾"
    });
    const forked = await readStatus();
    expect(forked?.forkState).toBe("forked");

    // A source with no capture can only be referenced, never copied.
    const uncaptured = await registerManualSource(origin, {
      title: "尚未抓取的通告",
      url: "https://example.org/notice"
    });
    const refused = await copyInto(target, origin, uncaptured);
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { code: string }).code).toBe("source_has_no_capture");
    const reference = await copyInto(target, origin, uncaptured, "reference");
    expect(reference.statusCode).toBe(201);
    const referenceBody = reference.json() as {
      sourceId: string;
      copy: { originSnapshotHash?: string; originStatus: string };
    };
    // A reference copy honestly carries no version to point at.
    expect(referenceBody.copy.originSnapshotHash).toBeUndefined();
    expect(referenceBody.copy.originStatus).toBe("current");
    // And it read nothing, so it does not claim the material was fetched.
    const referenceSources = await app.inject({
      method: "GET",
      url: `/api/sessions/${target}/sources`
    });
    const referenceRow = (
      referenceSources.json() as {
        sources: Array<{ id: string; retrievalStatus?: string }>;
      }
    ).sources.find((row) => row.id === referenceBody.sourceId);
    expect(referenceRow?.retrievalStatus).toBe("not_requested");
  });

  it("filters by the language the system actually recorded, and guesses nothing", async () => {
    const mine = await createResearch("语言筛选研究");
    const chinese = await importPage(mine, {
      url: "https://example.org/zh",
      content: "出货量同比增长。",
      title: "中文报告"
    });
    const english = await importPage(mine, {
      url: "https://example.org/en",
      content: "Shipments grew year over year.",
      title: "English report"
    });

    const byLanguage = async (language: string) => {
      const response = await app.inject({
        method: "GET",
        url: `/api/library/sources?language=${language}`
      });
      expect(response.statusCode).toBe(200);
      return response.json() as { sources: Array<{ sourceId: string }>; total: number };
    };

    // Nothing registered a language for either capture, and detection is
    // deliberately never persisted — so the filter answers "nothing recorded"
    // rather than guessing from the text. This is the honesty the filter owes:
    // it reports what the system knows, not what it could infer.
    expect((await byLanguage("zh")).total).toBe(0);
    expect((await byLanguage("en")).total).toBe(0);

    // A language registered for a capture is what the filter reads.
    await database.execute(
      `UPDATE source_snapshots SET source_language = 'zh' WHERE id = '${chinese.snapshotId}'`
    );
    const chineseMatches = await byLanguage("zh");
    expect(chineseMatches.total).toBe(1);
    expect(chineseMatches.sources[0]?.sourceId).toBe(chinese.sourceId);
    // The other source is not swept in by the same query.
    expect((await byLanguage("en")).total).toBe(0);

    // A stored translation is a recorded language too: the research knows the
    // material's language because it translated it.
    await database.execute(
      `INSERT INTO translations (id, session_id, source_snapshot_id, source_language,
         target_language, text_hash, translated_text, segment_mappings, provider, model,
         status, created_by)
       VALUES ('${newId()}', '${mine}', '${english.snapshotId}', 'en', 'zh-Hans', 'hash-en',
         '出货量同比增长。', '[]'::jsonb, 'test-provider', 'test-model', 'completed', 'Owner One')`
    );
    const englishMatches = await byLanguage("en");
    expect(englishMatches.total).toBe(1);
    expect(englishMatches.sources[0]?.sourceId).toBe(english.sourceId);
    expect((await byLanguage("zh")).total).toBe(1);
    expect((await byLanguage("ja")).total).toBe(0);
  });

  it("refuses a duplicate in the target and points at what is already there", async () => {
    const origin = await createResearch("来源研究");
    const target = await createResearch("目标研究");
    const imported = await importPage(origin, {
      url: "https://example.org/q4",
      content: "季度回顾正文",
      title: "季度回顾"
    });
    const already = await importPage(target, {
      url: "https://example.org/q4",
      content: "Q4 年报正文",
      title: "Q4 年报"
    });

    const duplicate = await copyInto(target, origin, imported.sourceId);
    expect(duplicate.statusCode).toBe(409);
    const body = duplicate.json() as {
      code: string;
      duplicate: { sourceId: string; title: string; reason: string };
    };
    expect(body.code).toBe("duplicate_source");
    // The caller is pointed at the row that already exists rather than told
    // "duplicate" with no way forward.
    expect(body.duplicate.sourceId).toBe(already.sourceId);
    expect(body.duplicate.title).toBe("Q4 年报");
    expect(body.duplicate.reason).toBe("canonical_url");

    // Nothing was written by the refused attempt.
    expect(await sourceLibrary.listCopiesForSession(target)).toHaveLength(0);
    const targetSources = await app.inject({
      method: "GET",
      url: `/api/sessions/${target}/sources`
    });
    expect((targetSources.json() as { sources: unknown[] }).sources).toHaveLength(1);
  });

  it("refuses an anonymous caller outright", async () => {
    const origin = await createResearch("来源研究");
    const imported = await importPage(origin, {
      url: "https://example.org/q4",
      content: "正文",
      title: "季度回顾"
    });

    anonymous();
    for (const request of [
      { method: "GET" as const, url: "/api/library/sessions" },
      { method: "GET" as const, url: "/api/library/sources" },
      { method: "GET" as const, url: `/api/library/sources/${imported.sourceId}` },
      { method: "GET" as const, url: `/api/sessions/${origin}/library/lineage` }
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
    }
    const write = await app.inject({
      method: "POST",
      url: `/api/sessions/${origin}/library/copies`,
      headers: { "idempotency-key": `copy-${randomUUID()}` },
      payload: { sourceSessionId: origin, sourceId: imported.sourceId, mode: "copy" }
    });
    expect(write.statusCode).toBe(401);
    const grant = await app.inject({
      method: "POST",
      url: "/api/library/grants",
      headers: { "idempotency-key": `grant-${randomUUID()}` },
      payload: {
        sessionId: origin,
        subjectType: "user",
        subjectId: USER_TWO,
        scope: "read"
      }
    });
    expect(grant.statusCode).toBe(401);
    const revoke = await app.inject({
      method: "POST",
      url: `/api/library/grants/${newId()}/revoke`,
      headers: { "idempotency-key": `revoke-${randomUUID()}` }
    });
    expect(revoke.statusCode).toBe(401);
  });

  it("requires an idempotency key on writes and validates the search filters", async () => {
    const origin = await createResearch("来源研究");
    const imported = await importPage(origin, {
      url: "https://example.org/q4",
      content: "正文",
      title: "季度回顾"
    });

    const noKey = await app.inject({
      method: "POST",
      url: `/api/sessions/${origin}/library/copies`,
      payload: { sourceSessionId: origin, sourceId: imported.sourceId, mode: "copy" }
    });
    expect(noKey.statusCode).toBe(400);

    const badMode = await app.inject({
      method: "POST",
      url: `/api/sessions/${origin}/library/copies`,
      headers: { "idempotency-key": `copy-${randomUUID()}` },
      payload: { sourceSessionId: origin, sourceId: imported.sourceId, mode: "steal" }
    });
    expect(badMode.statusCode).toBe(400);

    const badId = await app.inject({
      method: "POST",
      url: `/api/sessions/${origin}/library/copies`,
      headers: { "idempotency-key": `copy-${randomUUID()}` },
      payload: { sourceSessionId: origin, sourceId: "not-a-uuid", mode: "copy" }
    });
    expect(badId.statusCode).toBe(400);

    const badFilter = await app.inject({
      method: "GET",
      url: "/api/library/sources?sessionId=not-a-uuid"
    });
    expect(badFilter.statusCode).toBe(400);

    const badLimit = await app.inject({
      method: "GET",
      url: "/api/library/sources?limit=5000"
    });
    expect(badLimit.statusCode).toBe(400);

    // A limit is clamped by the schema and paging is honest about the total.
    const paged = await app.inject({
      method: "GET",
      url: "/api/library/sources?limit=1&offset=0"
    });
    expect(paged.statusCode).toBe(200);
    expect((paged.json() as { total: number }).total).toBe(1);

    const missingSession = await app.inject({
      method: "GET",
      url: "/api/library/grants"
    });
    expect(missingSession.statusCode).toBe(400);
  });

  it("keeps the target's provenance when the origin's material is removed", async () => {
    const origin = await createResearch("将被移除的研究");
    const target = await createResearch("目标研究");
    const imported = await importPage(origin, {
      url: "https://example.org/q4",
      content: "正文",
      title: "季度回顾"
    });
    const copied = await copyInto(target, origin, imported.sourceId);
    expect(copied.statusCode).toBe(201);
    const copiedSourceId = (copied.json() as { sourceId: string }).sourceId;

    // The origin's material is removed. A whole-research DELETE cannot be used
    // as the set-up here: `sources.session_id` and its siblings carry no
    // cascade, so removing a research that holds any material is refused by
    // the database today — a pre-existing limitation of earlier migrations,
    // unrelated to this feature, and reported rather than worked around. What
    // this feature owns is that losing the origin must not lose the *target's*
    // provenance, which is what is exercised here.
    await database.execute(
      `DELETE FROM source_snapshots WHERE session_id = '${origin}'`
    );
    await database.execute(`DELETE FROM sources WHERE session_id = '${origin}'`);
    expect(await sourceLibrary.getSourceById(imported.sourceId)).toBeNull();

    const record = (await lineageOf(target)).lineage[copiedSourceId];
    expect(record?.originSessionId).toBe(origin);
    expect(record?.originSourceId).toBe(imported.sourceId);
    expect(record?.originSnapshotHash).toBe(imported.contentHash);
    // The live link is dead, and the copy says so instead of pretending it can
    // still be checked against an origin that is gone. `unavailable` is
    // narrower than `revoked`: the share was not withdrawn, the material is
    // simply no longer there.
    expect(record?.originStatus).toBe("unavailable");
    // The copy itself — the material the target is citing — is untouched.
    expect(await sourceLibrary.getSourceById(copiedSourceId)).not.toBeNull();
    expect(await sourceLibrary.listVersions(copiedSourceId)).toHaveLength(1);
    const copyDetail = await app.inject({
      method: "GET",
      url: `/api/sessions/${target}/sources`
    });
    expect(
      (copyDetail.json() as { sources: Array<{ id: string }> }).sources.map(
        (row) => row.id
      )
    ).toEqual([copiedSourceId]);
  });
});
