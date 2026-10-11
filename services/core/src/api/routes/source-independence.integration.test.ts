import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  ReviewRepository,
  SourceIndependenceRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";
import { SourceIndependenceService } from "../../research/source-independence-service";

/**
 * Behaviour of the source-independence routes against a real database.
 *
 * What these tests pin down: that "same page" and "same content" are merged
 * because the server can prove them, that mere similarity is only ever a
 * suspicion, that a person's ruling replaces the detected one without erasing
 * it, that session scoping and roles hold, and that nothing here counts a
 * reprint as independent corroboration.
 *
 * No model and no network are involved: this analysis is deterministic.
 *
 * The database is the dedicated test database named by TEST_DATABASE_URL; the
 * guard refuses to connect anywhere else.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const independenceRepository = new SourceIndependenceRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);

const PROJECT_ID = newId();
const SESSION_ID = newId();
const OTHER_SESSION_ID = newId();

const ARTICLE_TEXT =
  "The bureau reported that retail sales rose five percent in the first half. " +
  "Analysts had expected a smaller increase and said the figure was encouraging.";

let role: "owner" | "reviewer" | "viewer" = "reviewer";

const independenceService = new SourceIndependenceService({
  sources: evidenceRepository,
  assertions: independenceRepository
});

function fakeAuth(enabled = true) {
  return {
    userFromRequest: () =>
      enabled
        ? {
            id: "user-1",
            username: "researcher",
            displayName: "Researcher One",
            role
          }
        : null
  };
}

function testApp(enabled = true) {
  return createApp({
    auth: fakeAuth(enabled) as never,
    sessions,
    inspector: {} as never,
    events,
    runSession: { start: async () => undefined },
    evidence: evidenceRepository,
    reviews: reviewRepository,
    arena,
    sourceIndependence: independenceService
  });
}

beforeEach(async () => {
  role = "reviewer";
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Source independence integration",
    input: {}
  });
  for (const sessionId of [SESSION_ID, OTHER_SESSION_ID]) {
    await database.execute(
      `INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence, research_question)
       VALUES ('${sessionId}', '${PROJECT_ID}', 'zh-CN', 'ANALYZING', 'ACTIVE', 1, 'Did retail sales rise?')`
    );
  }
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

/** Registers a source with a stored capture. */
async function seedSource(input: {
  sessionId: string;
  title: string;
  canonicalUrl: string;
  content: string;
  contentHash: string;
  publisher?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  skipSnapshot?: boolean;
}): Promise<{ sourceId: string; snapshotId: string | null }> {
  const sourceId = newId();
  const snapshotId = input.skipSnapshot ? null : newId();
  await database.execute(
    `INSERT INTO sources (id, session_id, title, kind, url, canonical_url, publisher, author, published_at, retrieval_status, retrieved_at, content_hash, created_by)
     VALUES ('${sourceId}', '${input.sessionId}', '${input.title}', 'url',
             '${input.canonicalUrl}', '${input.canonicalUrl}',
             ${input.publisher ? `'${input.publisher}'` : "NULL"},
             ${input.author ? `'${input.author}'` : "NULL"},
             ${input.publishedAt ? `'${input.publishedAt}'` : "NULL"},
             '${input.skipSnapshot ? "failed" : "fetched"}', now(), '${input.contentHash}', 'human')`
  );
  if (snapshotId) {
    await database.execute(
      `INSERT INTO source_snapshots (id, session_id, source_id, canonical_url, content_hash, content_type, content, content_bytes, char_count, retrieved_at)
       VALUES ('${snapshotId}', '${input.sessionId}', '${sourceId}', '${input.canonicalUrl}',
               '${input.contentHash}', 'text/plain', '${input.content}', ${input.content.length}, ${input.content.length}, now())`
    );
  }
  return { sourceId, snapshotId };
}

async function analysis(sessionId: string) {
  const response = await testApp().inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/sources/analysis`
  });
  return { status: response.statusCode, body: response.json() };
}

describe("GET /sources/analysis", () => {
  it("reads two rows naming the same url as one independent source", async () => {
    await seedSource({
      sessionId: SESSION_ID,
      title: "Page A",
      canonicalUrl: "https://origin.test/story",
      content: ARTICLE_TEXT,
      contentHash: "hash-a"
    });
    // Same page registered under a different title: the unique index on the
    // canonical url is what normally prevents this, so simulate the case the
    // analysis must still cope with — a page whose text is identical.
    await seedSource({
      sessionId: SESSION_ID,
      title: "Page B",
      canonicalUrl: "https://mirror.test/copy",
      content: ARTICLE_TEXT,
      contentHash: "hash-a"
    });

    const response = await analysis(SESSION_ID);
    expect(response.status).toBe(200);
    expect(response.body.summary.pages).toBe(2);
    expect(response.body.summary.confirmedIndependentSources).toBe(1);
    expect(response.body.summary.confirmedLinks[0]?.kind).toBe("duplicate");
  });

  it("keeps similar-but-different text out of the confirmed count", async () => {
    await seedSource({
      sessionId: SESSION_ID,
      title: "Original",
      canonicalUrl: "https://origin.test/a",
      content: ARTICLE_TEXT,
      contentHash: "h1"
    });
    await seedSource({
      sessionId: SESSION_ID,
      title: "Follow-up",
      canonicalUrl: "https://followup.test/b",
      content: `${ARTICLE_TEXT} 记者随后补充了地方数据。`,
      contentHash: "h2"
    });

    const response = await analysis(SESSION_ID);
    expect(response.body.summary.confirmedIndependentSources).toBe(2);
    expect(response.body.summary.suspectedIndependentSources).toBe(1);
    expect(response.body.summary.suspectedLinks[0]?.confidence).toBe("suspected");
  });

  it("calls a page that links to another source second-hand", async () => {
    const original = await seedSource({
      sessionId: SESSION_ID,
      title: "Original report",
      canonicalUrl: "https://origin.test/a",
      content: ARTICLE_TEXT,
      contentHash: "o1",
      publisher: "National Bureau",
      publishedAt: "2026-09-01T00:00:00.000Z"
    });
    const mirror = await seedSource({
      sessionId: SESSION_ID,
      title: "Mirror",
      canonicalUrl: "https://mirror.test/copy",
      content: `转载自 https://origin.test/a 。${ARTICLE_TEXT}`,
      contentHash: "m1"
    });

    const response = await analysis(SESSION_ID);
    const mirrorProfile = response.body.profiles.find(
      (profile: { sourceId: string }) => profile.sourceId === mirror.sourceId
    );
    expect(mirrorProfile.referencesSourceIds).toContain(original.sourceId);
    expect(mirrorProfile.provenanceKind).toBe("secondary");

    const originalProfile = response.body.profiles.find(
      (profile: { sourceId: string }) => profile.sourceId === original.sourceId
    );
    expect(originalProfile.referencedBySourceIds).toContain(mirror.sourceId);
  });

  it("reports an unknown provenance kind instead of inventing one", async () => {
    await seedSource({
      sessionId: SESSION_ID,
      title: "Lonely page",
      canonicalUrl: "https://lonely.test/x",
      content: ARTICLE_TEXT,
      contentHash: "x1"
    });

    const response = await analysis(SESSION_ID);
    expect(response.body.profiles[0]?.provenanceKind).toBe("unknown");
    expect(response.body.profiles[0]?.limitations.length).toBeGreaterThan(0);
  });

  it("says a source with no capture cannot be compared", async () => {
    await seedSource({
      sessionId: SESSION_ID,
      title: "Unreadable",
      canonicalUrl: "https://broken.test/x",
      content: ARTICLE_TEXT,
      contentHash: "b1",
      skipSnapshot: true
    });

    const response = await analysis(SESSION_ID);
    const profile = response.body.profiles[0];
    expect(profile.facts.charCount).toBeNull();
    expect(profile.limitations.join()).toContain("没有可检索的正文快照");
  });

  it("returns an empty reading rather than an error for a fresh session", async () => {
    const response = await analysis(OTHER_SESSION_ID);
    expect(response.status).toBe(200);
    expect(response.body.summary.pages).toBe(0);
  });

  it("requires authentication when auth is enabled", async () => {
    const response = await createApp({
      auth: fakeAuth(false) as never,
      sessions,
      inspector: {} as never,
      events,
      runSession: { start: async () => undefined },
      evidence: evidenceRepository,
      reviews: reviewRepository,
      arena,
      sourceIndependence: independenceService
    }).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/analysis`
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /source-relations", () => {
  async function twoSources() {
    const first = await seedSource({
      sessionId: SESSION_ID,
      title: "First",
      canonicalUrl: "https://first.test/a",
      content: ARTICLE_TEXT,
      contentHash: "f1"
    });
    const second = await seedSource({
      sessionId: SESSION_ID,
      title: "Second",
      canonicalUrl: "https://second.test/b",
      content: `${ARTICLE_TEXT} 补充报道。`,
      contentHash: "s1"
    });
    return { first, second };
  }

  it("records a person's ruling and reads it back as the merged link", async () => {
    const { first, second } = await twoSources();
    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/source-relations`,
      headers: { "idempotency-key": newId() },
      payload: {
        fromSourceId: second.sourceId,
        toSourceId: first.sourceId,
        kind: "reprint",
        reason: "编辑核对后确认第二篇是第一篇的转载。"
      }
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().relation.kind).toBe("reprint");

    const after = await analysis(SESSION_ID);
    expect(after.body.summary.confirmedIndependentSources).toBe(1);
    expect(
      after.body.links.some(
        (link: { origin: string; kind: string }) =>
          link.origin === "human" && link.kind === "reprint"
      )
    ).toBe(true);
  });

  it("answers a repeated click with the earlier result", async () => {
    const { first, second } = await twoSources();
    const app = testApp();
    const key = newId();
    const request = {
      method: "POST" as const,
      url: `/api/sessions/${SESSION_ID}/source-relations`,
      headers: { "idempotency-key": key },
      payload: {
        fromSourceId: first.sourceId,
        toSourceId: second.sourceId,
        kind: "quotes",
        reason: "第一篇正文引用了第二篇的数据。"
      }
    };
    const first1 = await app.inject(request);
    const second2 = await app.inject(request);
    expect(first1.statusCode).toBe(201);
    expect(second2.statusCode).toBe(201);
    expect(second2.json().relation.id).toBe(first1.json().relation.id);
  });

  it("requires an idempotency key", async () => {
    const { first, second } = await twoSources();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/source-relations`,
      payload: {
        fromSourceId: first.sourceId,
        toSourceId: second.sourceId,
        kind: "reprint",
        reason: "这是一段足够长的理由说明。"
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a viewer", async () => {
    const { first, second } = await twoSources();
    role = "viewer";
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/source-relations`,
      headers: { "idempotency-key": newId() },
      payload: {
        fromSourceId: first.sourceId,
        toSourceId: second.sourceId,
        kind: "reprint",
        reason: "这是一段足够长的理由说明。"
      }
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a source from another research task with 404", async () => {
    const { first } = await twoSources();
    const foreign = await seedSource({
      sessionId: OTHER_SESSION_ID,
      title: "Foreign",
      canonicalUrl: "https://foreign.test/x",
      content: ARTICLE_TEXT,
      contentHash: "z1"
    });
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/source-relations`,
      headers: { "idempotency-key": newId() },
      payload: {
        fromSourceId: first.sourceId,
        toSourceId: foreign.sourceId,
        kind: "reprint",
        reason: "跨越了两个研究任务的来源关系。"
      }
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a relation kind outside the vocabulary", async () => {
    const { first, second } = await twoSources();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/source-relations`,
      headers: { "idempotency-key": newId() },
      payload: {
        fromSourceId: first.sourceId,
        toSourceId: second.sourceId,
        kind: "plagiarised",
        reason: "这不是一个合法的关系类型。"
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a reason that is too short", async () => {
    const { first, second } = await twoSources();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/source-relations`,
      headers: { "idempotency-key": newId() },
      payload: {
        fromSourceId: first.sourceId,
        toSourceId: second.sourceId,
        kind: "reprint",
        reason: "短"
      }
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /source-profile-overrides", () => {
  it("records an override and shows it in the next analysis", async () => {
    const source = await seedSource({
      sessionId: SESSION_ID,
      title: "Bureau release",
      canonicalUrl: "https://bureau.test/a",
      content: ARTICLE_TEXT,
      contentHash: "p1"
    });
    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/source-profile-overrides`,
      headers: { "idempotency-key": newId() },
      payload: {
        sourceId: source.sourceId,
        provenanceKind: "primary",
        note: "确认这是统计局原始发布页面。"
      }
    });
    expect(response.statusCode).toBe(201);

    const after = await analysis(SESSION_ID);
    const profile = after.body.profiles.find(
      (item: { sourceId: string }) => item.sourceId === source.sourceId
    );
    expect(profile.provenanceKind).toBe("primary");
    expect(profile.provenanceOrigin).toBe("human");
  });

  it("keeps an earlier override readable in the history", async () => {
    const source = await seedSource({
      sessionId: SESSION_ID,
      title: "Bureau release",
      canonicalUrl: "https://bureau.test/a",
      content: ARTICLE_TEXT,
      contentHash: "p1"
    });
    const app = testApp();
    const post = (kind: string, note: string) =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${SESSION_ID}/source-profile-overrides`,
        headers: { "idempotency-key": newId() },
        payload: { sourceId: source.sourceId, provenanceKind: kind, note }
      });
    await post("primary", "确认这是统计局原始发布页面。");
    await post("secondary", "重新核对后确认是转载页面。");

    const history = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/source-profile-overrides/history?sourceId=${source.sourceId}`
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toHaveLength(2);
  });
});
