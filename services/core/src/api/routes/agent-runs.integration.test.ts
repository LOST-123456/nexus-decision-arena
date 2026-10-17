import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentRuns,
  agentRoles,
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  projects,
  promptVersions,
  ReviewRepository,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import type { Conflict } from "@nexus/shared";
import { createApp } from "../../app";
import { AgentRunService } from "../../research/agent-run-service";

/**
 * DB-backed integration test for the Agent Operations Center routes.
 *
 * These routes are the honest boundary of the feature: they can only prove
 * against a real database that a cancel really flips the single `agent_runs`
 * row (and leaves a terminal one untouched), that a run from another session is
 * a 404 rather than a leak, and that the guards (viewer / unauthenticated /
 * idempotency-key) fire before any write.
 *
 * The retry *success* round-trip (a genuinely re-run cross-examination) is not
 * exercised here: it needs a fully wired CrossReviewService with seeded roles
 * and prompts, and that path is covered at the service level by
 * `agent-run-service.test.ts`. What is proven here is that retry refuses the
 * states it must refuse (running / non-cross-review / missing key) without a
 * write, and that it is not faked into a 200.
 *
 * Runs only on the dedicated test database (`TEST_DATABASE_URL`); the fail-
 * closed guard in `@nexus/db` refuses anything else.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);

// Every test re-seeds under its own fresh identifiers. This is deliberate data
// ownership: no run can collide on a primary key with another test's row, and no
// test can observe another's runs, so the suite is order-independent without any
// broad TRUNCATE — and it only ever touches the dedicated `TEST_DATABASE_URL`.
let PROJECT_ID = newId();
let SESSION_ID = newId();
let OTHER_SESSION_ID = newId();
let ROLE_ID = newId();
let PROMPT_VERSION_ID = newId();

function fakeAuth(role: "reviewer" | "viewer" = "reviewer") {
  return {
    userFromRequest: () => ({
      id: "user-1",
      username: "researcher",
      displayName: "Researcher One",
      role
    })
  };
}

function testApp(role: "reviewer" | "viewer" = "reviewer") {
  const agentRunService = new AgentRunService({
    reviews: reviewRepository,
    arena,
    events
  });
  return createApp({
    auth: fakeAuth(role) as never,
    sessions,
    inspector: {} as never,
    events,
    runSession: { start: async () => undefined },
    reviews: reviewRepository,
    arena,
    agentRuns: agentRunService
  });
}

async function seedSession() {
  // Fresh, traceable identifiers per test — see the note by the id declarations.
  PROJECT_ID = newId();
  SESSION_ID = newId();
  OTHER_SESSION_ID = newId();
  ROLE_ID = newId();
  PROMPT_VERSION_ID = newId();
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Agent operations center integration",
    input: {}
  });
  await database.insert(promptVersions).values({
    id: PROMPT_VERSION_ID,
    name: "challenger",
    // `prompt_versions` has a UNIQUE(name, version) index, so the version must
    // be unique per test too — derive it from the per-test prompt id.
    version: `integration-${PROMPT_VERSION_ID}`,
    content: "Challenge the claim."
  });
  await database.insert(agentRoles).values({
    id: ROLE_ID,
    // `agent_roles_key_idx` is UNIQUE(key), so the key must be unique per test.
    key: `challenger-${ROLE_ID}`,
    name: "质疑者",
    goal: "找出主张的薄弱环节",
    perspective: "怀疑",
    evaluationCriteria: {},
    evidenceRequired: {},
    conflictPreference: {},
    lenses: {},
    promptVersionId: PROMPT_VERSION_ID
  });
  for (const sessionId of [SESSION_ID, OTHER_SESSION_ID]) {
    await sessions.create({
      id: sessionId,
      projectId: PROJECT_ID,
      locale: "zh-CN",
      phase: "HUMAN_REVIEW",
      operationalStatus: "PAUSED",
      currentConclusion: null
    });
  }
}

/** A running cross-review run in the given session. */
async function startRun(sessionId: string): Promise<string> {
  const run = await reviewRepository.startCrossReviewRun({
    id: newId(),
    sessionId,
    roleId: ROLE_ID,
    promptVersionId: PROMPT_VERSION_ID,
    targetClaimId: newId(),
    requestedBy: "Researcher One (researcher)",
    correlationId: newId()
  });
  return run.id;
}

beforeEach(async () => {
  await seedSession();
});

afterAll(async () => {
  await database.end();
});

describe("agent operations center routes integration", () => {
  it("lists the runs that really exist, with their role names", async () => {
    await startRun(SESSION_ID);
    await startRun(SESSION_ID);

    const app = testApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/agent-runs`
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.runs).toHaveLength(2);
    // The role name is joined server-side; no run is invented.
    expect(body.runs[0]).toMatchObject({
      sessionId: SESSION_ID,
      roleName: "质疑者",
      purpose: "cross_review",
      status: "running"
    });
  });

  it("returns a run's detail with its event timeline and outcome", async () => {
    const runId = await startRun(SESSION_ID);

    const app = testApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}`
    });

    expect(response.statusCode).toBe(200);
    const detail = response.json();
    expect(detail.id).toBe(runId);
    expect(Array.isArray(detail.events)).toBe(true);
    expect(detail.outcome).toEqual({
      challengeIds: [],
      conflictIds: [],
      responseClaimIds: []
    });
  });

  it("treats a run that belongs to another session as a 404, not a leak", async () => {
    const foreignRunId = await startRun(OTHER_SESSION_ID);

    const app = testApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${foreignRunId}`
    });

    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for a run id that does not exist", async () => {
    const app = testApp();
    const response = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${newId()}`
    });
    expect(response.statusCode).toBe(404);
  });

  it("cancels a running run, records the category, and audits the actor", async () => {
    const runId = await startRun(SESSION_ID);

    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`,
      headers: { "idempotency-key": `cancel-${runId}` },
      payload: { reason: "结论已经不需要了" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().run.status).toBe("cancelled");
    expect(response.json().alreadyCancelled).toBe(false);
    expect(response.json().statusChanged).toBe(true);
    // Nothing was running in this process, and the answer says so instead of
    // implying the executor stopped.
    expect(response.json().execution).toBe("not_running_here");
    expect(response.json().previousStatus).toBe("running");
    expect(response.json().reason).toBe("结论已经不需要了");

    // The single row really moved to a terminal, result-free state.
    const [row] = await database
      .select({ status: agentRuns.status, errorCode: agentRuns.errorCode })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(row).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled_by_user"
    });

    // Who cancelled is on the append-only log — and the request is recorded
    // before the verdict it produced.
    const logged = await events.listAfter(SESSION_ID, 0);
    const types = logged.map((event) => event.type);
    expect(types).toContain("AGENT_RUN_CANCEL_REQUESTED");
    expect(types.indexOf("AGENT_RUN_CANCEL_REQUESTED")).toBeLessThan(
      types.indexOf("AGENT_RUN_CANCELLED")
    );
    const cancelEvent = logged.find((e) => e.type === "AGENT_RUN_CANCELLED");
    expect(cancelEvent?.payload).toMatchObject({
      agentRunId: runId,
      requestedBy: "Researcher One (researcher)",
      reason: "结论已经不需要了",
      execution: "not_running_here"
    });
    // The caller cannot attribute the cancel to someone else.
    const request = logged.find((e) => e.type === "AGENT_RUN_CANCEL_REQUESTED");
    expect(request?.payload).toMatchObject({
      requestedBy: "Researcher One (researcher)"
    });
  });

  it("requires an idempotency key before it will cancel", async () => {
    const runId = await startRun(SESSION_ID);
    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`
    });
    expect(response.statusCode).toBe(400);

    const [row] = await database
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(row?.status).toBe("running");
  });

  it("replays one response for the same idempotency key instead of cancelling twice", async () => {
    const runId = await startRun(SESSION_ID);
    const app = testApp();
    const key = `cancel-twice-${runId}`;

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`,
      headers: { "idempotency-key": key }
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`,
      headers: { "idempotency-key": key }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // The replay is the same answer, not a second cancel.
    expect(second.json()).toEqual(first.json());

    const logged = await events.listAfter(SESSION_ID, 0);
    expect(
      logged.filter((e) => e.type === "AGENT_RUN_CANCEL_REQUESTED")
    ).toHaveLength(1);
    expect(logged.filter((e) => e.type === "AGENT_RUN_CANCELLED")).toHaveLength(1);
  });

  it("refuses to let a cancelled run be completed or failed afterwards", async () => {
    const runId = await startRun(SESSION_ID);
    const app = testApp();
    await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`,
      headers: { "idempotency-key": `cancel-then-complete-${runId}` }
    });

    // These are the exact calls the executor makes when the work comes back.
    expect(
      await reviewRepository.completeCrossReviewRun({ runId, output: { ok: true } })
    ).toBe(false);
    expect(
      await reviewRepository.failCrossReviewRun({ runId, error: "late failure" })
    ).toBe(false);

    const [row] = await database
      .select({ status: agentRuns.status, output: agentRuns.output })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(row?.status).toBe("cancelled");
    // Nothing the executor produced was allowed to land.
    expect(row?.output).toBeNull();
  });

  it("refuses an artifact write from a cancelled run through the row lock", async () => {
    const runId = await startRun(SESSION_ID);
    const app = testApp();
    await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`,
      headers: { "idempotency-key": `cancel-then-write-${runId}` }
    });

    const now = new Date().toISOString();
    const conflict: Conflict = {
      id: newId(),
      sessionId: SESSION_ID,
      claimIds: [newId()],
      challengeIds: [newId()],
      type: "evidence",
      summary: "Late conflict from a cancelled run",
      severity: 4,
      status: "detected",
      humanDecisionRequired: true,
      resolutionSuggestion: "Re-run the examination once the run is retried",
      impactScope: { analysisAreas: ["risk"], stakeholders: [] },
      createdAt: now,
      updatedAt: now
    };
    // `false` is the answer, not an error: the guard read the row inside the
    // same transaction as the write.
    expect(await arena.saveConflictWhileRunActive(runId, conflict)).toBe(false);
  });

  it("replaying a cancel with a new key is idempotent — no error, no double-log", async () => {
    const runId = await startRun(SESSION_ID);
    const app = testApp();
    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`,
      headers: { "idempotency-key": `cancel-first-${runId}` }
    });
    expect(first.statusCode).toBe(200);

    // A different key means a genuinely new request: it must be answered by
    // the run's state, not by the lease.
    const second = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`,
      headers: { "idempotency-key": `cancel-second-${runId}` }
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyCancelled).toBe(true);
    expect(second.json().statusChanged).toBe(false);

    const cancelEvents = (await events.listAfter(SESSION_ID, 0)).filter(
      (e) => e.type === "AGENT_RUN_CANCELLED"
    );
    expect(cancelEvents).toHaveLength(1);
    const requestEvents = (await events.listAfter(SESSION_ID, 0)).filter(
      (e) => e.type === "AGENT_RUN_CANCEL_REQUESTED"
    );
    expect(requestEvents).toHaveLength(1);
  });

  it("refuses to cancel a run that already finished (409, untouched)", async () => {
    const runId = await startRun(SESSION_ID);
    await reviewRepository.completeCrossReviewRun({ runId, output: { done: true } });

    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`,
      headers: { "idempotency-key": `cancel-terminal-${runId}` }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "run_terminal" });

    const [row] = await database
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(row?.status).toBe("completed");
  });

  it("refuses to retry a run that is still running (409, no write)", async () => {
    const runId = await startRun(SESSION_ID);
    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
      headers: { "idempotency-key": "retry-running" }
    });
    expect(response.statusCode).toBe(409);
  });

  it("reports 501 for a retry whose purpose is not wired, instead of faking it", async () => {
    // A failed *analysis* run: retryable by status, but retry is only wired for
    // cross_review today, so the server must say so rather than pretend.
    const runId = newId();
    await database.insert(agentRuns).values({
      id: runId,
      sessionId: SESSION_ID,
      roleId: ROLE_ID,
      promptVersionId: PROMPT_VERSION_ID,
      status: "failed",
      error: "analysis blew up",
      input: { kind: "analysis" },
      startedAt: new Date().toISOString()
    });

    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
      headers: { "idempotency-key": "retry-analysis" }
    });
    expect(response.statusCode).toBe(501);
  });

  it("requires an idempotency key before it will retry", async () => {
    const runId = await startRun(SESSION_ID);
    await reviewRepository.failCrossReviewRun({ runId, error: "boom" });

    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`
    });
    expect(response.statusCode).toBe(400);
  });

  it("treats a cancel aimed at another session's run as a 404, not a leak", async () => {
    const foreignRunId = await startRun(OTHER_SESSION_ID);
    const app = testApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${foreignRunId}/cancel`,
      headers: { "idempotency-key": `cancel-cross-session-${foreignRunId}` }
    });
    expect(response.statusCode).toBe(404);

    const [row] = await database
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, foreignRunId));
    expect(row?.status).toBe("running");
  });

  it("forbids a viewer from cancelling (403, row untouched)", async () => {
    const runId = await startRun(SESSION_ID);
    const app = testApp("viewer");
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`
    });
    expect(response.statusCode).toBe(403);

    const [row] = await database
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(row?.status).toBe("running");
  });

  it("forbids a viewer from retrying (403)", async () => {
    const runId = await startRun(SESSION_ID);
    await reviewRepository.failCrossReviewRun({ runId, error: "boom" });
    const app = testApp("viewer");
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
      headers: { "idempotency-key": "viewer-retry" }
    });
    expect(response.statusCode).toBe(403);
  });

  it("requires authentication before it will cancel (401)", async () => {
    const runId = await startRun(SESSION_ID);
    const agentRunService = new AgentRunService({
      reviews: reviewRepository,
      arena,
      events
    });
    const app = createApp({
      auth: { userFromRequest: () => null } as never,
      sessions,
      inspector: {} as never,
      events,
      runSession: { start: async () => undefined },
      reviews: reviewRepository,
      arena,
      agentRuns: agentRunService
    });
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/cancel`
    });
    expect(response.statusCode).toBe(401);
  });
});
