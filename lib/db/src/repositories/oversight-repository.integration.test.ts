import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { runMigrations } from "../migrate";
import {
  assertDisposableDatabaseName,
  createTestAdminDatabase,
  createTestDatabaseForUrl,
  resolveTestDatabaseUrl
} from "../testing/test-database";
import { loadOversightCounts } from "./oversight-repository";
import {
  agentRoles,
  agentRuns,
  conflicts,
  decisionSessions,
  humanDecisions,
  projects,
  promptVersions
} from "../schema";

/**
 * 「人有没有真的在把关」这几个计数，只有真库能证明。
 *
 * 三个理由，都是 mock 会替人圆过去的：
 *
 *  1. **`count(*) filter (where …)` 是原生 SQL 片段。** 拼错一个谓词，mock
 *     里仍然返回我写死的数字；真库才会告诉我它到底数了几行。
 *  2. **`inArray` 绑定数组。** 这个仓库历史上最高频的 500 就在这里 ——
 *     `sql` 模板不会把 JS 数组展开成参数。空数组更要在进查询前早退，
 *     否则 `IN ()` 直接是语法错误。
 *  3. **`bigint` 回来是字符串。** `count(*)` 经驱动是 string，不 `mapWith(Number)`
 *     就会把 `"3"` 一路传到界面上当数字用。
 *
 * 只跑专用测试库：`TEST_DATABASE_URL` 缺失或指向不安全目标时，守卫在建连之前
 * 就抛错。
 */
const databaseUrl = resolveTestDatabaseUrl().toString();
const admin = createTestAdminDatabase();
const createdDatabases: string[] = [];

const tempDatabaseUrl = (databaseName: string) => {
  assertDisposableDatabaseName(databaseName);
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

afterAll(async () => {
  for (const databaseName of createdDatabases) {
    await admin.execute(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`
    );
  }
  await admin.end();
});

type TestDatabase = ReturnType<typeof createTestDatabaseForUrl>;

let database: TestDatabase;
let promptVersionId: string;
let roleId: string;

beforeAll(async () => {
  const name = `nexus_test_oversight_${Date.now().toString(36)}`;
  await admin.execute(`CREATE DATABASE "${name}"`);
  createdDatabases.push(name);
  database = createTestDatabaseForUrl(tempDatabaseUrl(name));
  await runMigrations(database);

  // One prompt version and one role are shared by every run this file seeds;
  // only the runs themselves differ between cases.
  promptVersionId = newId();
  roleId = newId();
  await database.insert(promptVersions).values({
    id: promptVersionId,
    name: "analyst",
    version: "1",
    content: "Analyze the project."
  });
  await database.insert(agentRoles).values({
    id: roleId,
    key: "market_analyst",
    name: "Market Analyst",
    goal: "Analyze",
    perspective: "Evidence",
    evaluationCriteria: ["evidence"],
    evidenceRequired: ["source"],
    conflictPreference: ["evidence_gap"],
    lenses: ["market"],
    promptVersionId
  });
}, 180_000);

async function seedSession(): Promise<string> {
  const projectId = newId();
  const sessionId = newId();
  await database.insert(projects).values({
    id: projectId,
    name: "Oversight fixture",
    input: {}
  });
  await database.insert(decisionSessions).values({
    id: sessionId,
    projectId,
    locale: "zh-CN",
    phase: "CREATED",
    operationalStatus: "ACTIVE",
    currentConclusion: null
  });
  return sessionId;
}

async function seedConflict(options: {
  sessionId: string;
  status: "detected" | "human_review" | "resolved";
  humanDecisionRequired: boolean;
}): Promise<string> {
  const id = newId();
  await database.insert(conflicts).values({
    id,
    sessionId: options.sessionId,
    claimIds: [],
    challengeIds: [],
    type: "evidence",
    summary: "fixture conflict",
    severity: 4,
    status: options.status,
    humanDecisionRequired: options.humanDecisionRequired,
    resolutionSuggestion: "look again",
    impactScope: []
  });
  return id;
}

async function seedDecision(options: {
  sessionId: string;
  conflictId: string;
  action: "accept_challenge" | "uphold_claim" | "request_more_analysis";
}): Promise<void> {
  await database.insert(humanDecisions).values({
    id: newId(),
    sessionId: options.sessionId,
    conflictId: options.conflictId,
    action: options.action,
    rationale: "because",
    affectedClaimIds: [],
    affectedAgentRoleIds: [],
    previousConclusion: "before",
    newConclusion: "after",
    operatorId: "user-1"
  });
}

async function seedRun(options: {
  sessionId: string;
  status: "completed" | "failed" | "timed_out" | "cancelled" | "running";
  attempt?: number;
}): Promise<void> {
  await database.insert(agentRuns).values({
    id: newId(),
    sessionId: options.sessionId,
    roleId,
    promptVersionId,
    status: options.status,
    attempt: options.attempt ?? 1
  });
}

describe("loadOversightCounts", () => {
  it("counts nothing, without a query, when the readable set is empty", async () => {
    // `IN ()` is not valid SQL. The early return is the reason this test can
    // pass while the same call with a bad binding would raise a driver error.
    const counts = await loadOversightCounts(database, []);

    expect(counts.sessionCount).toBe(0);
    expect(counts.conflicts.total).toBe(0);
    expect(counts.runs.total).toBe(0);
  });

  it("splits conflicts by whether a person is still needed", async () => {
    const sessionId = await seedSession();
    await seedConflict({
      sessionId,
      status: "human_review",
      humanDecisionRequired: true
    });
    await seedConflict({
      sessionId,
      status: "resolved",
      humanDecisionRequired: true
    });
    // Detected but not escalated: it counts as a conflict, not as waiting.
    await seedConflict({
      sessionId,
      status: "detected",
      humanDecisionRequired: false
    });

    const counts = await loadOversightCounts(database, [sessionId]);

    expect(counts.sessionCount).toBe(1);
    expect(counts.conflicts.total).toBe(3);
    expect(counts.conflicts.requiringHuman).toBe(2);
    // The whole point of the panel: one conflict still has nobody's answer.
    expect(counts.conflicts.awaitingHuman).toBe(1);
    expect(counts.conflicts.resolved).toBe(1);
  });

  it("keeps the three decision outcomes apart", async () => {
    const sessionId = await seedSession();
    const conflictId = await seedConflict({
      sessionId,
      status: "resolved",
      humanDecisionRequired: true
    });
    await seedDecision({ sessionId, conflictId, action: "accept_challenge" });
    await seedDecision({ sessionId, conflictId, action: "accept_challenge" });
    await seedDecision({ sessionId, conflictId, action: "uphold_claim" });
    await seedDecision({
      sessionId,
      conflictId,
      action: "request_more_analysis"
    });

    const counts = await loadOversightCounts(database, [sessionId]);

    expect(counts.decisions.total).toBe(4);
    expect(counts.decisions.acceptChallenge).toBe(2);
    expect(counts.decisions.upholdClaim).toBe(1);
    expect(counts.decisions.requestMoreAnalysis).toBe(1);
  });

  it("counts retries as runs that exist because an earlier one did not work", async () => {
    const sessionId = await seedSession();
    await seedRun({ sessionId, status: "completed" });
    await seedRun({ sessionId, status: "failed" });
    await seedRun({ sessionId, status: "failed", attempt: 2 });
    await seedRun({ sessionId, status: "completed", attempt: 3 });
    await seedRun({ sessionId, status: "timed_out" });
    await seedRun({ sessionId, status: "cancelled" });

    const counts = await loadOversightCounts(database, [sessionId]);

    expect(counts.runs.total).toBe(6);
    expect(counts.runs.completed).toBe(2);
    expect(counts.runs.failed).toBe(2);
    expect(counts.runs.timedOut).toBe(1);
    expect(counts.runs.cancelled).toBe(1);
    expect(counts.runs.retried).toBe(2);
  });

  it("returns numbers, not the strings a bigint count arrives as", async () => {
    const sessionId = await seedSession();
    await seedConflict({
      sessionId,
      status: "detected",
      humanDecisionRequired: false
    });

    const counts = await loadOversightCounts(database, [sessionId]);

    // `count(*)` is a bigint and the driver hands it back as a string. Without
    // `mapWith(Number)` the panel would render "1" fine and then break on the
    // first comparison.
    expect(typeof counts.conflicts.total).toBe("number");
    expect(typeof counts.sessionCount).toBe("number");
  });

  it("leaves another account's research out of the aggregate", async () => {
    const mine = await seedSession();
    const theirs = await seedSession();
    await seedConflict({
      sessionId: mine,
      status: "human_review",
      humanDecisionRequired: true
    });
    await seedConflict({
      sessionId: theirs,
      status: "human_review",
      humanDecisionRequired: true
    });
    await seedRun({ sessionId: theirs, status: "failed" });

    const counts = await loadOversightCounts(database, [mine]);

    // The scoping is the security boundary: an aggregate that leaks a count is
    // still a leak, even though no row is shown.
    expect(counts.sessionCount).toBe(1);
    expect(counts.conflicts.total).toBe(1);
    expect(counts.runs.total).toBe(0);
  });

  it("counts the whole deployment when no scope is given", async () => {
    const a = await seedSession();
    const b = await seedSession();
    await seedRun({ sessionId: a, status: "completed" });
    await seedRun({ sessionId: b, status: "completed" });

    const counts = await loadOversightCounts(database);

    // `undefined` is "no restriction", which is the operator deployment — not
    // the same thing as "may read nothing", which is the empty array.
    expect(counts.sessionCount).toBeGreaterThanOrEqual(2);
    expect(counts.runs.completed).toBeGreaterThanOrEqual(2);
  });
});
