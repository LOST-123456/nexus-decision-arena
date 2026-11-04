import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EvidenceRepository,
  EventRepository,
  projects,
  ReviewRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";
import type { FetchedPage } from "../../research/page-fetch";
import { SourceImportService } from "../../research/source-import-service";
import { TargetRefusedError } from "../../research/ssrf-guard";

/**
 * End-to-end behaviour of the intake routes, against a real database.
 *
 * The page fetcher is injected, because what is being tested here is not the
 * network: it is that a retrieval result becomes the right rows, that a refusal
 * is persisted with its reason, that permissions and session scoping hold, and
 * that confirming a candidate excerpt never turns into a claim of verification.
 *
 * No test here opens a network socket. The address policy itself is proved in
 * `ssrf-guard.test.ts`.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);

const PROJECT_ID = newId();
const SESSION_ID = newId();
const OTHER_SESSION_ID = newId();

let role: "owner" | "reviewer" | "viewer" = "reviewer";
let retrieve: (url: string) => Promise<FetchedPage> = async () => {
  throw new Error("fetcher not configured for this test");
};

const importService = new SourceImportService({
  evidence: evidenceRepository,
  fetch: (url) => retrieve(url)
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
    sourceIntake: importService
  });
}

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    requestedUrl: "https://example.test/report",
    finalUrl: "https://example.test/report",
    canonicalUrl: "https://example.test/report",
    status: 200,
    contentType: "text/html",
    contentEncoding: null,
    content: "Shipments grew 12% year over year according to the report.",
    contentHash: "hash-v1",
    wireBytes: 1024,
    contentBytes: 1024,
    charCount: 58,
    title: "Population report 2025",
    author: "Statistics Office",
    publisher: "National Bureau of Statistics",
    publishedAt: "2025-03-04T08:00:00.000Z",
    retrievedAt: "2026-10-10T00:00:00.000Z",
    redirects: [],
    truncated: false,
    ...overrides
  };
}

async function seed() {
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Intake integration",
    input: {}
  });
  for (const sessionId of [SESSION_ID, OTHER_SESSION_ID]) {
    await database.execute(
      `INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence, research_question, owner_user_id)
       VALUES ('${sessionId}', '${PROJECT_ID}', 'zh-CN', 'ANALYZING', 'ACTIVE', 1, 'Did shipments grow?', 'user-1')`
    );
  }
}

async function seedClaim(sessionId: string): Promise<string> {
  const claimId = newId();
  const now = new Date().toISOString();
  await database.execute(
    `INSERT INTO claims (id, session_id, lens, statement, type, stance, importance, confidence, evidence_ids, status, root_claim_id, revision, relations, created_at, updated_at)
     VALUES ('${claimId}', '${sessionId}', 'research', 'Shipments grew.', 'fact', 'support', 3, 0.5, '[]'::jsonb, 'proposed', '${claimId}', 1, '[]'::jsonb, '${now}', '${now}')`
  );
  return claimId;
}

const importUrl = (app: ReturnType<typeof testApp>, url: string, key = newId()) =>
  app.inject({
    method: "POST",
    url: `/api/sessions/${SESSION_ID}/sources/import`,
    headers: { "idempotency-key": key },
    payload: { url }
  });

beforeEach(async () => {
  role = "reviewer";
  await seed();
});

afterAll(async () => {
  await database.end();
});

describe("importing a page", () => {
  it("stores the capture and exposes it through the detail route", async () => {
    retrieve = async () => page();
    const app = testApp();

    const response = await importUrl(app, "https://example.test/report");
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.reused).toBe(false);
    expect(body.versionCreated).toBe(true);
    expect(body.source.retrievalStatus).toBe("fetched");
    expect(body.source.contentHash).toBe("hash-v1");
    expect(body.source.title).toBe("Population report 2025");
    expect(body.snapshot.contentHash).toBe("hash-v1");
    expect(body.snapshot.content).toContain("Shipments grew 12%");

    // Persisted, not just returned: a fresh read of the detail route agrees.
    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/${body.source.id}`
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.source.retrievalStatus).toBe("fetched");
    expect(detailBody.snapshots).toHaveLength(1);
    expect(detailBody.currentSnapshotId).toBe(body.snapshot.id);
    expect(detailBody.excerpts).toEqual([]);
  });

  it("reuses the existing source for a re-import of the same page", async () => {
    retrieve = async () => page();
    const app = testApp();

    const first = await importUrl(app, "https://example.test/report");
    // Same page, reached through a url that normalizes to the same thing.
    const second = await importUrl(
      app,
      "https://example.test/report#section-2"
    );

    expect(second.statusCode).toBe(201);
    const firstBody = first.json();
    const secondBody = second.json();
    expect(secondBody.reused).toBe(true);
    expect(secondBody.source.id).toBe(firstBody.source.id);
    // The text did not change, so no second version was created.
    expect(secondBody.versionCreated).toBe(false);

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/${firstBody.source.id}`
    });
    expect(detail.json().snapshots).toHaveLength(1);
  });

  it("keeps the previous version when the page changes", async () => {
    retrieve = async () => page();
    const app = testApp();
    const first = await importUrl(app, "https://example.test/report");

    retrieve = async () =>
      page({
        content: "Shipments were revised downwards.",
        contentHash: "hash-v2"
      });
    const second = await importUrl(app, "https://example.test/report");

    expect(second.json().versionCreated).toBe(true);
    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/${first.json().source.id}`
    });
    const hashes = detail
      .json()
      .snapshots.map((item: { contentHash: string }) => item.contentHash)
      .sort();
    expect(hashes).toEqual(["hash-v1", "hash-v2"]);
  });

  it("is idempotent: a retried key does not duplicate the import", async () => {
    retrieve = async () => page();
    const app = testApp();
    const key = newId();

    const first = await importUrl(app, "https://example.test/report", key);
    const retry = await importUrl(app, "https://example.test/report", key);

    expect(retry.statusCode).toBe(201);
    expect(retry.json().source.id).toBe(first.json().source.id);
    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/${first.json().source.id}`
    });
    expect(detail.json().snapshots).toHaveLength(1);
  });
});

describe("refusing an unsafe target", () => {
  it("refuses a non-http url without writing anything", async () => {
    let called = false;
    retrieve = async () => {
      called = true;
      return page();
    };
    const app = testApp();

    const response = await importUrl(app, "file:///etc/passwd");
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("blocked-target" as never);
    expect(called).toBe(false);
    expect(await evidenceRepository.listSources(SESSION_ID)).toHaveLength(0);
  });

  it("records the failure and its reason when the target is refused", async () => {
    retrieve = async () => {
      throw new TargetRefusedError(
        "Refusing to import 127.0.0.1: it is a loopback address",
        "loopback address"
      );
    };
    const app = testApp();

    const response = await importUrl(app, "http://127.0.0.1/admin");
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("blocked-target");

    // The attempt is persisted so the workspace can show why nothing arrived.
    const sources = await evidenceRepository.listSources(SESSION_ID);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.retrievalStatus).toBe("failed");
    expect(sources[0]?.retrievalError).toContain("loopback address");
    expect(sources[0]?.retrievalAttempts).toBe(1);
    expect(sources[0]?.contentHash).toBeUndefined();
  });

  it("records an unusable content type as a failed attempt", async () => {
    retrieve = async () => {
      throw new TargetRefusedError("no", "no");
    };
    const app = testApp();
    await importUrl(app, "https://example.test/paper.pdf");

    const sources = await evidenceRepository.listSources(SESSION_ID);
    expect(sources[0]?.retrievalStatus).toBe("failed");
  });
});

describe("access control", () => {
  it("requires a session", async () => {
    retrieve = async () => page();
    const app = testApp(false);
    const response = await importUrl(app, "https://example.test/report");
    expect(response.statusCode).toBe(401);
  });

  it("refuses a viewer", async () => {
    role = "viewer";
    retrieve = async () => page();
    const app = testApp();
    const response = await importUrl(app, "https://example.test/report");
    expect(response.statusCode).toBe(403);
  });

  it("requires an idempotency key", async () => {
    retrieve = async () => page();
    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/sources/import`,
      payload: { url: "https://example.test/report" }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("Idempotency-Key");
  });

  it("does not expose another session's source", async () => {
    retrieve = async () => page();
    const app = testApp();
    const created = await importUrl(app, "https://example.test/report");

    const foreign = await app.inject({
      method: "GET",
      url: `/api/sessions/${OTHER_SESSION_ID}/sources/${created.json().source.id}`
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe("confirming a candidate excerpt", () => {
  async function importAndClaim(application: ReturnType<typeof testApp>) {
    const imported = await importUrl(application, "https://example.test/report");
    const claimId = await seedClaim(SESSION_ID);
    return { sourceId: imported.json().source.id as string, claimId };
  }

  it("anchors a real excerpt and leaves it unverified", async () => {
    retrieve = async () => page();
    const app = testApp();
    const { sourceId, claimId } = await importAndClaim(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": newId() },
      payload: {
        kind: "external_reference",
        title: "Shipment growth",
        content: "Shipments grew 12% year over year",
        description: "Taken from the imported page.",
        sourceId,
        locatorKind: "quote",
        anchorText: "Shipments grew 12% year over year",
        direction: "supports",
        reliability: 0.7,
        claimIds: [claimId]
      }
    });

    expect(response.statusCode).toBe(201);
    const evidence = response.json().evidence;
    // The server located the quote itself, so it can say so honestly.
    expect(evidence.locatorStatus).toBe("anchored");
    expect(evidence.locator).toBe("第 1 段");
    expect(evidence.sourceContentHash).toBe("hash-v1");
    // Confirming an excerpt is not a verdict.
    expect(evidence.verificationStatus).toBe("unverified");
    expect(evidence.verifiedBy).toBeUndefined();
  });

  it("marks an excerpt that is not in the page as missing", async () => {
    retrieve = async () => page();
    const app = testApp();
    const { sourceId, claimId } = await importAndClaim(app);

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": newId() },
      payload: {
        kind: "external_reference",
        title: "Invented quote",
        content: "Shipments tripled in 2025",
        description: "Not actually in the page.",
        sourceId,
        locatorKind: "quote",
        anchorText: "Shipments tripled in 2025",
        direction: "supports",
        reliability: 0.5,
        claimIds: [claimId]
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().evidence.locatorStatus).toBe("missing");
    expect(response.json().evidence.verificationStatus).toBe("unverified");
  });

  it("detects a citation that broke when the page was rewritten", async () => {
    retrieve = async () => page();
    const app = testApp();
    const { sourceId, claimId } = await importAndClaim(app);

    const created = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: { "idempotency-key": newId() },
      payload: {
        kind: "external_reference",
        title: "Shipment growth",
        content: "Shipments grew 12% year over year",
        description: "Taken from the imported page.",
        sourceId,
        locatorKind: "quote",
        anchorText: "Shipments grew 12% year over year",
        direction: "supports",
        reliability: 0.7,
        claimIds: [claimId]
      }
    });
    expect(created.json().evidence.locatorStatus).toBe("anchored");

    // The page is rewritten behind our back.
    retrieve = async () =>
      page({
        content: "The report was withdrawn pending revision.",
        contentHash: "hash-v2"
      });
    await importUrl(app, "https://example.test/report");

    const recheck = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/sources/${sourceId}/recheck`,
      headers: { "idempotency-key": newId() }
    });
    expect(recheck.statusCode).toBe(200);
    expect(recheck.json().missing).toBe(1);
    expect(recheck.json().checked).toBe(1);

    const after = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/evidence/${created.json().evidence.id}`
    });
    expect(after.json().evidence.locatorStatus).toBe("missing");
    // The locator moved; the excerpt was never verified and still is not.
    expect(after.json().evidence.verificationStatus).toBe("unverified");
    // The older capture is still available, which is what makes re-checking
    // possible after the page moved on.
    expect(after.json().snapshot.contentHash).toBe("hash-v2");
  });

  it("refuses a recheck for a source that does not exist in this session", async () => {
    retrieve = async () => page();
    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/sources/${newId()}/recheck`,
      headers: { "idempotency-key": newId() }
    });
    expect(response.statusCode).toBe(404);
  });
});
