import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ArenaRepository,
  createTestDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  projects,
  RevalidationTaskRepository,
  ReviewRepository,
  SourceCheckRepository,
  SourceFileRepository,
  type Database
} from "@nexus/db";
import { newId, type RevalidationTask, type SourceCheckOutcome } from "@nexus/shared";
import { createApp } from "../../app";
import type { FetchedPage } from "../../research/page-fetch";
import { ResearchWorkspaceService } from "../../research/workspace-service";
import { SourceMonitorService } from "../../research/source-monitor-service";

/**
 * DB-backed integration test for the source-monitoring routes.
 *
 * What only a real database and the real HTTP stack can prove:
 *  1. a check that finds nothing stores no second version and opens no work;
 *  2. a check that finds drift keeps the old capture, stores the new one,
 *     derives which excerpts and claims it reaches, and opens exactly one
 *     re-check task — while every verification status stays exactly as the
 *     researcher left it;
 *  3. a repeated check is the same check (idempotency), and a version that
 *     keeps moving does not multiply reminders;
 *  4. closing a task needs a reason, and the reason, the actor and the whole
 *     transition history survive;
 *  5. the access rules: a viewer may read but not write, an anonymous request
 *     is refused, and another session's material answers 404.
 *
 * The page fetcher is faked — no network is involved. The database is the
 * dedicated test database named by TEST_DATABASE_URL; the guard refuses
 * anything else.
 */
const database: Database = createTestDatabase();
const sessions = new DecisionSessionRepository(database);
const arena = new ArenaRepository(database);
const evidenceRepository = new EvidenceRepository(database);
const reviewRepository = new ReviewRepository(database);
const events = new EventRepository(database);
const checkRepository = new SourceCheckRepository(database);
const taskRepository = new RevalidationTaskRepository(database);

const OLD_TEXT = [
  "国家统计局发布上半年经济数据。",
  "出口连续三个季度下滑，制造业投资增速回落至 4.2%。",
  "分析人士认为外部需求仍然疲软。"
].join("\n");

// The revised page: one number moves and one sentence disappears, which is
// what makes the anchored excerpt unfindable rather than merely relocated.
const NEW_TEXT = [
  "国家统计局发布上半年经济数据（修订版）。",
  "出口连续三个季度下滑，制造业投资增速回升至 5.6%。"
].join("\n");

const ANCHOR = "出口连续三个季度下滑，制造业投资增速回落至 4.2%。";

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The page the fake fetcher hands back; each test points it where it wants. */
let fetched: FetchedPage = pageFor(OLD_TEXT);
const fetchCalls: string[] = [];

function pageFor(content: string): FetchedPage {
  return {
    requestedUrl: "https://example.test/page",
    finalUrl: "https://example.test/page",
    canonicalUrl: "https://example.test/page",
    status: 200,
    contentType: "text/html",
    contentEncoding: null,
    content,
    contentHash: hashOf(content),
    wireBytes: content.length,
    contentBytes: content.length,
    charCount: content.length,
    title: "季度回顾",
    author: null,
    publisher: null,
    publishedAt: null,
    retrievedAt: new Date().toISOString(),
    redirects: [],
    truncated: false
  };
}

const PROJECT_ID = newId();
const SESSION_ID = newId();
const CLAIM_ID = newId();
const SOURCE_ID = newId();
const EVIDENCE_ID = newId();

// The same projection the workspace UI reads, wired to the same repositories,
// so a claim impact computed here cannot disagree with what the map shows.
const workspaceService = new ResearchWorkspaceService({
  evidence: evidenceRepository,
  arena,
  reviews: reviewRepository,
  getSession: async (sessionId) => {
    const session = await sessions.getById(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      phase: session.phase,
      operationalStatus: session.operationalStatus,
      researchQuestion: session.researchQuestion ?? null,
      currentConclusion: session.currentConclusion ?? null
    };
  }
});

const monitorService = new SourceMonitorService({
  evidence: evidenceRepository,
  checks: checkRepository,
  tasks: taskRepository,
  files: new SourceFileRepository(database),
  fetch: async (url) => {
    fetchCalls.push(url);
    return fetched;
  },
  workspace: async (sessionId) => {
    const workspace = await workspaceService.getWorkspace(sessionId);
    if (!workspace) return null;
    return { claims: workspace.claims, verdicts: workspace.verdicts };
  },
  appendEvent: (input) => events.append(input)
});

let role: "owner" | "reviewer" | "viewer" = "reviewer";
let authEnabled = true;

// One app for the whole file: the idempotency store lives on the instance,
// so a replay is only a replay when both requests share it. The fake auth is
// a closure over the mutable role above, so per-test role changes still take
// effect on this same instance.
const app = createApp({
  auth: {
    userFromRequest: () =>
      authEnabled
        ? {
            id: "user-1",
            username: "researcher",
            displayName: "Researcher One",
            role
          }
        : null
  } as never,
  sessions,
  inspector: {} as never,
  events,
  runSession: { start: async () => undefined },
  evidence: evidenceRepository,
  reviews: reviewRepository,
  arena,
  sourceMonitor: monitorService
});

async function seed(): Promise<void> {
  await database.execute("TRUNCATE projects CASCADE");
  const timestamp = new Date().toISOString();
  await database.insert(projects).values({
    id: PROJECT_ID,
    name: "Source monitoring integration",
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
      statement: "制造业投资增速回落至 4.2%。",
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
  await evidenceRepository.createSource(
    {
      id: SOURCE_ID,
      sessionId: SESSION_ID,
      title: "季度回顾",
      kind: "url",
      url: "https://example.test/page",
      canonicalUrl: "https://example.test/page",
      createdBy: "human",
      createdAt: timestamp,
      updatedAt: timestamp
    },
    {
      correlationId: SOURCE_ID,
      type: "SOURCE_REGISTERED",
      payload: { sourceId: SOURCE_ID }
    }
  );
  await evidenceRepository.recordRetrievalSuccess({
    snapshot: {
      id: newId(),
      sessionId: SESSION_ID,
      sourceId: SOURCE_ID,
      canonicalUrl: "https://example.test/page",
      contentHash: hashOf(OLD_TEXT),
      contentType: "text/html; charset=utf-8",
      content: OLD_TEXT,
      contentBytes: OLD_TEXT.length,
      charCount: OLD_TEXT.length,
      retrievedAt: timestamp,
      createdAt: timestamp
    },
    source: {},
    event: {
      correlationId: SOURCE_ID,
      type: "SOURCE_RETRIEVED",
      payload: { sourceId: SOURCE_ID }
    }
  });
  // A verified excerpt anchored into the stored version: the whole point of
  // monitoring is that this row must survive a source change untouched.
  await evidenceRepository.createEvidence({
    evidence: {
      id: EVIDENCE_ID,
      sessionId: SESSION_ID,
      claimIds: [CLAIM_ID],
      kind: "external_reference",
      title: "摘录：制造业投资增速",
      content: ANCHOR,
      description: "工作台摘录",
      sourceId: SOURCE_ID,
      direction: "supports",
      reliability: 0.8,
      verificationStatus: "verified",
      verifiedBy: "复核员 (reviewer)",
      verificationNote: "与原文一致",
      locatorStatus: "anchored",
      locator: "第 2 段",
      anchorText: ANCHOR,
      sourceContentHash: hashOf(OLD_TEXT),
      retrievedAt: timestamp,
      createdBy: "human"
    },
    event: {
      correlationId: EVIDENCE_ID,
      type: "EVIDENCE_RECORDED",
      payload: { evidenceId: EVIDENCE_ID }
    }
  });
}

beforeEach(async () => {
  role = "reviewer";
  authEnabled = true;
  fetched = pageFor(OLD_TEXT);
  fetchCalls.length = 0;
  await seed();
});

afterAll(async () => {
  await database.execute("TRUNCATE projects CASCADE");
});

function checkUrl(sessionId = SESSION_ID, sourceId = SOURCE_ID): string {
  return `/api/sessions/${sessionId}/sources/${sourceId}/check`;
}

async function checkSource(
  sessionId = SESSION_ID,
  sourceId = SOURCE_ID,
  key: string = newId()
): Promise<{ status: number; body: SourceCheckOutcome }> {
  const response = await app.inject({
    method: "POST",
    url: checkUrl(sessionId, sourceId),
    headers: { "idempotency-key": key }
  });
  return { status: response.statusCode, body: response.json() as SourceCheckOutcome };
}

/**
 * The task a changed check opened.
 *
 * Fails loudly rather than quietly when a check that should have opened work
 * did not: every caller has already asserted the status is `changed`.
 */
function openedTask(body: SourceCheckOutcome): RevalidationTask {
  if (!body.revalidationTask) {
    throw new Error("expected this check to open a revalidation task");
  }
  return body.revalidationTask;
}

describe("checks", () => {
  it("records an unchanged check and stores no second version", async () => {
    const result = await checkSource();

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("unchanged");
    expect(result.body.newVersionStored).toBe(false);
    expect(result.body.currentContentHash).toBe(hashOf(OLD_TEXT));
    expect(result.body.evidenceImpacts).toEqual([]);
    expect(result.body.revalidationTask).toBeNull();
    expect(fetchCalls).toHaveLength(1);

    // The same version is not stored twice, and no work was opened.
    const snapshots = await evidenceRepository.listSnapshots(
      SESSION_ID,
      SOURCE_ID
    );
    expect(snapshots).toHaveLength(1);
    expect(await taskRepository.listTasks(SESSION_ID)).toHaveLength(0);

    const monitoring = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/${SOURCE_ID}/monitoring`
    });
    expect(monitoring.statusCode).toBe(200);
    const summary = monitoring.json();
    expect(summary.monitorStatus).toBe("unchanged");
    expect(summary.snapshotCount).toBe(1);
    expect(summary.lastCheckedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(summary.openTaskId).toBeNull();
  });

  it("stores the new version, derives what it reaches and opens one task", async () => {
    fetched = pageFor(NEW_TEXT);
    const result = await checkSource();

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("changed");
    expect(result.body.newVersionStored).toBe(true);
    expect(result.body.previousContentHash).toBe(hashOf(OLD_TEXT));
    expect(result.body.currentContentHash).toBe(hashOf(NEW_TEXT));

    // The excerpt anchored into the old text is gone from the new one, and
    // the claim that leans on it is named — without either being rewritten.
    const impacts = result.body.evidenceImpacts;
    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.impact).toBe("anchor_missing");
    expect(impacts[0]?.verificationStatus).toBe("verified");
    expect(result.body.claimImpacts.map((item: { claimId: string }) => item.claimId)).toEqual([
      CLAIM_ID
    ]);

    const task = openedTask(result.body);
    expect(task.status).toBe("open");
    expect(task.affectedEvidenceIds).toEqual([EVIDENCE_ID]);
    expect(task.affectedClaimIds).toEqual([CLAIM_ID]);
    expect(task.triggerContentHash).toBe(hashOf(NEW_TEXT));

    // Both versions are on the record, and the older text is untouched.
    const snapshots = await evidenceRepository.listSnapshots(
      SESSION_ID,
      SOURCE_ID
    );
    expect(snapshots).toHaveLength(2);
    const older = snapshots.find(
      (item) => item.contentHash === hashOf(OLD_TEXT)
    );
    expect(older?.content).toBe(OLD_TEXT);

    // The verified excerpt is still verified, still anchored, still quoting
    // the version it was confirmed against: the change is reported, never
    // applied to the researcher's decision.
    const [excerpt] = await evidenceRepository.listEvidenceForSource(
      SESSION_ID,
      SOURCE_ID
    );
    expect(excerpt?.verificationStatus).toBe("verified");
    expect(excerpt?.verifiedBy).toBe("复核员 (reviewer)");
    expect(excerpt?.locatorStatus).toBe("anchored");
    expect(excerpt?.sourceContentHash).toBe(hashOf(OLD_TEXT));

    // The task is readable through its own endpoint, with its history.
    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/revalidation-tasks/${task.id}`
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().task.id).toBe(task.id);
    expect(detail.json().history).toHaveLength(1);
    expect(detail.json().history[0].toStatus).toBe("open");
    expect(detail.json().evidence.map((item: { id: string }) => item.id)).toEqual([
      EVIDENCE_ID
    ]);
    expect(detail.json().claims.map((item: { id: string }) => item.id)).toEqual([
      CLAIM_ID
    ]);

    // The audit trail names the drift, the stored version and the task.
    const trail = (await events.listAfter(SESSION_ID, 0)).map(
      (event) => event.type
    );
    expect(trail).toContain("SOURCE_CHECK_STARTED");
    expect(trail).toContain("SOURCE_CONTENT_CHANGED");
    expect(trail).toContain("REVALIDATION_TASK_CREATED");

    // And the diff between the two versions is readable.
    const diff = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/${SOURCE_ID}/diff`
    });
    expect(diff.statusCode).toBe(200);
    expect(diff.json().previousContentHash).toBe(hashOf(OLD_TEXT));
    expect(diff.json().currentContentHash).toBe(hashOf(NEW_TEXT));
    expect(diff.json().segments.some(
      (segment: { kind: string; text: string }) =>
        segment.kind === "removed" && segment.text.includes(ANCHOR)
    )).toBe(true);
    expect(
      diff.json().missingExcerpts.map(
        (item: { evidenceId: string }) => item.evidenceId
      )
    ).toContain(EVIDENCE_ID);
  });

  it("replays a repeated check instead of spending the budget twice", async () => {
    fetched = pageFor(NEW_TEXT);
    const key = newId();
    const first = await checkSource(SESSION_ID, SOURCE_ID, key);
    const second = await checkSource(SESSION_ID, SOURCE_ID, key);

    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    // One page read, one check row, one task: a double submit is the same
    // check, not a second one.
    expect(fetchCalls).toHaveLength(1);
    expect(await checkRepository.listChecks(SESSION_ID, SOURCE_ID)).toHaveLength(1);
    expect(await taskRepository.listTasks(SESSION_ID)).toHaveLength(1);
  });

  it("does not open a second reminder when the same version moves again", async () => {
    // Drift to the revised page, then back to a version that was already
    // captured, then to that same version once more: the reminder for a
    // version is opened once, however often the page returns to it.
    fetched = pageFor(NEW_TEXT);
    const first = await checkSource();
    const firstTaskId = openedTask(first.body).id;

    fetched = pageFor(OLD_TEXT);
    const back = await checkSource();
    expect(back.body.status).toBe("changed");
    const backTaskId = openedTask(back.body).id;
    expect(backTaskId).not.toBe(firstTaskId);

    const again = await checkSource();
    expect(openedTask(again.body).id).toBe(backTaskId);

    const tasks = await taskRepository.listTasks(SESSION_ID);
    expect(tasks).toHaveLength(2);
    expect(fetchCalls).toHaveLength(3);
  });

  it("says a manual source cannot be monitored instead of pretending", async () => {
  const manualId = newId();
  await evidenceRepository.createSource(
    {
      id: manualId,
      sessionId: SESSION_ID,
      title: "会议纪要",
      kind: "manual",
      createdBy: "human",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      correlationId: manualId,
      type: "SOURCE_REGISTERED",
      payload: { sourceId: manualId }
    }
  );

    const result = await checkSource(SESSION_ID, manualId);

    expect(result.status).toBe(200);
    expect(result.body.status).toBe("unavailable");
    expect(result.body.reasonCode).toBe("not_monitorable");
    // Nothing was fetched, and nothing was recorded as a change.
    expect(fetchCalls).toHaveLength(0);
    expect(await taskRepository.listTasks(SESSION_ID)).toHaveLength(0);
  });
});

describe("revalidation tasks", () => {
  async function openTask(): Promise<string> {
    fetched = pageFor(NEW_TEXT);
    const result = await checkSource();
    return openedTask(result.body).id;
  }

  it("closes a task with a reason and keeps the whole history", async () => {
    const taskId = await openTask();

    const withoutReason = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/revalidation-tasks/${taskId}/resolve`,
      headers: { "idempotency-key": newId() },
      payload: { status: "resolved" }
    });
    expect(withoutReason.statusCode).toBe(400);

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/revalidation-tasks/${taskId}/resolve`,
      headers: { "idempotency-key": newId() },
      payload: { status: "resolved", note: "已联系编辑确认修订原因，结论仍成立。" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("resolved");

    // The closure is persisted with its reason and its author, and the
    // transition is appended rather than overwriting the opening.
    const stored = await taskRepository.getTask(SESSION_ID, taskId);
    expect(stored.status).toBe("resolved");
    expect(stored.resolutionNote).toBe("已联系编辑确认修订原因，结论仍成立。");
    expect(stored.resolvedBy).toBe("Researcher One (researcher)");
    expect(stored.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const history = await taskRepository.listTaskHistory(SESSION_ID, taskId);
    expect(history.map((event) => event.toStatus)).toEqual([
      "resolved",
      "open"
    ]);
    expect(history[0]?.note).toBe("已联系编辑确认修订原因，结论仍成立。");
    expect(history[0]?.actor).toBe("Researcher One (researcher)");

    const trail = (await events.listAfter(SESSION_ID, 0)).map(
      (event) => event.type
    );
    expect(trail).toContain("REVALIDATION_TASK_RESOLVED");
  });

  it("keeps the evidence and the claim untouched when the task is dismissed", async () => {
    const taskId = await openTask();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${SESSION_ID}/revalidation-tasks/${taskId}/resolve`,
      headers: { "idempotency-key": newId() },
      payload: { status: "dismissed", note: "该页面为定期修订的数据发布，数字变化属预期。" }
    });
    expect(response.statusCode).toBe(200);

    const [excerpt] = await evidenceRepository.listEvidenceForSource(
      SESSION_ID,
      SOURCE_ID
    );
    expect(excerpt?.verificationStatus).toBe("verified");
    expect(excerpt?.locatorStatus).toBe("anchored");
  });
});

describe("access", () => {
  it("refuses a viewer's write but allows the reads", async () => {
    role = "viewer";

    const monitoring = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/${SOURCE_ID}/monitoring`
    });
    expect(monitoring.statusCode).toBe(200);

    const tasks = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/revalidation-tasks`
    });
    expect(tasks.statusCode).toBe(200);

    const check = await app.inject({
      method: "POST",
      url: checkUrl(),
      headers: { "idempotency-key": newId() }
    });
    expect(check.statusCode).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it("requires authentication", async () => {
    authEnabled = false;

    const monitoring = await app.inject({
      method: "GET",
      url: `/api/sessions/${SESSION_ID}/sources/${SOURCE_ID}/monitoring`
    });
    expect(monitoring.statusCode).toBe(401);

    const check = await app.inject({
      method: "POST",
      url: checkUrl(),
      headers: { "idempotency-key": newId() }
    });
    expect(check.statusCode).toBe(401);
  });

  it("treats another session's source and task as absent", async () => {
    const otherSession = newId();
    const monitoring = await app.inject({
      method: "GET",
      url: `/api/sessions/${otherSession}/sources/${SOURCE_ID}/monitoring`
    });
    expect(monitoring.statusCode).toBe(404);

    const check = await checkSource(otherSession, SOURCE_ID);
    expect(check.status).toBe(404);

    fetched = pageFor(NEW_TEXT);
    const opened = await checkSource();
    const taskId = openedTask(opened.body).id;
    const foreign = await app.inject({
      method: "GET",
      url: `/api/sessions/${otherSession}/revalidation-tasks/${taskId}`
    });
    expect(foreign.statusCode).toBe(404);
  });
});
