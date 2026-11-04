import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentRuns,
  agentRoles,
  ArenaRepository,
  claims,
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
import { CrossReviewService } from "../../research/cross-review-service";
import { RunCancellationRegistry } from "../../research/run-cancellation";
import { EventBus } from "../../execution/event-bus";

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
      currentConclusion: null,
      // The research belongs to the signed-in reviewer: access is decided from
      // the recorded owner, never from the request.
      ownerUserId: "user-1"
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

/**
 * Retry against a real generation, a real database and a real idempotency
 * lease.
 *
 * The cross-examination engine is replaced by one that produces nothing: what
 * is under test here is the *run ledger* — that the lineage is written before
 * execution, that the budget is the database's, and that a replay cannot open a
 * second generation. The provider path is a different question, covered by the
 * unit tests of the engine and by E2E.
 */
describe("agent retry · lineage through the API", () => {
  async function seedClaimRow(sessionId: string): Promise<string> {
    const claimId = newId();
    const now = new Date().toISOString();
    await database.insert(claims).values({
      id: claimId,
      sessionId,
      // Human-authored: no role, which is also why this claim can be challenged
      // by every seeded role.
      lens: "research",
      statement: "Shipments grew 12% year over year.",
      type: "fact",
      stance: "support",
      importance: 4,
      confidence: 0.5,
      evidenceIds: [],
      status: "proposed",
      rootClaimId: claimId,
      revision: 1,
      relations: [],
      createdAt: now,
      updatedAt: now
    } as never);
    return claimId;
  }

  /**
   * The challenger roster for the retry path.
   *
   * Deliberately structural rather than read back through `getRunContext`: the
   * fixture roles this file seeds carry per-test keys (the key column is
   * unique), which the domain schema rightly refuses. Challenger selection only
   * needs id, key and prompt version, so that is all this supplies.
   */
  /**
   * Evaluated per call, never captured once: `ROLE_ID` / `PROMPT_VERSION_ID`
   * are reseeded in every `beforeEach`, so a constant here would point at a
   * role and prompt version that no longer exist (foreign key 23503).
   */
  function challengerRole() {
    return {
      id: ROLE_ID,
      key: "risk_auditor",
      name: "质疑者",
      goal: "找出主张的薄弱环节",
      perspective: "怀疑",
      evaluationCriteria: ["证据是否充分"],
      evidenceRequired: ["可定位的引用"],
      conflictPreference: ["优先暴露冲突"],
      lenses: ["风险"],
      promptVersionId: PROMPT_VERSION_ID
    };
  }

  function retryApp(role: "reviewer" | "viewer" = "reviewer") {
    const cancellations = new RunCancellationRegistry();
    const crossReview = new CrossReviewService({
      readArtifacts: (sessionId) => arena.getSessionArtifacts(sessionId),
      readRoles: async () => [challengerRole() as never],
      runs: reviewRepository,
      arena,
      cancellations,
      getClaimValidationContext: (claimId) =>
        arena.getClaimValidationContext(claimId),
      // No provider call: this path is about the ledger, not the model.
      crossExamination: () => ({
        run: async () => ({ challenges: [], responseClaims: [], conflicts: [] })
      }),
      appendEvent: (input) => events.append(input),
      eventBus: new EventBus(),
      maxChallengers: 1
    });
    const agentRunService = new AgentRunService({
      reviews: reviewRepository,
      arena,
      events,
      cancellations,
      crossReview
    });
    const app = createApp({
      auth: fakeAuth(role) as never,
      sessions,
      inspector: {} as never,
      events,
      runSession: { start: async () => undefined },
      reviews: reviewRepository,
      arena,
      crossReview,
      agentRuns: agentRunService
    });
    return { app, crossReview, cancellations };
  }

  /** A failed cross-review run aimed at a claim that really exists. */
  async function failedRunOnRealClaim(): Promise<{
    runId: string;
    claimId: string;
  }> {
    const claimId = await seedClaimRow(SESSION_ID);
    const [run] = await reviewRepository.startCrossReviewRuns([
      {
        id: newId(),
        sessionId: SESSION_ID,
        roleId: ROLE_ID,
        promptVersionId: PROMPT_VERSION_ID,
        targetClaimId: claimId,
        requestedBy: "Researcher One (researcher)",
        correlationId: newId()
      }
    ]);
    await reviewRepository.failCrossReviewRun({
      runId: run!.id,
      error: "provider down"
    });
    return { runId: run!.id, claimId };
  }

  it("opens the next generation with its lineage already written", async () => {
    const { runId, claimId } = await failedRunOnRealClaim();
    const { app } = retryApp();

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
      headers: { "idempotency-key": "retry-lineage" }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      retry: { originalRunId: string; attempt: number; runIds: string[] };
      runs: Array<{ status: string }>;
    };
    expect(body.retry.originalRunId).toBe(runId);
    expect(body.retry.attempt).toBe(2);
    expect(body.retry.runIds).toHaveLength(1);

    const [child] = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, body.retry.runIds[0]!));
    expect(child?.attempt).toBe(2);
    expect(child?.parentRunId).toBe(runId);
    expect(child?.input).toMatchObject({ targetClaimId: claimId });

    // The original run is untouched: a retry never rewrites history.
    const [original] = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId));
    expect(original?.status).toBe("failed");
    expect(original?.attempt).toBe(1);
    expect(original?.parentRunId).toBeNull();
  });

  it("records request and creation on the retried run's timeline", async () => {
    const { runId } = await failedRunOnRealClaim();
    const { app } = retryApp();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
      headers: { "idempotency-key": "retry-audit" }
    });

    const timeline = await reviewRepository.listAgentRunEvents(SESSION_ID, runId);
    const types = timeline.map((event) => event.type);
    expect(types).toContain("AGENT_RUN_RETRY_REQUESTED");
    expect(types).toContain("AGENT_RUN_RETRY_CREATED");
    // Order is the fact: the request exists before the run does.
    expect(types.indexOf("AGENT_RUN_RETRY_REQUESTED")).toBeLessThan(
      types.indexOf("AGENT_RUN_RETRY_CREATED")
    );
    const created = timeline.find(
      (event) => event.type === "AGENT_RUN_RETRY_CREATED"
    );
    expect(created?.payload).toMatchObject({ originalRunId: runId, attempt: 2 });
  });

  it("replays the same idempotency key without opening a second generation", async () => {
    const { runId } = await failedRunOnRealClaim();
    const { app } = retryApp();
    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
        headers: { "idempotency-key": "retry-replay" }
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());

    const runs = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.sessionId, SESSION_ID));
    expect(runs).toHaveLength(2); // the failed root + exactly one replacement
    const timeline = await reviewRepository.listAgentRunEvents(SESSION_ID, runId);
    expect(
      timeline.filter((event) => event.type === "AGENT_RUN_RETRY_CREATED")
    ).toHaveLength(1);
  });

  it("refuses the same key with a different request", async () => {
    const first = await failedRunOnRealClaim();
    const second = await failedRunOnRealClaim();
    const { app } = retryApp();

    await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${first.runId}/retry`,
      headers: { "idempotency-key": "retry-collide" }
    });
    const conflict = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${second.runId}/retry`,
      headers: { "idempotency-key": "retry-collide" }
    });

    expect(conflict.statusCode).toBe(409);
    // The second run was never retried.
    const runs = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.parentRunId, second.runId));
    expect(runs).toHaveLength(0);
  });

  it("takes one winner when two retries of the same run race", async () => {
    const { runId } = await failedRunOnRealClaim();
    const { app } = retryApp();
    const send = (key: string) =>
      app.inject({
        method: "POST",
        url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
        headers: { "idempotency-key": key }
      });

    const [a, b] = await Promise.all([send("retry-race-a"), send("retry-race-b")]);
    const codes = [a.statusCode, b.statusCode].sort();

    // One opens the generation; the other is refused — either because a run for
    // the claim is still in progress or because the chain already moved on.
    // Neither case may produce a second child.
    expect(codes).toEqual([201, 409]);
    const children = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.parentRunId, runId));
    expect(children).toHaveLength(1);
  });

  it("refuses a retry of a run the chain has already moved past", async () => {
    const { runId } = await failedRunOnRealClaim();
    const { app } = retryApp();

    // First retry succeeds; its child is then failed too, so the chain's deepest
    // attempt is 2 while the root still reads "failed, attempt 1".
    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
      headers: { "idempotency-key": "retry-tip-1" }
    });
    expect(first.statusCode).toBe(201);

    const again = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
      headers: { "idempotency-key": "retry-tip-2" }
    });

    expect(again.statusCode).toBe(409);
    const body = again.json() as { code: string; childRunId: string | null };
    expect(body.code).toBe("already_retried");
    expect(typeof body.childRunId).toBe("string");
  });

  it("refuses a retry aimed at another session's run (404)", async () => {
    const foreignClaim = await seedClaimRow(OTHER_SESSION_ID);
    const [foreign] = await reviewRepository.startCrossReviewRuns([
      {
        id: newId(),
        sessionId: OTHER_SESSION_ID,
        roleId: ROLE_ID,
        promptVersionId: PROMPT_VERSION_ID,
        targetClaimId: foreignClaim,
        requestedBy: "Researcher One (researcher)",
        correlationId: newId()
      }
    ]);
    await reviewRepository.failCrossReviewRun({
      runId: foreign!.id,
      error: "provider down"
    });

    const { app } = retryApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${foreign!.id}/retry`,
      headers: { "idempotency-key": "retry-foreign" }
    });

    expect(response.statusCode).toBe(404);
    const children = await database
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.parentRunId, foreign!.id));
    expect(children).toHaveLength(0);
  });

  it("refuses a retry of a completed run with a machine-readable code", async () => {
    const { runId } = await failedRunOnRealClaim();
    await database
      .update(agentRuns)
      .set({ status: "completed" })
      .where(eq(agentRuns.id, runId));

    const { app } = retryApp();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/agent-runs/${runId}/retry`,
      headers: { "idempotency-key": "retry-completed" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "run_not_retryable" });
  });
});
