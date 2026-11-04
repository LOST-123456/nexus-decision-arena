import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  ResearchPlanRepository,
  ReviewRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";

/**
 * DB-backed integration test for the research-plan routes.
 *
 * What only a real database can prove: that a plan item is actually stored
 * with its lifecycle, that adding the same gap twice does not create two
 * tasks or two events, that every transition supersedes the previous row (the
 * old row stays readable), and that an outcome may only cite material that is
 * registered in this session.
 *
 * No model and no network are involved. The database is the dedicated test
 * database named by TEST_DATABASE_URL; the guard refuses anything else.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);
const planRepository = new ResearchPlanRepository(database);

const PROJECT_ID = newId();
const SESSION_ID = newId();
const CLAIM_ID = newId();

let role: "owner" | "reviewer" | "viewer" = "reviewer";

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
    researchPlan: planRepository
  });
}

async function seedSession() {
  const timestamp = new Date().toISOString();
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Research plan integration",
    input: {}
  });
  await sessions.create({
    id: SESSION_ID,
    projectId: PROJECT_ID,
    locale: "zh-CN",
    phase: "EVIDENCE",
    operationalStatus: "ACTIVE",
    currentConclusion: null,
    // The research belongs to the signed-in reviewer: access is decided from
    // the recorded owner, never from the request.
    ownerUserId: "user-1"
  });
  await arena.createResearchClaim({
    claim: {
      id: CLAIM_ID,
      sessionId: SESSION_ID,
      lens: "market",
      statement: "出货量同比增长 12%。",
      type: "fact",
      stance: "support",
      importance: 4,
      confidence: 0.5,
      evidenceIds: [],
      status: "proposed",
      rootClaimId: CLAIM_ID,
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    },
    event: {
      correlationId: newId(),
      type: "CLAIM_CREATED",
      payload: { claimId: CLAIM_ID }
    }
  });
}

beforeEach(async () => {
  role = "reviewer";
  await seedSession();
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

async function getPlan(sessionId = SESSION_ID) {
  const response = await testApp().inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/research-plan`
  });
  return { status: response.statusCode, body: response.json() };
}

/** The fresh session's diagnosis always contains this blocking gap. */
async function firstAvailableGapId(): Promise<string> {
  const plan = await getPlan();
  return plan.body.availableGaps[0]?.id ?? "";
}

describe("GET /research-plan", () => {
  it("returns an empty plan and the derived gaps for a fresh session", async () => {
    const plan = await getPlan();
    expect(plan.status).toBe(200);
    expect(plan.body.items).toEqual([]);
    expect(plan.body.searchAvailable).toBe(false);
    expect(plan.body.availableGaps.length).toBeGreaterThan(0);
    expect(plan.body.summary.total).toBe(0);
    expect(plan.body.headline).toContain("还没有条目");
  });

  it("says 尚未执行 for planned-but-unexecuted items", async () => {
    const gapId = await firstAvailableGapId();
    await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan`,
      headers: { "idempotency-key": newId() },
      payload: { gapId }
    });
    const plan = await getPlan();
    expect(plan.body.summary.total).toBe(1);
    expect(plan.body.summary.notStarted).toBe(1);
    expect(plan.body.headline).toContain("尚未执行任何检索");
    expect(plan.body.items[0].availableActions).not.toContain("start_search");
  });

  it("returns 404 for an unknown session", async () => {
    const plan = await getPlan(newId());
    expect(plan.status).toBe(404);
  });

  it("requires authentication when auth is enabled", async () => {
    const response = await testApp(false).inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research-plan`
    });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /research-plan", () => {
  it("adds a gap as a queued item owned by the actor", async () => {
    const gapId = await firstAvailableGapId();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan`,
      headers: { "idempotency-key": newId() },
      payload: { gapId }
    });
    expect(response.statusCode).toBe(201);
    const item = response.json().item;
    expect(item.status).toBe("queued");
    expect(item.claimId).toBe(CLAIM_ID);
    expect(item.query.terms.length).toBeGreaterThan(0);
    expect(item.gapKind).toBe("no_verified_support");
    expect(item.priority).toBe(1);
  });

  it("answers a repeated add of the same gap with the existing item", async () => {
    const gapId = await firstAvailableGapId();
    const app = testApp();
    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan`,
      headers: { "idempotency-key": newId() },
      payload: { gapId }
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan`,
      headers: { "idempotency-key": newId() },
      payload: { gapId }
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyPlanned).toBe(true);
    expect(second.json().item.id).toBe(first.json().item.id);

    const plan = await getPlan();
    expect(plan.body.summary.total).toBe(1);
  });

  it("replays the stored response for a repeated idempotency key", async () => {
    const gapId = await firstAvailableGapId();
    const app = testApp();
    const key = newId();
    const request = {
      method: "POST" as const,
      url: `/api/sessions/${SESSION_ID}/research-plan`,
      headers: { "idempotency-key": key },
      payload: { gapId }
    };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().item.id).toBe(first.json().item.id);
  });

  it("refuses a gap that is not part of the current diagnosis with 404", async () => {
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan`,
      headers: { "idempotency-key": newId() },
      payload: { gapId: "gap-does-not-exist" }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("gap_not_found");
  });

  it("refuses a viewer", async () => {
    role = "viewer";
    const gapId = await firstAvailableGapId();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan`,
      headers: { "idempotency-key": newId() },
      payload: { gapId }
    });
    expect(response.statusCode).toBe(403);
  });

  it("requires an idempotency key", async () => {
    const gapId = await firstAvailableGapId();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan`,
      payload: { gapId }
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("transitions", () => {
  async function addItem(): Promise<string> {
    const gapId = await firstAvailableGapId();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan`,
      headers: { "idempotency-key": newId() },
      payload: { gapId }
    });
    return response.json().item.id;
  }

  it("edits the query and keeps the previous row readable in history", async () => {
    const itemId = await addItem();
    const app = testApp();
    const edited = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan/${itemId}/query`,
      headers: { "idempotency-key": newId() },
      payload: { terms: ["行业年报 出货量"], notes: "先查行业协会。" }
    });
    expect(edited.statusCode).toBe(200);
    const item = edited.json().item;
    expect(item.status).toBe("queued");
    expect(item.query.terms).toEqual(["行业年报 出货量"]);
    expect(item.supersedesId).toBe(itemId);

    const plan = await getPlan();
    // The plan shows the current row only.
    expect(plan.body.items).toHaveLength(1);
    expect(plan.body.items[0].id).toBe(item.id);

    const history = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research-plan/history?gapId=${item.gapId}`
    });
    expect(history.statusCode).toBe(200);
    expect(history.json().items).toHaveLength(2);
  });

  it("keeps the declared query language, and never invents one", async () => {
    const itemId = await addItem();
    const app = testApp();
    const plan = await getPlan();
    // A fresh item declares nothing: absent means nobody declared a language.
    expect(plan.body.items[0].query.queryLanguage).toBeUndefined();

    const declared = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan/${itemId}/query`,
      headers: { "idempotency-key": newId() },
      payload: {
        terms: ["industry annual report shipment volume"],
        queryLanguage: "en",
        notes: "原始材料为英文。"
      }
    });
    expect(declared.statusCode).toBe(200);
    const declaredItem = declared.json().item;
    expect(declaredItem.query.queryLanguage).toBe("en");

    // A later edit that says nothing about language keeps the declaration:
    // it is never guessed and never silently cleared.
    const silent = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan/${declaredItem.id}/query`,
      headers: { "idempotency-key": newId() },
      payload: { terms: ["industry annual report shipment volume"] }
    });
    expect(silent.statusCode).toBe(200);
    expect(silent.json().item.query.queryLanguage).toBe("en");

    // The superseded rows keep their declarations too — history stays readable:
    // the declared row and the silent row both carry "en", and the original
    // row (created from the gap, nobody declared anything) stays undefined.
    const history = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research-plan/history?gapId=${declaredItem.gapId}`
    });
    expect(history.statusCode).toBe(200);
    const rows = history.json().items;
    expect(rows).toHaveLength(3);
    expect(rows[0].query.queryLanguage).toBe("en");
    expect(rows[1].query.queryLanguage).toBe("en");
    expect(rows[2].query.queryLanguage).toBeUndefined();
  });

  it("marks an item not applicable with the mandatory reason", async () => {
    const itemId = await addItem();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan/${itemId}/decision`,
      headers: { "idempotency-key": newId() },
      payload: {
        result: "not_applicable",
        reason: "该主张属于范围外议题，与本研究问题无关。"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().item.status).toBe("not_applicable");
    expect(response.json().item.decidedBy).toBe("Researcher One (researcher)");

    // The gap is now planned, so it leaves availableGaps and cannot re-enter.
    const plan = await getPlan();
    expect(plan.body.availableGaps.length).toBe(0);
  });

  it("refuses a decision reason that is too short", async () => {
    const itemId = await addItem();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan/${itemId}/decision`,
      headers: { "idempotency-key": newId() },
      payload: { result: "closed", reason: "短" }
    });
    expect(response.statusCode).toBe(400);
  });

  it("completes an item with a manual outcome citing registered material", async () => {
    const itemId = await addItem();
    const evidenceId = newId();
    const timestamp = new Date().toISOString();
    await evidenceRepository.createEvidence({
      evidence: {
        id: evidenceId,
        sessionId: SESSION_ID,
        claimIds: [CLAIM_ID],
        kind: "project_input",
        title: "行业年报摘录",
        content: "2026 年行业年报第 12 页。",
        description: "原始统计表摘录。",
        direction: "supports",
        reliability: 0.9,
        verificationStatus: "unverified",
        retrievedAt: timestamp,
        createdBy: "human"
      },
      event: {
        correlationId: newId(),
        type: "EVIDENCE_RECORDED",
        payload: { evidenceId }
      }
    });

    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan/${itemId}/outcome`,
      headers: { "idempotency-key": newId() },
      payload: {
        summary: "在行业年报中找到覆盖同一时期的原始统计表。",
        sourceIds: [],
        evidenceIds: [evidenceId]
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().item.status).toBe("completed");
    expect(response.json().item.outcome.evidenceIds).toEqual([evidenceId]);
    expect(response.json().item.outcome.recordedBy).toBe(
      "Researcher One (researcher)"
    );
  });

  it("refuses an outcome citing material from another research task", async () => {
    const itemId = await addItem();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan/${itemId}/outcome`,
      headers: { "idempotency-key": newId() },
      payload: {
        summary: "引用了另一个研究会话里登记的材料，必须被拒绝。",
        sourceIds: [newId()],
        evidenceIds: []
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("invalid_request");
  });

  it("refuses a transition on an item id that no longer exists", async () => {
    const itemId = await addItem();
    await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan/${itemId}/decision`,
      headers: { "idempotency-key": newId() },
      payload: {
        result: "closed",
        reason: "该缺口已由人工判断关闭，不再继续。"
      }
    });
    // The old id was superseded; it no longer resolves.
    const again = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-plan/${itemId}/decision`,
      headers: { "idempotency-key": newId() },
      payload: {
        result: "closed",
        reason: "对旧条目再次操作，应当被拒绝。"
      }
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().code).toBe("plan_item_not_found");
  });
});
