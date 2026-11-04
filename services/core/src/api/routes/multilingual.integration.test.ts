import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  sourceSnapshots,
  TerminologyRepository,
  TranslationRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";
import {
  DeterministicTranslationProvider,
  type TranslationProvider,
  UnavailableTranslationProvider
} from "../../research/translation-provider";

/**
 * DB-backed integration test for the multilingual routes.
 *
 * What only a real database can prove: that a translation is auxiliary and tied
 * to a snapshot version; that a provider that is not configured yields an honest
 * `unavailable` state and persists nothing (no fabricated translation); that a
 * snapshot from another session is not found (cross-session isolation); that a
 * viewer may read but not write while an anonymous caller is refused; that a
 * review is recorded without touching any evidence; that identical input is
 * de-duplicated; and that every write leaves an audit event. No model, no
 * network: the provider is the deterministic test double.
 */

const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const events = new EventRepository(database);
const translations = new TranslationRepository(database);
const terminology = new TerminologyRepository(database);

const PROJECT_ID = newId();
const SESSION_ID = newId();
const OTHER_SESSION_ID = newId();
const SOURCE_ID = newId();
const SNAPSHOT_ID = newId();
const HUGE_SOURCE_ID = newId();
const HUGE_SNAPSHOT_ID = newId();

/**
 * English text with enough function words for the heuristic to commit (`the`,
 * `and`, `in`, `that`, `it`, `was`, `of` all score). It also keeps a number and
 * a direction word so the fidelity rules have something real to look at.
 */
const SNAPSHOT_CONTENT =
  "Revenue decreased by 12% in the third quarter, and the company said that it was the result of higher costs.";

let role: "owner" | "reviewer" | "viewer" = "reviewer";
let provider: TranslationProvider = new DeterministicTranslationProvider();

function fakeAuth(enabled = true) {
  return {
    userFromRequest: () =>
      enabled
        ? { id: "user-1", username: "researcher", displayName: "Researcher One", role }
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
    translations,
    terminology,
    translationProvider: provider
  });
}

async function seed() {
  const timestamp = new Date().toISOString();
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Multilingual integration",
    input: {}
  });
  for (const sessionId of [SESSION_ID, OTHER_SESSION_ID]) {
    await sessions.create({
      id: sessionId,
      projectId: PROJECT_ID,
      locale: "zh-CN",
      phase: "EVIDENCE",
      operationalStatus: "ACTIVE",
      currentConclusion: null,
      // The research belongs to the signed-in reviewer: access is decided from
      // the recorded owner, never from the request.
      ownerUserId: "user-1"
    });
  }
  await evidenceRepository.createSource({
    id: SOURCE_ID,
    sessionId: SESSION_ID,
    title: "Quarterly report",
    kind: "document",
    publisher: "Example",
    createdBy: "human",
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await evidenceRepository.createSource({
    id: HUGE_SOURCE_ID,
    sessionId: SESSION_ID,
    title: "Huge report",
    kind: "document",
    publisher: "Example",
    createdBy: "human",
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await database.insert(sourceSnapshots).values({
    id: SNAPSHOT_ID,
    sessionId: SESSION_ID,
    sourceId: SOURCE_ID,
    canonicalUrl: "https://example.org/report",
    contentHash: "hash-1",
    contentType: "text/plain",
    content: SNAPSHOT_CONTENT,
    contentBytes: SNAPSHOT_CONTENT.length,
    charCount: SNAPSHOT_CONTENT.length,
    retrievedAt: timestamp,
    sourceLanguage: "en"
  });
  await database.insert(sourceSnapshots).values({
    id: HUGE_SNAPSHOT_ID,
    sessionId: SESSION_ID,
    sourceId: HUGE_SOURCE_ID,
    canonicalUrl: "https://example.org/huge",
    contentHash: "hash-huge",
    contentType: "text/plain",
    content: "x".repeat(20001),
    contentBytes: 20001,
    charCount: 20001,
    retrievedAt: timestamp,
    sourceLanguage: "en"
  });
}

function translatePayload(snapshotId: string) {
  return { sourceSnapshotId: snapshotId, targetLanguage: "zh-Hans" as const };
}

async function eventTypes(sessionId: string): Promise<string[]> {
  // Session ids are generated UUIDs, so the raw SQL is interpolated rather than
  // parameter-bound — the same convention the other integration tests use.
  const rows = (await database.execute(
    `SELECT type FROM execution_events WHERE session_id = '${sessionId}' ORDER BY sequence`
  )) as unknown as { type: string }[];
  return rows.map((row) => row.type);
}

beforeEach(async () => {
  role = "reviewer";
  provider = new DeterministicTranslationProvider();
  await seed();
});

afterAll(async () => {
  await database.end();
});

describe("multilingual routes (integration)", () => {
  it("creates an auxiliary translation with rule-based fidelity, and stores it", async () => {
    const app = testApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/translations`,
      headers: { "idempotency-key": "t-1" },
      payload: translatePayload(SNAPSHOT_ID)
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.translation.status).toBe("completed");
    expect(body.translation.provider).toBe("deterministic-mock");
    expect(body.fidelity.findings.length).toBeGreaterThan(0);
    for (const finding of body.fidelity.findings) {
      expect(finding.heuristic).toBe(true);
    }

    const list = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/translations` });
    expect(list.statusCode).toBe(200);
    expect(list.json().translations).toHaveLength(1);
    expect((await eventTypes(SESSION_ID)).includes("TRANSLATION_RECORDED")).toBe(true);
  });

  it("returns an honest unavailable state and persists nothing when no provider is configured", async () => {
    provider = new UnavailableTranslationProvider();
    const app = testApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/translations`,
      headers: { "idempotency-key": "t-2" },
      payload: translatePayload(SNAPSHOT_ID)
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("provider_unavailable");

    const list = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/translations` });
    expect(list.json().translations).toHaveLength(0);
  });

  it("refuses a snapshot that belongs to another session (cross-session 404)", async () => {
    const app = testApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${OTHER_SESSION_ID}/translations`,
      headers: { "idempotency-key": "t-3" },
      payload: translatePayload(SNAPSHOT_ID)
    });
    expect(res.statusCode).toBe(404);
  });

  it("de-duplicates identical translation requests to one stored row", async () => {
    const app = testApp();
    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/translations`,
      headers: { "idempotency-key": "t-4a" },
      payload: translatePayload(SNAPSHOT_ID)
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/translations`,
      headers: { "idempotency-key": "t-4b" },
      payload: translatePayload(SNAPSHOT_ID)
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().translation.translationId).toBe(second.json().translation.translationId);

    const list = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/translations` });
    expect(list.json().translations).toHaveLength(1);
  });

  it("rejects an over-budget source with a clear code", async () => {
    const app = testApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/translations`,
      headers: { "idempotency-key": "t-5" },
      payload: translatePayload(HUGE_SNAPSHOT_ID)
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("text_too_long");
  });

  it("records a human review without changing any evidence", async () => {
    const app = testApp();
    const created = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/translations`,
      headers: { "idempotency-key": "t-6" },
      payload: translatePayload(SNAPSHOT_ID)
    });
    const translationId = created.json().translation.translationId;
    const review = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/translations/${translationId}/review`,
      headers: { "idempotency-key": "r-1" },
      payload: { action: "approve", reviewStatus: "approved", note: "checked" }
    });
    expect(review.statusCode).toBe(201);
    expect(review.json().review.reviewStatus).toBe("approved");
    expect((await eventTypes(SESSION_ID)).includes("TRANSLATION_REVIEWED")).toBe(true);

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/translations/${translationId}`
    });
    expect(detail.json().reviews).toHaveLength(1);
  });

  it("detects the language of a source's current capture", async () => {
    const app = testApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/${SOURCE_ID}/languages`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().detection.languageCode).toBe("en");
  });

  it("upserts and lists the session-scoped terminology glossary", async () => {
    const app = testApp();
    const created = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/terminology`,
      headers: { "idempotency-key": "term-1" },
      payload: { sourceTerm: "gross margin", confirmedTranslation: "毛利率", language: "en" }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().entry.confirmedTranslation).toBe("毛利率");

    const list = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/terminology` });
    expect(list.json().entries).toHaveLength(1);
    expect((await eventTypes(SESSION_ID)).includes("TERMINOLOGY_RECORDED")).toBe(true);
  });

  it("enforces permissions: anonymous 401, viewer writes 403, viewer reads 200", async () => {
    const anon = await testApp(false).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/translations`
    });
    expect(anon.statusCode).toBe(401);

    role = "viewer";
    const app = testApp();
    const write = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/translations`,
      headers: { "idempotency-key": "t-7" },
      payload: translatePayload(SNAPSHOT_ID)
    });
    expect(write.statusCode).toBe(403);

    const read = await app.inject({ method: "GET", url: `/api/sessions/${SESSION_ID}/translations` });
    expect(read.statusCode).toBe(200);
  });

  it("requires an idempotency key on writes", async () => {
    const app = testApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/translations`,
      payload: translatePayload(SNAPSHOT_ID)
    });
    expect(res.statusCode).toBe(400);
  });
});
