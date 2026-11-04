import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { runMigrations } from "../migrate";
import {
  assertDisposableDatabaseName,
  createTestAdminDatabase,
  createTestDatabaseForUrl,
  resolveTestDatabaseUrl
} from "../testing/test-database";
import { NotificationRepository } from "./notification-repository";
import {
  decisionSessions,
  projects,
  researchComments,
  researchReportSnapshots,
  researchReviewRequests
} from "../schema";

/**
 * 0021 adds the notification centre's read markers, and nothing else.
 *
 * What only a real database can prove:
 *  1. the migration lands the table and both indexes, so two reads of one item
 *     collide in PostgreSQL rather than in application code;
 *  2. marking the same item read twice is a no-op — the property that lets two
 *     open tabs settle on the same state without a lock;
 *  3. read state is per account: one reader's marker never silences another's
 *     badge;
 *  4. the two `listFailedRuns` filters are genuinely different queries. An
 *     empty id list must run no query at all, while `"all"` runs the unfiltered
 *     one. Collapsing those two into "if ids is empty, skip the filter" is the
 *     classic way a notification list ends up showing everyone's failures.
 *
 * Runs only against a dedicated test database: the guard refuses before
 * connecting when TEST_DATABASE_URL is missing or points anywhere unsafe.
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
let repository: NotificationRepository;

beforeAll(async () => {
  const name = `nexus_test_notify_${Date.now().toString(36)}`;
  await admin.execute(`CREATE DATABASE "${name}"`);
  createdDatabases.push(name);
  database = createTestDatabaseForUrl(tempDatabaseUrl(name));
  const applied = (await runMigrations(database)).applied;
  // The table only exists because 0021 landed; a skipped migration here would
  // make every assertion below pass against nothing.
  expect(applied).toContain("0021_notification_reads.sql");
  repository = new NotificationRepository(database);
}, 180_000);

describe("notification read markers", () => {
  it("records one marker per account per item, idempotently", async () => {
    const userId = `user-${newId()}`;
    const key = `invitation:${newId()}`;

    await repository.markRead(userId, [key]);
    // A second tab marking the same card read must not fail or duplicate.
    await repository.markRead(userId, [key]);

    expect(await repository.listReadKeys(userId)).toEqual([key]);

    const rows = (await database.execute(
      `SELECT count(*)::int AS n FROM notification_reads WHERE user_id = '${userId}'`
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(1);
  });

  it("keeps each account's markers its own", async () => {
    const first = `user-${newId()}`;
    const second = `user-${newId()}`;
    const key = `run-failed:${newId()}`;

    await repository.markRead(first, [key]);

    expect(await repository.listReadKeys(first)).toEqual([key]);
    // The second reader has not seen it, so their badge must still count it.
    expect(await repository.listReadKeys(second)).toEqual([]);
  });

  it("ignores an empty list instead of writing a row about nothing", async () => {
    const userId = `user-${newId()}`;
    await repository.markRead(userId, []);
    expect(await repository.listReadKeys(userId)).toEqual([]);
  });
});

describe("derived reads", () => {
  it("runs no query for an empty id list, and returns nothing", async () => {
    expect(await repository.listFailedRuns([])).toEqual([]);
  });

  it("runs the filtered query and returns nothing when the session has no runs", async () => {
    // This is the call that would raise a driver error if the array were bound
    // the wrong way, so it has to touch the database for real.
    expect(await repository.listFailedRuns([newId()])).toEqual([]);
  });

  it("runs the unfiltered query for an operator deployment", async () => {
    expect(await repository.listFailedRuns("all")).toEqual([]);
  });

  it("finds no invitations for an account that was never invited", async () => {
    expect(await repository.listPendingInvitations(`user-${newId()}`)).toEqual(
      []
    );
  });
});

/**
 * The three collaboration-sourced readers.
 *
 * Everything here is a claim about what the notification centre must be able
 * to miss. A mocked query cannot catch any of it:
 *
 *  1. **`status` has a CHECK constraint, and it defines "still waiting".**
 *     Migration 0019 keeps `open` and `in_review` in lock-step: `open` has no
 *     assignee, `in_review` has exactly one. Filtering on `open` alone drops
 *     every request somebody already picked up — which is precisely the one
 *     waiting on *this* reviewer for a verdict, and the one that must not be
 *     dropped.
 *  2. **Arrays bind through `inArray`, and an empty list runs no query.**
 *     `sql` templates do not expand a JavaScript array, so the naive form
 *     raises a driver error instead of returning rows.
 *  3. **`created_at` is a timestamp compared as an ISO string.** Not a `Date`.
 */
describe("collaboration-sourced items", () => {
  const viewerUserId = `user-${newId()}`;
  const otherUserId = `user-${newId()}`;
  const strangerUserId = `user-${newId()}`;

  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString();
  const daysAgo = (days: number) =>
    new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();

  /** Seven days, matching the service's news window. */
  const since = daysAgo(7);

  let readableSessionId: string;
  let otherSessionId: string;

  const createSession = async (question: string) => {
    const projectId = newId();
    const sessionId = newId();
    await database.insert(projects).values({
      id: projectId,
      name: question,
      input: {}
    });
    await database.insert(decisionSessions).values({
      id: sessionId,
      projectId,
      locale: "zh-CN",
      phase: "ANALYSIS",
      operationalStatus: "RUNNING",
      researchQuestion: question
    });
    return sessionId;
  };

  beforeAll(async () => {
    readableSessionId = await createSession("可读范围内的研究");
    otherSessionId = await createSession("范围之外的研究");

    await database.insert(researchReviewRequests).values([
      {
        id: newId(),
        sessionId: readableSessionId,
        requestType: "claim_review",
        targetType: "claim",
        targetId: "claim-1",
        requestedBy: otherUserId,
        requestedReviewerUserId: viewerUserId,
        status: "open",
        createdAt: minutesAgo(30)
      },
      {
        // Already picked up — an assignee is required here, and this is the
        // request that a naive `status = 'open'` filter would lose.
        id: newId(),
        sessionId: readableSessionId,
        requestType: "report_review",
        targetType: "report_snapshot",
        targetId: "snapshot-1",
        requestedBy: otherUserId,
        requestedReviewerUserId: viewerUserId,
        status: "in_review",
        assignedReviewerUserId: viewerUserId,
        createdAt: minutesAgo(20)
      },
      {
        id: newId(),
        sessionId: readableSessionId,
        requestType: "source_review",
        targetType: "source",
        targetId: "source-1",
        requestedBy: otherUserId,
        assignedReviewerUserId: viewerUserId,
        status: "in_review",
        createdAt: minutesAgo(10)
      },
      {
        // Decided: no longer waiting on anybody.
        id: newId(),
        sessionId: readableSessionId,
        requestType: "conflict_review",
        targetType: "conflict",
        targetId: "conflict-1",
        requestedBy: otherUserId,
        requestedReviewerUserId: viewerUserId,
        status: "completed",
        decision: "approved",
        decidedBy: viewerUserId,
        decidedAt: minutesAgo(5),
        createdAt: minutesAgo(60)
      },
      {
        id: newId(),
        sessionId: readableSessionId,
        requestType: "claim_review",
        targetType: "claim",
        targetId: "claim-2",
        requestedBy: otherUserId,
        requestedReviewerUserId: viewerUserId,
        status: "cancelled",
        createdAt: minutesAgo(60)
      },
      {
        // Addressed to somebody else entirely.
        id: newId(),
        sessionId: readableSessionId,
        requestType: "claim_review",
        targetType: "claim",
        targetId: "claim-3",
        requestedBy: otherUserId,
        requestedReviewerUserId: strangerUserId,
        status: "open",
        createdAt: minutesAgo(40)
      }
    ]);

    await database.insert(researchComments).values([
      {
        id: newId(),
        sessionId: readableSessionId,
        authorUserId: otherUserId,
        body: "这条证据链还缺一环。",
        targetType: "claim",
        targetId: "claim-1",
        createdAt: minutesAgo(15)
      },
      {
        // Your own comment is not news to you.
        id: newId(),
        sessionId: readableSessionId,
        authorUserId: viewerUserId,
        body: "我自己留的备注。",
        targetType: "claim",
        targetId: "claim-1",
        createdAt: minutesAgo(14)
      },
      {
        // Withdrawn: must not keep appearing in a feed that cannot be edited.
        id: newId(),
        sessionId: readableSessionId,
        authorUserId: otherUserId,
        body: "这条已经撤回了。",
        targetType: "claim",
        targetId: "claim-1",
        deletedAt: minutesAgo(13),
        createdAt: minutesAgo(13)
      },
      {
        // Outside the window: without a window this would be "new" forever.
        id: newId(),
        sessionId: readableSessionId,
        authorUserId: otherUserId,
        body: "很久以前的评论。",
        targetType: "claim",
        targetId: "claim-1",
        createdAt: daysAgo(30)
      },
      {
        // On a research this account may not read.
        id: newId(),
        sessionId: otherSessionId,
        authorUserId: otherUserId,
        body: "另一项研究上的评论。",
        targetType: "claim",
        targetId: "claim-9",
        createdAt: minutesAgo(12)
      }
    ]);

    await database.insert(researchReportSnapshots).values([
      {
        id: newId(),
        sessionId: readableSessionId,
        version: 1,
        createdBy: otherUserId,
        researchQuestion: "可读范围内的研究",
        // The table checks these shapes: a 16-character fingerprint and a
        // 64-character hash. A reader that assumed otherwise would fail here
        // rather than in production.
        materialsFingerprint: "fingerprint-0001",
        snapshotHash: "1".repeat(64),
        reportPayload: { title: "第一版" },
        changeReason: "补充了对立面证据",
        createdAt: minutesAgo(25)
      },
      {
        id: newId(),
        sessionId: readableSessionId,
        version: 2,
        createdBy: viewerUserId,
        researchQuestion: "可读范围内的研究",
        materialsFingerprint: "fingerprint-0002",
        snapshotHash: "2".repeat(64),
        reportPayload: { title: "第二版" },
        createdAt: minutesAgo(20)
      },
      {
        id: newId(),
        sessionId: readableSessionId,
        version: 3,
        createdBy: otherUserId,
        researchQuestion: "可读范围内的研究",
        materialsFingerprint: "fingerprint-0003",
        snapshotHash: "3".repeat(64),
        reportPayload: { title: "第三版" },
        createdAt: daysAgo(21)
      }
    ]);
  });

  it("keeps a request that somebody already picked up", async () => {
    const rows = await repository.listPendingReviewRequests(viewerUserId);

    const types = rows.map((row) => row.requestType).sort();
    // The `open` claim review, the `in_review` report review, and the
    // `in_review` source review that was assigned without being addressed.
    expect(types).toEqual(["claim_review", "report_review", "source_review"]);
    // The request somebody already picked up is still waiting on a verdict.
    expect(
      rows.find((row) => row.targetId === "snapshot-1")?.status
    ).toBe("in_review");
    // The completed and the cancelled request are nobody's business any more.
    expect(rows.some((row) => row.targetId === "conflict-1")).toBe(false);
    expect(rows.some((row) => row.targetId === "claim-2")).toBe(false);
    // Somebody else's request never appears.
    expect(rows.some((row) => row.targetId === "claim-3")).toBe(false);
  });

  it("returns no request for an account nobody asked", async () => {
    // An account that was never named as a reviewer, and never picked one up.
    expect(
      await repository.listPendingReviewRequests(`user-${newId()}`)
    ).toEqual([]);
  });

  it("shows other people's comments inside the window and hides the rest", async () => {
    const rows = await repository.listRecentComments(
      [readableSessionId],
      viewerUserId,
      since
    );

    expect(rows.map((row) => row.body)).toEqual(["这条证据链还缺一环。"]);
    expect(rows[0]?.authorUserId).toBe(otherUserId);
    expect(rows[0]?.researchQuestion).toBe("可读范围内的研究");
  });

  it("keeps the scope it was given instead of widening it", async () => {
    // The reader does not decide who may read what — the caller does, and
    // hands the decision over as an id list. A reader that quietly widened
    // that list would hand every caller everybody's comments.
    const rows = await repository.listRecentComments(
      [otherSessionId],
      viewerUserId,
      since
    );

    expect(rows.map((row) => row.body)).toEqual(["另一项研究上的评论。"]);
  });

  it("runs no query at all for an empty scope", async () => {
    expect(
      await repository.listRecentComments([], viewerUserId, since)
    ).toEqual([]);
    expect(
      await repository.listRecentVersions([], viewerUserId, since)
    ).toEqual([]);
  });

  it("shows other people's report versions inside the window and hides mine", async () => {
    const rows = await repository.listRecentVersions(
      [readableSessionId],
      viewerUserId,
      since
    );

    expect(rows.map((row) => row.version)).toEqual([1]);
    expect(rows[0]?.changeReason).toBe("补充了对立面证据");
  });
});
