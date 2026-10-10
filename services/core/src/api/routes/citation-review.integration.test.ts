import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  CitationReviewRepository,
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
import { CitationReviewService } from "../../research/citation-review-service";
import type { LlmProvider, LlmRequest } from "@nexus/llm";

/**
 * Behaviour of the citation routes against a real database.
 *
 * The model is injected, so nothing here needs credentials or a network. What
 * these tests pin down is everything else: that layer A answers from stored
 * text alone, that layer B never verifies anything, that permissions and
 * session scoping hold, that a repeated click answers with the earlier result,
 * and that a human correction adds a record instead of rewriting one.
 *
 * "checked against a real model" is deliberately not asserted here — see the
 * delivery report for why that remains NOT RUN.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const citationRepository = new CitationReviewRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);

const PROJECT_ID = newId();
const SESSION_ID = newId();
const OTHER_SESSION_ID = newId();

const PAGE_TEXT =
  "Shipments grew 12% year over year.\n\n" +
  "The agency expects growth to continue.\n\n" +
  "Analysts remain cautious.";

let role: "owner" | "reviewer" | "viewer" = "reviewer";
let answer: string = JSON.stringify({ assessments: [] });
let providerThrows: Error | null = null;

const provider: LlmProvider = {
  async generate(request: LlmRequest) {
    void request;
    if (providerThrows) throw providerThrows;
    return answer;
  }
};

const citationService = new CitationReviewService({
  readClaims: async (sessionId) => (await arena.getSessionArtifacts(sessionId)).claims,
  evidence: evidenceRepository,
  citations: citationRepository,
  provider,
  providerName: "FakeProvider",
  model: "fake-model"
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
    citationReview: citationService
  });
}

beforeEach(async () => {
  role = "reviewer";
  providerThrows = null;
  answer = JSON.stringify({ assessments: [] });
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Citation review integration",
    input: {}
  });
  for (const sessionId of [SESSION_ID, OTHER_SESSION_ID]) {
    await database.execute(
      `INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence, research_question)
       VALUES ('${sessionId}', '${PROJECT_ID}', 'zh-CN', 'ANALYZING', 'ACTIVE', 1, 'Did shipments grow?')`
    );
  }
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

type Seeded = { sourceId: string; snapshotId: string; claimId: string };

/** One claim plus one excerpt quoting the stored capture. */
async function seedClaimWithEvidence(
  sessionId: string,
  options: {
    anchorText?: string | null;
    expectedHash?: string | null;
    snapshotContent?: string;
    snapshotHash?: string;
    secondSnapshot?: { content: string; hash: string };
  } = {}
): Promise<Seeded> {
  const sourceId = newId();
  const snapshotId = newId();
  const claimId = newId();
  const evidenceId = newId();
  const content = options.snapshotContent ?? PAGE_TEXT;
  const hash = options.snapshotHash ?? "hash-1";
  // `??` would turn an explicit null back into the default, and "no anchor at
  // all" is exactly the case being tested.
  const anchorText =
    "anchorText" in options
      ? options.anchorText
      : "Shipments grew 12% year over year.";
  const expectedHash =
    "expectedHash" in options ? options.expectedHash : hash;

  await database.execute(
    `INSERT INTO sources (id, session_id, title, kind, url, canonical_url, retrieval_status, retrieved_at, content_hash, created_by)
     VALUES ('${sourceId}', '${sessionId}', 'Quarterly report', 'url',
             'https://example.test/report', 'https://example.test/report', 'fetched', now(), '${hash}', 'human')`
  );
  await database.execute(
    `INSERT INTO source_snapshots (id, session_id, source_id, canonical_url, content_hash, content_type, content, content_bytes, char_count, retrieved_at)
     VALUES ('${snapshotId}', '${sessionId}', '${sourceId}', 'https://example.test/report',
             '${hash}', 'text/plain', '${content}', ${content.length}, ${content.length}, now())`
  );
  if (options.secondSnapshot) {
    await database.execute(
      `INSERT INTO source_snapshots (id, session_id, source_id, canonical_url, content_hash, content_type, content, content_bytes, char_count, retrieved_at)
       VALUES ('${newId()}', '${sessionId}', '${sourceId}', 'https://example.test/report',
               '${options.secondSnapshot.hash}', 'text/plain', '${options.secondSnapshot.content}',
               ${options.secondSnapshot.content.length}, ${options.secondSnapshot.content.length}, now() + interval '1 second')`
    );
  }
  await database.execute(
    `INSERT INTO claims (id, session_id, lens, statement, type, stance, importance, confidence,
                         evidence_ids, status, root_claim_id, revision, relations, created_at, updated_at)
     VALUES ('${claimId}', '${sessionId}', 'research', 'Shipments grew 12% year over year.',
             'fact', 'support', 3, 0.5, '[]'::jsonb, 'proposed', '${claimId}', 1, '[]'::jsonb, now(), now())`
  );
  const anchor = anchorText;
  await database.execute(
    `INSERT INTO evidence
       (id, session_id, claim_ids, kind, title, content, description, source_id,
        locator, locator_kind, locator_status, anchor_text, source_content_hash,
        direction, reliability, verification_status, retrieved_at, created_by)
     VALUES ('${evidenceId}', '${sessionId}', '["${claimId}"]'::jsonb, 'external_reference',
             'Annual report', '${anchor ?? "quoted text"}', 'quoted from the report', '${sourceId}',
             '第 1 段', 'quote', 'anchored', ${anchor === null ? "NULL" : `'${anchor}'`},
             ${expectedHash === null ? "NULL" : `'${expectedHash}'`},
             'supports', 0.8, 'unverified', now(), 'human')`
  );

  return { sourceId, snapshotId, claimId };
}

async function evidenceIdFor(sessionId: string): Promise<string> {
  const rows = (await database.execute(
    `select id from evidence where session_id = '${sessionId}' limit 1`
  )) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

async function claimIdOf(sessionId: string): Promise<string> {
  const rows = (await database.execute(
    `select id from claims where session_id = '${sessionId}' limit 1`
  )) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

const check = (key = newId(), sessionId = SESSION_ID, body?: unknown) =>
  testApp().inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/citations/check`,
    headers: body
      ? { "idempotency-key": key, "content-type": "application/json" }
      : { "idempotency-key": key },
    ...(body ? { payload: body } : {})
  });

const assess = (claimId: string, key = newId(), sessionId = SESSION_ID) =>
  testApp().inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/claims/${claimId}/support-assessment`,
    headers: { "idempotency-key": key }
  });

describe("POST /citations/check", () => {
  it("anchors a quote that is in the stored capture", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const response = await check();
    expect(response.statusCode).toBe(201);
    const body = response.json() as { checks: Array<{ status: string }> };
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0]!.status).toBe("anchored");
  });

  it("reports stale when the recorded version is not the current one", async () => {
    await seedClaimWithEvidence(SESSION_ID, {
      snapshotHash: "hash-0",
      expectedHash: "hash-0",
      snapshotContent: `${PAGE_TEXT}\n\nAn extra paragraph was added later.`,
      secondSnapshot: { content: PAGE_TEXT, hash: "hash-1" }
    });
    const response = await check();
    const body = response.json() as { checks: Array<{ status: string }> };
    expect(body.checks[0]!.status).toBe("stale");
  });

  it("reports missing when the quote is nowhere", async () => {
    await seedClaimWithEvidence(SESSION_ID, {
      anchorText: "Demand collapsed in the fourth quarter."
    });
    const response = await check();
    const body = response.json() as { checks: Array<{ status: string }> };
    expect(body.checks[0]!.status).toBe("missing");
  });

  it("reports partial for a truncated quote", async () => {
    await seedClaimWithEvidence(SESSION_ID, {
      anchorText: "Shipments grew 12% … Demand collapsed in the fourth quarter."
    });
    const response = await check();
    const body = response.json() as { checks: Array<{ status: string }> };
    expect(body.checks[0]!.status).toBe("partial");
  });

  it("reports an excerpt with no anchor as unregistered", async () => {
    await seedClaimWithEvidence(SESSION_ID, { anchorText: null, expectedHash: null });
    const response = await check();
    const body = response.json() as { checks: Array<{ status: string }> };
    expect(body.checks[0]!.status).toBe("unmapped");
  });

  it("works with no request body at all", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const response = await check();
    expect(response.statusCode).toBe(201);
  });

  it("answers a repeated click with the earlier stored check", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const key = newId();
    // One app, so one idempotency store: two separate instances would each have
    // their own and the replay this test is about could not happen at all.
    const app = testApp();
    const inject = () =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${SESSION_ID}/citations/check`,
        headers: { "idempotency-key": key }
      });
    const first = await inject();
    const second = await inject();
    expect(second.statusCode).toBe(201);
    const firstBody = first.json() as { checks: Array<{ id: string }> };
    const secondBody = second.json() as { checks: Array<{ id: string }> };
    expect(secondBody.checks[0]!.id).toBe(firstBody.checks[0]!.id);
  });

  it("refuses without an idempotency key", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/citations/check`
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a viewer", async () => {
    role = "viewer";
    await seedClaimWithEvidence(SESSION_ID);
    const response = await check();
    expect(response.statusCode).toBe(403);
  });

  it("refuses when authentication is enabled and no user is present", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const response = await testApp(false).inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/citations/check`,
      headers: { "idempotency-key": newId() }
    });
    expect(response.statusCode).toBe(401);
  });

  it("will not touch another session's excerpts", async () => {
    await seedClaimWithEvidence(OTHER_SESSION_ID);
    const response = await check(newId(), SESSION_ID);
    // Nothing in this session to check, so the honest answer is "nothing to do".
    expect(response.statusCode).toBe(422);
    const body = response.json() as { code: string };
    expect(body.code).toBe("no_evidence");
  });
});

describe("POST /claims/:claimId/support-assessment", () => {
  it("stores an assessment and reads it back after a refresh", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const evidenceId = await evidenceIdFor(SESSION_ID);
    const claimId = await claimIdOf(SESSION_ID);
    answer = JSON.stringify({
      assessments: [
        {
          evidenceId,
          status: "support",
          confidence: 0.6,
          rationale: "The excerpt states the same growth figure.",
          matchedExcerpt: "Shipments grew 12% year over year.",
          signals: []
        }
      ]
    });

    const response = await assess(claimId);
    expect(response.statusCode).toBe(201);

    const snapshot = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/citations`
    });
    const body = snapshot.json() as {
      assessments: Array<{ status: string }>;
      summaries: Array<{ status: string }>;
    };
    expect(body.assessments).toHaveLength(1);
    expect(body.summaries[0]!.status).toBe("support");
  });

  it("keeps the excerpt unverified", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const evidenceId = await evidenceIdFor(SESSION_ID);
    const claimId = await claimIdOf(SESSION_ID);
    answer = JSON.stringify({
      assessments: [
        {
          evidenceId,
          status: "support",
          confidence: 0.9,
          rationale: "Looks right to me.",
          matchedExcerpt: "Shipments grew 12% year over year.",
          signals: []
        }
      ]
    });
    await assess(claimId);

    const rows = (await database.execute(
      `select verification_status from evidence where id = '${evidenceId}'`
    )) as unknown as Array<{ verification_status: string }>;
    expect(rows[0]!.verification_status).toBe("unverified");
  });

  it("reports a claim from another session as not found", async () => {
    await seedClaimWithEvidence(OTHER_SESSION_ID);
    const foreignClaimId = await claimIdOf(OTHER_SESSION_ID);
    const response = await assess(foreignClaimId, newId(), SESSION_ID);
    expect(response.statusCode).toBe(404);
  });

  it("surfaces an unusable model answer as a failure, not a success", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const claimId = await claimIdOf(SESSION_ID);
    answer = "not json";
    const response = await assess(claimId);
    expect(response.statusCode).toBe(502);
    const body = response.json() as { code: string };
    expect(body.code).toBe("invalid_json");
  });

  it("reports a provider outage with its own code", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const claimId = await claimIdOf(SESSION_ID);
    providerThrows = new Error("connection refused");
    const response = await assess(claimId);
    expect(response.statusCode).toBe(502);
    const body = response.json() as { code: string };
    expect(body.code).toBe("provider_unavailable");
  });

  it("refuses a viewer", async () => {
    role = "viewer";
    await seedClaimWithEvidence(SESSION_ID);
    const claimId = await claimIdOf(SESSION_ID);
    const response = await assess(claimId);
    expect(response.statusCode).toBe(403);
  });
});

describe("POST /citation-corrections", () => {
  it("records a human correction and keeps the original in history", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const evidenceId = await evidenceIdFor(SESSION_ID);
    const created = await check();
    const originalId = (created.json() as { checks: Array<{ id: string }> })
      .checks[0]!.id;

    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/citation-corrections`,
      headers: { "idempotency-key": newId() },
      payload: {
        kind: "integrity",
        targetId: originalId,
        status: "stale",
        rationale: "I checked the live page and the wording changed."
      }
    });
    expect(response.statusCode).toBe(201);

    const history = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/citations/history?kind=integrity&evidenceId=${evidenceId}`
    });
    const body = history.json() as {
      items: Array<{ id: string; status: string; origin: string; actor: string }>;
    };
    expect(body.items).toHaveLength(2);
    const original = body.items.find((item) => item.id === originalId)!;
    expect(original.status).toBe("anchored");
    expect(original.origin).toBe("system");
    expect(body.items[1]!.origin).toBe("human");
  });

  it("rejects a status from the other vocabulary", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const created = await check();
    const originalId = (created.json() as { checks: Array<{ id: string }> })
      .checks[0]!.id;
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/citation-corrections`,
      headers: { "idempotency-key": newId() },
      payload: {
        kind: "integrity",
        targetId: originalId,
        status: "support",
        rationale: "Trying to use a support status on an integrity check."
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a correction with too short a reason", async () => {
    await seedClaimWithEvidence(SESSION_ID);
    const created = await check();
    const originalId = (created.json() as { checks: Array<{ id: string }> })
      .checks[0]!.id;
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/citation-corrections`,
      headers: { "idempotency-key": newId() },
      payload: {
        kind: "integrity",
        targetId: originalId,
        status: "missing",
        rationale: "nope"
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("will not correct a record belonging to another session", async () => {
    await seedClaimWithEvidence(OTHER_SESSION_ID);
    const otherApp = testApp();
    const created = await otherApp.inject({
      method: "POST",
      url: `/api/sessions/${OTHER_SESSION_ID}/citations/check`,
      headers: { "idempotency-key": newId() }
    });
    const originalId = (created.json() as { checks: Array<{ id: string }> })
      .checks[0]!.id;

    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/citation-corrections`,
      headers: { "idempotency-key": newId() },
      payload: {
        kind: "integrity",
        targetId: originalId,
        status: "missing",
        rationale: "Reaching across sessions should not work."
      }
    });
    expect(response.statusCode).toBe(404);
  });
});
