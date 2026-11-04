import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  ResearchPlanRepository,
  ResearchSearchRepository,
  ReviewRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";
import {
  SearchProviderError,
  type SearchLead,
  type SearchProvider
} from "../../research/search-provider";

/**
 * DB-backed integration tests for the controlled research-search routes.
 *
 * What only a real database can prove:
 *  - a search task and its candidates are actually persisted, and survive a
 *    fresh repository instance (the "refresh / persistence" requirement);
 *  - approving a task copies candidates into `sources` but never creates a row
 *    in `evidence` — the "unapproved / unverified source must not become
 *    evidence" line, verified against the real evidence repository;
 *  - the failed-search path returns 422 with code `search_failed` while still
 *    recording the task as failed;
 *  - viewers are forbidden (403) and unauthenticated requests are rejected
 *    (401), and a missing idempotency key is a 400.
 *
 * No live network is involved: the production provider is deterministic, and the
 * failing case injects a throwing provider through `searchProvider`.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);
const planRepository = new ResearchPlanRepository(database);
const searchRepository = new ResearchSearchRepository(database);

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

class FailingProvider implements SearchProvider {
  readonly name = "failing-controlled-search";
  async search(): Promise<SearchLead[]> {
    throw new SearchProviderError("受控检索依赖的索引暂时不可用");
  }
}

function testApp(enabled = true, provider?: SearchProvider) {
  return createApp({
    auth: fakeAuth(enabled) as never,
    sessions,
    inspector: {} as never,
    events,
    runSession: { start: async () => undefined },
    evidence: evidenceRepository,
    reviews: reviewRepository,
    arena,
    researchPlan: planRepository,
    researchSearch: searchRepository,
    ...(provider ? { searchProvider: provider } : {})
  });
}

async function seedSession() {
  const timestamp = new Date().toISOString();
  await database.execute("TRUNCATE projects CASCADE");
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Research search integration",
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

/** The fresh session's diagnosis always contains at least one blocking gap. */
async function firstAvailableGapId(): Promise<string> {
  const response = await testApp().inject({
    method: "GET",
    url: `/api/sessions/${SESSION_ID}/research-plan`
  });
  return response.json().availableGaps[0]?.id ?? "";
}

/** Adds the first available gap as a plan item and returns its id. */
async function createPlanItem(): Promise<string> {
  const gapId = await firstAvailableGapId();
  const response = await testApp().inject({
    method: "POST",
    url: `/api/sessions/${SESSION_ID}/research-plan`,
    headers: { "idempotency-key": newId() },
    payload: { gapId }
  });
  return response.json().item.id;
}

async function createSearchTask(
  planItemId: string,
  provider?: SearchProvider,
  key = newId()
) {
  return testApp(true, provider).inject({
    method: "POST",
    url: `/api/sessions/${SESSION_ID}/research-search-tasks`,
    headers: { "idempotency-key": key },
    payload: {
      planItemId,
      query: "出货量同比变化",
      purpose: "为「出货量」主张补充可核对的来源",
      keywords: ["出货量", "同比"]
    }
  });
}

describe("POST /research-search-tasks", () => {
  it("creates and runs a task, completing with candidates", async () => {
    const planItemId = await createPlanItem();
    const response = await createSearchTask(planItemId);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.task.status).toBe("completed");
    expect(body.candidates.length).toBe(2);
    expect(body.task.planItemId).toBe(planItemId);
  });

  it("returns 422 with code search_failed when the provider cannot run", async () => {
    const planItemId = await createPlanItem();
    const response = await createSearchTask(planItemId, new FailingProvider());
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("search_failed");
    expect(response.json().task.status).toBe("failed");
    expect(response.json().task.failureReason).toContain("索引");
  });

  it("returns 404 when the plan item does not exist", async () => {
    const response = await createSearchTask(newId());
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("plan_item_not_found");
  });

  it("forbids a viewer (403)", async () => {
    // A viewer may not create a search task; the plan item is created by a
    // reviewer first, then the role flips to viewer for the forbidden call.
    const planItemId = await createPlanItem();
    role = "viewer";
    const response = await createSearchTask(planItemId);
    expect(response.statusCode).toBe(403);
  });

  it("requires authentication (401)", async () => {
    const planItemId = await createPlanItem();
    const response = await testApp(false).inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-search-tasks`,
      headers: { "idempotency-key": newId() },
      payload: {
        planItemId,
        query: "q",
        purpose: "p",
        keywords: ["k"]
      }
    });
    expect(response.statusCode).toBe(401);
  });

  it("requires an idempotency key (400)", async () => {
    const planItemId = await createPlanItem();
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-search-tasks`,
      payload: {
        planItemId,
        query: "q",
        purpose: "p",
        keywords: ["k"]
      }
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /research-search-tasks", () => {
  it("lists tasks with their candidate counts", async () => {
    const planItemId = await createPlanItem();
    await createSearchTask(planItemId);
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research-search-tasks`
    });
    expect(response.statusCode).toBe(200);
    const tasks = response.json().tasks;
    expect(tasks.length).toBe(1);
    expect(tasks[0].candidateCount).toBe(2);
  });

  it("reads a task together with its candidates", async () => {
    const planItemId = await createPlanItem();
    const created = await createSearchTask(planItemId);
    const taskId = created.json().task.id;
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research-search-tasks/${taskId}`
    });
    expect(response.statusCode).toBe(200);
    // The GET endpoint returns the task flattened with its candidates.
    expect(response.json().candidates.length).toBe(2);
    // The UI contract: candidates are explicitly not evidence.
    expect(response.json().status).toBe("completed");
  });

  it("returns 404 for an unknown task", async () => {
    const response = await testApp().inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/research-search-tasks/${newId()}`
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("search_task_not_found");
  });
});

describe("approve / reject", () => {
  it("registers candidates as sources and creates NO evidence", async () => {
    const planItemId = await createPlanItem();
    const created = await createSearchTask(planItemId);
    const taskId = created.json().task.id;

    // Before approval: nothing has entered the provenance or evidence layers.
    expect((await evidenceRepository.listSources(SESSION_ID)).length).toBe(0);
    expect((await evidenceRepository.listEvidence(SESSION_ID)).length).toBe(0);

    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-search-tasks/${taskId}/approve`,
      headers: { "idempotency-key": newId() }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().registeredSourceIds.length).toBe(2);

    // The candidate became a Source.
    const sources = await evidenceRepository.listSources(SESSION_ID);
    expect(sources.length).toBe(2);
    expect(sources.every((source) => source.createdBy === "human")).toBe(true);

    // The honest line holds: approving never manufactures evidence.
    expect((await evidenceRepository.listEvidence(SESSION_ID)).length).toBe(0);
  });

  it("rejects a completed task without registering any source", async () => {
    const planItemId = await createPlanItem();
    const created = await createSearchTask(planItemId);
    const taskId = created.json().task.id;
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-search-tasks/${taskId}/reject`,
      headers: { "idempotency-key": newId() }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().task.rejectedBy).toBe("Researcher One (researcher)");
    expect((await evidenceRepository.listSources(SESSION_ID)).length).toBe(0);
  });

  it("refuses to approve a failed task (409 invalid_transition)", async () => {
    const planItemId = await createPlanItem();
    const created = await createSearchTask(planItemId, new FailingProvider());
    const taskId = created.json().task.id;
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-search-tasks/${taskId}/approve`,
      headers: { "idempotency-key": newId() }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("invalid_transition");
  });

  it("forbids a viewer from approving (403)", async () => {
    // The task is created and completed by a reviewer; only the approval call
    // runs as a viewer, which must be refused.
    const planItemId = await createPlanItem();
    const created = await createSearchTask(planItemId);
    const taskId = created.json().task.id;
    role = "viewer";
    const response = await testApp().inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/research-search-tasks/${taskId}/approve`,
      headers: { "idempotency-key": newId() }
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("persistence", () => {
  it("task and candidates survive a fresh repository instance", async () => {
    const planItemId = await createPlanItem();
    const created = await createSearchTask(planItemId);
    const taskId = created.json().task.id;

    // A brand-new repository over the same database must see the same data.
    const fresh = new ResearchSearchRepository(database);
    const task = await fresh.getSearchTask(SESSION_ID, taskId);
    expect(task.status).toBe("completed");
    const candidates = await fresh.listCandidates(SESSION_ID, taskId);
    expect(candidates.length).toBe(2);
    expect(candidates[0]!.url).toContain("example.org");
  });

  it("unapproved candidates never reach sources or evidence", async () => {
    const planItemId = await createPlanItem();
    await createSearchTask(planItemId);
    // No approve call was made.
    expect((await evidenceRepository.listSources(SESSION_ID)).length).toBe(0);
    expect((await evidenceRepository.listEvidence(SESSION_ID)).length).toBe(0);
  });
});
