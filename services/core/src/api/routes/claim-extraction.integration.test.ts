import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  ClaimExtractionRepository,
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
import { ClaimExtractionService } from "../../research/claim-extraction-service";
import type { LlmProvider, LlmRequest } from "@nexus/llm";

/**
 * Behaviour of the extraction routes against a real database.
 *
 * The model is injected, so nothing here depends on anyone's credentials or a
 * network. What these tests pin down is everything else: that a proposal never
 * reaches a verified state, that permissions and session scoping hold, that a
 * repeated click answers with the earlier result, and that ruling on candidates
 * leaves the domain tables exactly as they were.
 *
 * ` approached with a real model` is deliberately not asserted anywhere in this
 * file — see the delivery report for why that remains NOT RUN.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const candidateRepository = new ClaimExtractionRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);

const PROJECT_ID = newId();
const SESSION_ID = newId();
const OTHER_SESSION_ID = newId();

const CONTENT =
  "Shipments grew 12% year over year.\n\n" +
  "The agency expects growth to continue because demand recovered.";

let role: "owner" | "reviewer" | "viewer" = "reviewer";
let answer: string | (() => string) = JSON.stringify({
  claims: [
    {
      statement: "The agency expects growth to continue because demand recovered.",
      type: "causal",
      qualifiers: [],
      uncertainty: [],
      rationale: "Cause stated explicitly.",
      importance: 4,
      evidence: [
        {
          excerpt: "The agency expects growth to continue because demand recovered.",
          title: "Outlook",
          direction: "supports",
          rationale: "Same sentence.",
          uncertainty: []
        }
      ]
    }
  ],
  documentNotes: []
});
let providerThrows: Error | null = null;

const provider: LlmProvider = {
  async generate(request: LlmRequest) {
    void request;
    if (providerThrows) throw providerThrows;
    return typeof answer === "function" ? answer() : answer;
  }
};

const extraction = new ClaimExtractionService({
  provider,
  providerName: "FakeProvider",
  model: "fake-model",
  runs: candidateRepository,
  evidence: evidenceRepository
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
    claimExtraction: extraction
  });
}

async function seed() {
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Claim extraction integration",
    input: {}
  });
  for (const sessionId of [SESSION_ID, OTHER_SESSION_ID]) {
    await database.execute(
      `INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence, research_question, owner_user_id)
       VALUES ('${sessionId}', '${PROJECT_ID}', 'zh-CN', 'ANALYZING', 'ACTIVE', 1, 'Did shipments grow?', 'user-1')`
    );
  }
}

/** Creates a source plus the capture the analysis needs to have something to read. */
async function seedSourceWithSnapshot(sessionId: string): Promise<string> {
  const sourceId = newId();
  const snapshotId = newId();
  await database.execute(
    `INSERT INTO sources (id, session_id, title, kind, url, canonical_url, retrieval_status, retrieved_at, content_hash, created_by)
     VALUES ('${sourceId}', '${sessionId}', 'Quarterly report', 'url',
             'https://example.test/report', 'https://example.test/report', 'fetched', now(), 'hash-1', 'human')`
  );
  await database.execute(
    `INSERT INTO source_snapshots (id, session_id, source_id, canonical_url, content_hash, content_type, content, content_bytes, char_count, retrieved_at)
     VALUES ('${snapshotId}', '${sessionId}', '${sourceId}', 'https://example.test/report',
             'hash-1', 'text/plain', '${CONTENT}', ${CONTENT.length}, ${CONTENT.length}, now())`
  );
  return sourceId;
}

async function seedSourceWithoutSnapshot(sessionId: string): Promise<string> {
  const sourceId = newId();
  await database.execute(
    `INSERT INTO sources (id, session_id, title, kind, url, canonical_url, created_by)
     VALUES ('${sourceId}', '${sessionId}', 'Manual note', 'manual',
             NULL, NULL, 'human')`
  );
  return sourceId;
}

async function countRows(table: string): Promise<number> {
  const rows = (await database.execute(
    `select count(*)::int as total from public.${table}`
  )) as unknown as Array<{ total: number }>;
  return rows[0]?.total ?? -1;
}

const analyze = (sourceId: string, key = newId(), sessionId = SESSION_ID) =>
  testApp().inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/sources/${sourceId}/extract-claims`,
    headers: { "idempotency-key": key }
  });

beforeEach(async () => {
  role = "reviewer";
  answer = JSON.stringify({
    claims: [
      {
        statement: "The agency expects growth to continue because demand recovered.",
        type: "causal",
        qualifiers: [],
        uncertainty: [],
        rationale: "Cause stated explicitly.",
        importance: 4,
        evidence: [
          {
            excerpt:
              "The agency expects growth to continue because demand recovered.",
            title: "Outlook",
            direction: "supports",
            rationale: "Same sentence.",
            uncertainty: []
          }
        ]
      }
    ],
    documentNotes: []
  });
  providerThrows = null;
  await seed();
});

afterEach(async () => {
  await database.execute("TRUNCATE claim_extraction_runs CASCADE");
});

describe("asking the backend to propose claims", () => {
  it("returns proposals whose excerpt resolves in the stored capture", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const response = await analyze(sourceId);

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.run.status).toBe("succeeded");
    expect(body.claimCandidates).toHaveLength(1);
    expect(body.claimCandidates[0].status).toBe("proposed");
    expect(body.evidenceCandidates).toHaveLength(1);
    expect(body.evidenceCandidates[0].locatorStatus).toBe("anchored");
    expect(body.evidenceCandidates[0].sourceContentHash).toBe("hash-1");
  });

  it("answers a repeated click with the earlier result instead of a second copy", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const first = await analyze(sourceId);
    const second = await analyze(sourceId);

    expect(second.statusCode).toBe(201);
    expect(second.json().reused).toBe(true);
    expect(second.json().run.id).toBe(first.json().run.id);
    await expect(countRows("claim_candidates")).resolves.toBe(1);
  });

  it("replays the original response under the same idempotency key", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const key = newId();
    const first = await analyze(sourceId, key);
    const second = await analyze(sourceId, key);

    expect(second.statusCode).toBe(201);
    expect(second.json().run.id).toBe(first.json().run.id);
    await expect(countRows("claim_extraction_runs")).resolves.toBe(1);
  });

  it("succeeds with nothing rather than failing when there is nothing to extract", async () => {
    answer = JSON.stringify({ claims: [], documentNotes: [] });
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const response = await analyze(sourceId);

    expect(response.statusCode).toBe(201);
    expect(response.json().run.status).toBe("succeeded");
    expect(response.json().claimCandidates).toHaveLength(0);
  });

  it("marks a quotation the page does not contain as unlocatable", async () => {
    answer = JSON.stringify({
      claims: [
        {
          statement: "Revenue doubled overnight.",
          type: "fact",
          qualifiers: [],
          uncertainty: [],
          rationale: "Asserted in the text.",
          importance: 3,
          evidence: [
            {
              excerpt: "Revenue doubled overnight.",
              title: "Invented",
              direction: "supports",
              rationale: "Asserted in the text.",
              uncertainty: []
            }
          ]
        }
      ],
      documentNotes: []
    });
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const response = await analyze(sourceId);

    expect(response.json().evidenceCandidates[0].locatorStatus).toBe("missing");
    expect(response.json().run.anchorMissing).toBe(1);
  });

  it("reports a model failure with a code instead of pretending to succeed", async () => {
    providerThrows = new Error("fetch failed");
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const response = await analyze(sourceId);

    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("provider_unavailable");
    await expect(countRows("claim_candidates")).resolves.toBe(0);

    // The failure is recorded rather than left as a bare error: "the model did
    // not answer" is not "no claims were found".
    const runs = await extraction.listRuns(SESSION_ID, { sourceId });
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.failureCode).toBe("provider_unavailable");
  });

  it("lets the same question be retried once the model answers", async () => {
    providerThrows = new Error("fetch failed");
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    await analyze(sourceId);

    providerThrows = null;
    const retry = await analyze(sourceId);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().claimCandidates).toHaveLength(1);
    await expect(countRows("claim_extraction_runs")).resolves.toBe(1);
  });

  it("refuses when the source has no stored page, and says why", async () => {
    const sourceId = await seedSourceWithoutSnapshot(SESSION_ID);
    const response = await analyze(sourceId);

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("no_snapshot");
  });

  it("refuses without an idempotency key", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/sources/${sourceId}/extract-claims`,
      headers: {}
    });
    expect(response.statusCode).toBe(400);
  });

  it("keeps a viewer from starting an analysis", async () => {
    role = "viewer";
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const response = await analyze(sourceId);
    expect(response.statusCode).toBe(403);
  });

  it("answers a logged-out user with 401 when auth is enabled", async () => {
    role = "owner";
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const app = createApp({
      auth: { userFromRequest: () => null } as never,
      sessions,
      inspector: {} as never,
      events,
      runSession: { start: async () => undefined },
      evidence: evidenceRepository,
      reviews: reviewRepository,
      arena,
      claimExtraction: extraction
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/sources/${sourceId}/extract-claims`,
      headers: { "idempotency-key": newId() }
    });
    expect(response.statusCode).toBe(401);
  });

  it("treats another session's source as absent rather than forbidden", async () => {
    const sourceId = await seedSourceWithSnapshot(OTHER_SESSION_ID);
    const response = await analyze(sourceId);
    expect(response.statusCode).toBe(404);
  });

  it("keeps the analysis invisible when the service is not configured", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const app = createApp({
      auth: fakeAuth() as never,
      sessions,
      inspector: {} as never,
      events,
      runSession: { start: async () => undefined },
      evidence: evidenceRepository,
      reviews: reviewRepository,
      arena
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/sources/${sourceId}/extract-claims`,
      headers: { "idempotency-key": newId() }
    });
    expect(response.statusCode).toBe(501);
  });
});

describe("reading an analysis back", () => {
  it("survives a reload with its candidates", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const created = (await analyze(sourceId)).json();
    const app = testApp();

    const listed = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/extraction-runs?sourceId=${sourceId}`
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().runs).toHaveLength(1);

    const shown = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/extraction-runs/${created.run.id}`
    });
    expect(shown.statusCode).toBe(200);
    expect(shown.json().claimCandidates).toHaveLength(1);
    expect(shown.json().evidenceCandidates[0].locatorStatus).toBe("anchored");
  });

  it("does not show one session's analysis to another", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const created = (await analyze(sourceId)).json();
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${OTHER_SESSION_ID}/extraction-runs/${created.run.id}`
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("ruling on candidates", () => {
  async function analyzed(sourceId: string) {
    return (await analyze(sourceId)).json();
  }

  it("records a ruling and links the rows the accept created", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const result = await analyzed(sourceId);
    const app = testApp();

    // The claim and excerpt are created through the ordinary domain endpoints,
    // exactly as a hand-entered record would be.
    const claimResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/claims`,
      headers: { "idempotency-key": `extract-claim-${result.claimCandidates[0].id}` },
      payload: {
        statement: result.claimCandidates[0].statement,
        type: "fact",
        stance: "neutral",
        importance: 3
      }
    });
    expect(claimResponse.statusCode).toBe(201);
    const claimId = claimResponse.json().claim.id;

    const evidenceResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/evidence`,
      headers: {
        "idempotency-key": `extract-evidence-${result.evidenceCandidates[0].id}`
      },
      payload: {
        kind: "external_reference",
        title: result.evidenceCandidates[0].title,
        content: result.evidenceCandidates[0].excerpt,
        description: "proposed by analysis",
        sourceId,
        locatorKind: "quote",
        anchorText: result.evidenceCandidates[0].excerpt,
        direction: "supports",
        reliability: 0.5,
        claimIds: [claimId]
      }
    });
    expect(evidenceResponse.statusCode).toBe(201);
    // What the whole requirement turns on: an accepted proposal is material,
    // but nothing about accepting it verified it.
    expect(evidenceResponse.json().evidence.verificationStatus).toBe("unverified");
    expect(evidenceResponse.json().evidence.locatorStatus).toBe("anchored");

    const decisions = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/extraction-runs/${result.run.id}/decisions`,
      headers: { "idempotency-key": newId() },
      payload: {
        decisions: [
          {
            candidateId: result.claimCandidates[0].id,
            kind: "claim",
            status: "accepted",
            createdClaimId: claimId
          },
          {
            candidateId: result.evidenceCandidates[0].id,
            kind: "evidence",
            status: "accepted",
            createdEvidenceId: evidenceResponse.json().evidence.id
          }
        ]
      }
    });
    expect(decisions.statusCode).toBe(200);
    expect(decisions.json().claimCandidates[0].status).toBe("accepted");
    expect(decisions.json().claimCandidates[0].createdClaimId).toBe(claimId);

    const reread = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/extraction-runs/${result.run.id}`
    });
    expect(reread.json().claimCandidates[0].status).toBe("accepted");
  });

  it("writes nothing into the domain when a candidate is rejected", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const result = await analyzed(sourceId);
    const claimsBefore = await countRows("claims");
    const evidenceBefore = await countRows("evidence");

    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/extraction-runs/${result.run.id}/decisions`,
      headers: { "idempotency-key": newId() },
      payload: {
        decisions: [
          {
            candidateId: result.claimCandidates[0].id,
            kind: "claim",
            status: "rejected"
          },
          {
            candidateId: result.evidenceCandidates[0].id,
            kind: "evidence",
            status: "rejected"
          }
        ]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().claimCandidates[0].status).toBe("rejected");
    expect(await countRows("claims")).toBe(claimsBefore);
    expect(await countRows("evidence")).toBe(evidenceBefore);
  });

  it("refuses to accept a candidate without the id of what it produced", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const result = await analyzed(sourceId);
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/extraction-runs/${result.run.id}/decisions`,
      headers: { "idempotency-key": newId() },
      payload: {
        decisions: [
          {
            candidateId: result.claimCandidates[0].id,
            kind: "claim",
            status: "accepted"
          }
        ]
      }
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses to rule on a candidate belonging to another session", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const result = await analyzed(sourceId);
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${OTHER_SESSION_ID}/extraction-runs/${result.run.id}/decisions`,
      headers: { "idempotency-key": newId() },
      payload: {
        decisions: [
          {
            candidateId: result.claimCandidates[0].id,
            kind: "claim",
            status: "rejected"
          }
        ]
      }
    });
    expect(response.statusCode).toBe(404);
  });

  it("keeps a viewer from ruling", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const result = await analyzed(sourceId);
    // Analyzed as a reviewer; only the ruling is attempted as a viewer, which is
    // the permission being tested.
    role = "viewer";
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/extraction-runs/${result.run.id}/decisions`,
      headers: { "idempotency-key": newId() },
      payload: {
        decisions: [
          {
            candidateId: result.claimCandidates[0].id,
            kind: "claim",
            status: "rejected"
          }
        ]
      }
    });
    expect(response.statusCode).toBe(403);
  });

  it("records audit events for both the analysis and the ruling", async () => {
    const sourceId = await seedSourceWithSnapshot(SESSION_ID);
    const result = await analyzed(sourceId);
    await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/extraction-runs/${result.run.id}/decisions`,
      headers: { "idempotency-key": newId() },
      payload: {
        decisions: [
          {
            candidateId: result.claimCandidates[0].id,
            kind: "claim",
            status: "rejected"
          }
        ]
      }
    });

    const recorded = (await database.execute(
      `select type from execution_events where session_id = '${SESSION_ID}' order by sequence`
    )) as unknown as Array<{ type: string }>;
    const types = recorded.map((row) => row.type);
    expect(types).toContain("CLAIM_EXTRACTION_STARTED");
    expect(types).toContain("CLAIM_EXTRACTION_COMPLETED");
    expect(types).toContain("CLAIM_CANDIDATES_DECIDED");
  });
});
