import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { runMigrations } from "../migrate";
import {
  assertDisposableDatabaseName,
  createTestAdminDatabase,
  createTestDatabaseForUrl,
  resolveTestDatabaseUrl
} from "../testing/test-database";
import { RevalidationTaskRepository } from "./revalidation-task-repository";
import { SourceCheckRepository } from "./source-check-repository";

/**
 * 0014 adds source monitoring: the check trail (`source_checks`), the re-check
 * work items (`revalidation_tasks`) and their appended history
 * (`revalidation_task_events`).
 *
 * What only a real database can prove here:
 *  1. the up migration lands all three tables with their CHECK constraints,
 *     and the documented down script really removes them and clears the
 *     ledger, so a later `db:migrate` re-applies instead of silently skipping;
 *  2. the honesty rules are enforced by PostgreSQL, not only by Zod — a status
 *     outside the closed sets, an `unavailable` check with no reason, a
 *     `changed` check holding only one hash, a closure with no note or actor,
 *     an open task carrying a closure, and a truncated trigger hash are all
 *     rejected;
 *  3. one reminder per version of a source: the unique index rejects the same
 *     (session, source, trigger hash) while allowing the same hash in another
 *     session;
 *  4. the repositories behave: checks read newest-first with counters for the
 *     rate limit and the failure budget, tasks deduplicate by trigger, close
 *     only with a reason and an actor, and keep every transition in the event
 *     table while the task id stays stable.
 *
 * Runs only against a dedicated test database: the guard refuses before
 * connecting when TEST_DATABASE_URL is missing or points anywhere unsafe.
 */
const databaseUrl = resolveTestDatabaseUrl().toString();
const admin = createTestAdminDatabase();

/** Every throwaway database this file creates is dropped in `afterAll`. */
const createdDatabases: string[] = [];

const tempDatabaseUrl = (databaseName: string) => {
  assertDisposableDatabaseName(databaseName);
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

afterAll(async () => {
  for (const databaseName of createdDatabases) {
    await admin.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  }
  await admin.end();
});

type TestDatabase = ReturnType<typeof createTestDatabaseForUrl>;

async function statements(file: string): Promise<string[]> {
  const contents = await readFile(
    resolve("migrations", ...file.split("/")),
    "utf8"
  );
  return contents
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function tableExists(
  database: TestDatabase,
  table: string
): Promise<boolean> {
  const rows = (await database.execute(
    sql.raw(`select to_regclass('public.${table}') as found`)
  )) as unknown as Array<{ found: string | null }>;
  return rows[0]?.found != null;
}

async function ledger(database: TestDatabase): Promise<string[]> {
  const rows = (await database.execute(
    sql.raw("select filename from schema_migrations order by filename")
  )) as unknown as Array<{ filename: string }>;
  return rows.map((row) => row.filename);
}

/**
 * Rolls back every migration applied after `filename`, newest first.
 *
 * A down script only undoes its own migration, so it must not have to cope
 * with objects a later migration adds. The list comes from the ledger rather
 * than a hard-coded filename, so adding a migration does not silently
 * invalidate this test.
 */
async function rollbackMigrationsAfter(
  database: TestDatabase,
  filename: string
): Promise<void> {
  const rows = (await database.execute(
    sql.raw(
      `select filename from schema_migrations where filename > '${filename}' order by filename desc`
    )
  )) as unknown as Array<{ filename: string }>;
  for (const row of rows) {
    const downFile = `rollback/${row.filename.replace(/\.sql$/, ".down.sql")}`;
    for (const statement of await statements(downFile)) {
      await database.execute(sql.raw(statement));
    }
  }
}
async function freshMigratedDatabase(): Promise<{ database: TestDatabase }> {
  const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
  await admin.execute(`CREATE DATABASE "${databaseName}"`);
  createdDatabases.push(databaseName);
  const database = createTestDatabaseForUrl(tempDatabaseUrl(databaseName));
  const applied = (await runMigrations(database, resolve("migrations"))).applied;
  expect(applied).toContain("0014_source_monitoring.sql");
  return { database };
}

async function seedSession(database: TestDatabase): Promise<string> {
  const projectId = newId();
  const sessionId = newId();
  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'source-monitoring', '{}'::jsonb)`
    )
  );
  await database.execute(
    sql.raw(`
      INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence)
      VALUES ('${sessionId}', '${projectId}', 'zh-CN', 'CREATED', 'ACTIVE', 1)
    `)
  );
  return sessionId;
}

async function seedSource(
  database: TestDatabase,
  sessionId: string,
  overrides: { title?: string } = {}
): Promise<string> {
  const sourceId = newId();
  const title = overrides.title ?? "季度回顾";
  await database.execute(
    sql.raw(`
      INSERT INTO sources (id, session_id, title, kind, url, canonical_url, created_by)
      VALUES ('${sourceId}', '${sessionId}', '${title}', 'url', 'https://example.org/a', 'https://example.org/a', 'human')
    `)
  );
  return sourceId;
}

async function seedSnapshot(
  database: TestDatabase,
  sessionId: string,
  sourceId: string,
  contentHash: string,
  content: string
): Promise<string> {
  const snapshotId = newId();
  await database.execute(
    sql.raw(`
      INSERT INTO source_snapshots (id, session_id, source_id, canonical_url, content_hash, title,
                                    content_type, content, content_bytes, char_count, retrieved_at)
      VALUES ('${snapshotId}', '${sessionId}', '${sourceId}', 'https://example.org/a', '${contentHash}',
              '季度回顾', 'text/html; charset=utf-8', '${content}', ${content.length}, ${content.length}, now())
    `)
  );
  return snapshotId;
}

/** One source_checks INSERT assembled from overrides, so each rule has one diff. */
async function insertCheck(
  database: TestDatabase,
  sessionId: string,
  sourceId: string,
  overrides: {
    status?: string;
    reasonCode?: string | null;
    errorCode?: string | null;
    previousHash?: string | null;
    currentHash?: string | null;
    currentSnapshotId?: string | null;
    newVersionStored?: boolean;
  } = {}
): Promise<void> {
  const status = overrides.status ?? "unchanged";
  const reasonCode = overrides.reasonCode === undefined ? null : overrides.reasonCode;
  const errorCode = overrides.errorCode === undefined ? null : overrides.errorCode;
  const previousHash = overrides.previousHash === undefined ? null : overrides.previousHash;
  const currentHash = overrides.currentHash === undefined ? null : overrides.currentHash;
  const currentSnapshotId =
    overrides.currentSnapshotId === undefined ? null : overrides.currentSnapshotId;
  const newVersionStored = overrides.newVersionStored ?? false;
  const nullText = (value: string | null) => (value === null ? "NULL" : `'${value}'`);
  await database.execute(
    sql.raw(`
      INSERT INTO source_checks (id, session_id, source_id, status, reason_code, message,
                                 previous_content_hash, current_content_hash, current_snapshot_id,
                                 error_code, new_version_stored, checked_by)
      VALUES ('${newId()}', '${sessionId}', '${sourceId}', '${status}', ${nullText(reasonCode)},
              '检查完成', ${nullText(previousHash)}, ${nullText(currentHash)}, ${nullText(currentSnapshotId)},
              ${nullText(errorCode)}, ${newVersionStored}, 'human:reviewer')
    `)
  );
}

/** One revalidation_tasks INSERT assembled from overrides, so each rule has one diff. */
async function insertTask(
  database: TestDatabase,
  sessionId: string,
  sourceId: string,
  overrides: {
    status?: string;
    triggerHash?: string;
    resolvedAt?: string | null;
    resolvedBy?: string | null;
    resolutionNote?: string | null;
    affectedEvidenceIds?: string;
    affectedClaimIds?: string;
  } = {}
): Promise<void> {
  const status = overrides.status ?? "open";
  const triggerHash = overrides.triggerHash ?? "b".repeat(64);
  const resolvedAt = overrides.resolvedAt === undefined ? null : overrides.resolvedAt;
  const resolvedBy = overrides.resolvedBy === undefined ? null : overrides.resolvedBy;
  const resolutionNote = overrides.resolutionNote === undefined ? null : overrides.resolutionNote;
  const affectedEvidenceIds = overrides.affectedEvidenceIds ?? "'[]'::jsonb";
  const affectedClaimIds = overrides.affectedClaimIds ?? "'[]'::jsonb";
  const nullText = (value: string | null) => (value === null ? "NULL" : `'${value}'`);
  await database.execute(
    sql.raw(`
      INSERT INTO revalidation_tasks (id, session_id, source_id, source_title, trigger_content_hash,
                                      affected_evidence_ids, affected_claim_ids, reason, status,
                                      resolved_at, resolved_by, resolution_note)
      VALUES ('${newId()}', '${sessionId}', '${sourceId}', '季度回顾', '${triggerHash}',
              ${affectedEvidenceIds}, ${affectedClaimIds}, '来源内容发生变化', '${status}',
              ${nullText(resolvedAt)}, ${nullText(resolvedBy)}, ${nullText(resolutionNote)})
    `)
  );
}

/**
 * The Postgres error behind a rejected statement.
 *
 * A failed `execute` surfaces the driver error itself, whose `code` is the
 * SQLSTATE and whose `constraint_name` names the rule that fired. `23514` is
 * a check violation; a literal Postgres cannot even parse fails earlier with
 * `22P02` and names no constraint. Telling the two apart is what proves the
 * constraint itself is doing the rejecting, rather than the JSON parser
 * refusing the input before any rule runs.
 */
async function rejectedStatement(run: () => Promise<unknown>): Promise<{
  code: string | null;
  constraint: string | null;
}> {
  try {
    await run();
  } catch (error) {
    const pg = error as { code?: string; constraint_name?: string };
    return { code: pg.code ?? null, constraint: pg.constraint_name ?? null };
  }
  throw new Error("expected the statement to be rejected");
}

describe("0014 source monitoring migration", () => {
  it("creates all three tables and can be rolled back and re-applied", async () => {
    const { database } = await freshMigratedDatabase();

    for (const table of [
      "source_checks",
      "revalidation_tasks",
      "revalidation_task_events"
    ]) {
      expect(await tableExists(database, table)).toBe(true);
    }

    for (const statement of await statements(
      "rollback/0014_source_monitoring.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    for (const table of [
      "source_checks",
      "revalidation_tasks",
      "revalidation_task_events"
    ]) {
      expect(await tableExists(database, table)).toBe(false);
    }
    expect(await ledger(database)).not.toContain("0014_source_monitoring.sql");

    const reapplied = (await runMigrations(database, resolve("migrations")))
      .applied;
    expect(reapplied).toContain("0014_source_monitoring.sql");
    expect(await tableExists(database, "source_checks")).toBe(true);
    expect(await tableExists(database, "revalidation_tasks")).toBe(true);
    expect(await tableExists(database, "revalidation_task_events")).toBe(true);

    // A down script only undoes its own migration: rolling 0014 back through
    // the ledger (newest first) must leave the older migrations' down scripts
    // working, here proven with 0013's, whose tables 0014 points at.
    await rollbackMigrationsAfter(database, "0013_source_files.sql");
    expect(await tableExists(database, "source_checks")).toBe(false);
    for (const statement of await statements(
      "rollback/0013_source_files.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await tableExists(database, "source_files")).toBe(false);
  });

  it("keeps the monitoring vocabulary closed and forces failures to say why", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);

    await expect(
      insertCheck(database, sessionId, sourceId, { status: "drifted" })
    ).rejects.toThrow(/source_checks_status_check/i);

    // "We could not read it" must carry a reason, or it is indistinguishable
    // from "we read it and nothing had changed".
    await expect(
      insertCheck(database, sessionId, sourceId, {
        status: "unavailable",
        reasonCode: null,
        errorCode: null
      })
    ).rejects.toThrow(/unreadable_has_reason/i);

    await expect(
      insertCheck(database, sessionId, sourceId, {
        status: "failed",
        reasonCode: "network_error",
        errorCode: null
      })
    ).rejects.toThrow(/unreadable_has_reason/i);

    // With a reason the failure is stored, and stays a failure.
    await insertCheck(database, sessionId, sourceId, {
      status: "failed",
      reasonCode: "network_error",
      errorCode: "ETIMEDOUT"
    });
    const failed = (await database.execute(
      sql.raw("select status, error_code from source_checks")
    )) as unknown as Array<{ status: string; error_code: string }>;
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe("failed");
    expect(failed[0]?.error_code).toBe("ETIMEDOUT");
  });

  it("refuses a changed check without two versions, and a stored version without a capture", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);

    await expect(
      insertCheck(database, sessionId, sourceId, {
        status: "changed",
        previousHash: "a".repeat(64),
        currentHash: "c".repeat(64),
        currentSnapshotId: null
      })
    ).rejects.toThrow(/changed_has_versions/i);

    await expect(
      insertCheck(database, sessionId, sourceId, {
        status: "changed",
        previousHash: "a".repeat(64),
        currentHash: null,
        currentSnapshotId: null
      })
    ).rejects.toThrow(/changed_has_versions/i);

    // A check that read nothing must not be recorded as having stored a version.
    await expect(
      insertCheck(database, sessionId, sourceId, {
        status: "unchanged",
        newVersionStored: true,
        currentSnapshotId: null
      })
    ).rejects.toThrow(/new_version_requires_capture/i);

    // With both hashes and the new capture, drift is storable — and keeps the
    // previous hash visible next to the new one.
    const snapshotId = await seedSnapshot(
      database,
      sessionId,
      sourceId,
      "c".repeat(64),
      "修订后的正文"
    );
    await insertCheck(database, sessionId, sourceId, {
      status: "changed",
      previousHash: "a".repeat(64),
      currentHash: "c".repeat(64),
      currentSnapshotId: snapshotId,
      newVersionStored: true
    });
    const rows = (await database.execute(
      sql.raw(
        "select previous_content_hash, current_content_hash from source_checks"
      )
    )) as unknown as Array<{
      previous_content_hash: string;
      current_content_hash: string;
    }>;
    expect(rows[0]?.previous_content_hash).toBe("a".repeat(64));
    expect(rows[0]?.current_content_hash).toBe("c".repeat(64));
  });

  it("refuses an anonymous or reasonless closure and an open task with a closure", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);

    await expect(
      insertTask(database, sessionId, sourceId, { status: "dismissed" })
    ).rejects.toThrow(/closed_has_reason/i);

    await expect(
      insertTask(database, sessionId, sourceId, {
        status: "resolved",
        resolvedAt: new Date().toISOString(),
        resolvedBy: "human:reviewer",
        resolutionNote: null
      })
    ).rejects.toThrow(/closed_has_reason/i);

    // The mirror image: an open task must not carry a closure it never had.
    await expect(
      insertTask(database, sessionId, sourceId, {
        status: "open",
        resolvedBy: "human:reviewer"
      })
    ).rejects.toThrow(/open_has_no_closure/i);

    await insertTask(database, sessionId, sourceId, {
      status: "resolved",
      resolvedAt: new Date().toISOString(),
      resolvedBy: "human:reviewer",
      resolutionNote: "重新抓取后原文未变"
    });
    const rows = (await database.execute(
      sql.raw("select resolved_by, resolution_note from revalidation_tasks")
    )) as unknown as Array<{ resolved_by: string; resolution_note: string }>;
    expect(rows[0]?.resolved_by).toBe("human:reviewer");
    expect(rows[0]?.resolution_note).toBe("重新抓取后原文未变");
  });

  it("requires a sha256-length trigger hash and array-shaped affected sets", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);

    await expect(
      insertTask(database, sessionId, sourceId, { triggerHash: "abc" })
    ).rejects.toThrow(/hash_length/i);

    // Well-formed JSON that is not an array reaches the CHECK. Naming the
    // constraint and the SQLSTATE is the point: a row refused by the JSON
    // *parser* would answer 22P02, so only a 23514 carrying this exact
    // constraint name proves the rule ran.
    const evidenceViolation = await rejectedStatement(() =>
      insertTask(database, sessionId, sourceId, {
        affectedEvidenceIds: "'{\"evidence\":1}'::jsonb"
      })
    );
    expect(evidenceViolation.code).toBe("23514");
    expect(evidenceViolation.constraint).toBe(
      "revalidation_tasks_evidence_ids_array_check"
    );

    const claimViolation = await rejectedStatement(() =>
      insertTask(database, sessionId, sourceId, {
        affectedEvidenceIds: "'[]'::jsonb",
        affectedClaimIds: "'{\"id\":1}'::jsonb"
      })
    );
    expect(claimViolation.code).toBe("23514");
    expect(claimViolation.constraint).toBe(
      "revalidation_tasks_claim_ids_array_check"
    );

    // Control: the same column holding text that is not JSON at all fails as
    // input syntax (22P02), never as a check violation — which is what shows
    // the constraint above is genuinely reached by valid non-array input.
    const notJson = await rejectedStatement(() =>
      insertTask(database, sessionId, sourceId, {
        affectedEvidenceIds: "'not-json'::jsonb"
      })
    );
    expect(notJson.code).toBe("22P02");

    // And a well-formed array is stored exactly as it was given.
    await insertTask(database, sessionId, sourceId, {
      triggerHash: "9".repeat(64),
      affectedEvidenceIds: "'[\"e-1\",\"e-2\"]'::jsonb"
    });
    const rows = (await database.execute(
      sql.raw(
        "select affected_evidence_ids from revalidation_tasks order by created_at"
      )
    )) as unknown as Array<{ affected_evidence_ids: string[] }>;
    expect(rows[0]?.affected_evidence_ids).toEqual(["e-1", "e-2"]);
  });

  it("keeps one reminder per version of a source, scoped to the session", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionA = await seedSession(database);
    const sessionB = await seedSession(database);
    const sourceA = await seedSource(database, sessionA, { title: "季度回顾" });
    const sourceB = await seedSource(database, sessionB, { title: "季度回顾" });
    const hash = "d".repeat(64);

    await insertTask(database, sessionA, sourceA, { triggerHash: hash });
    await expect(
      insertTask(database, sessionA, sourceA, { triggerHash: hash })
    ).rejects.toThrow(/revalidation_tasks_current_idx|duplicate key/i);

    // The same version fingerprint in another session, or of another source,
    // is different work: deduplication is scoped, never global.
    await insertTask(database, sessionA, sourceB, { triggerHash: hash });
    await insertTask(database, sessionB, sourceA, { triggerHash: hash });
    const rows = (await database.execute(
      sql.raw("select session_id from revalidation_tasks")
    )) as unknown as Array<{ session_id: string }>;
    expect(rows).toHaveLength(3);
  });

  it("appends every transition to the event table and keeps the task id stable", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);

    await expect(
      database.execute(
        sql.raw(`
          INSERT INTO revalidation_task_events (id, task_id, session_id, to_status, actor)
          VALUES ('${newId()}', '${newId()}', '${sessionId}', 'archived', 'someone')
        `)
      )
    ).rejects.toThrow(/revalidation_task_events_status_check/i);
  });
});

describe("source check repository", () => {
  it("stores every check and reads them newest first", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);
    const repository = new SourceCheckRepository(database);

    await repository.insertCheck({
      record: {
        id: newId(),
        sessionId,
        sourceId,
        status: "unchanged",
        message: "内容未变化",
        checkedBy: "human:reviewer"
      }
    });
    await repository.insertCheck({
      record: {
        id: newId(),
        sessionId,
        sourceId,
        status: "failed",
        reasonCode: "network_error",
        errorCode: "ETIMEDOUT",
        errorMessage: "connect ETIMEDOUT",
        message: "检查失败",
        checkedBy: "human:reviewer"
      }
    });

    const checks = await repository.listChecks(sessionId, sourceId);
    expect(checks).toHaveLength(2);
    expect(checks[0]?.status).toBe("failed");
    expect(checks[0]?.errorCode).toBe("ETIMEDOUT");
    expect(checks[0]?.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const limited = await repository.listChecks(sessionId, sourceId, {
      limit: 1
    });
    expect(limited).toHaveLength(1);

    const latest = await repository.lastCheck(sessionId, sourceId);
    expect(latest?.status).toBe("failed");
  });

  it("counts recent checks and unsuccessful checks separately, for the budgets", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);
    const repository = new SourceCheckRepository(database);

    const since = new Date(Date.now() - 60_000).toISOString();
    await repository.insertCheck({
      record: {
        id: newId(),
        sessionId,
        sourceId,
        status: "unchanged",
        message: "内容未变化",
        checkedBy: "human:reviewer"
      }
    });
    await repository.insertCheck({
      record: {
        id: newId(),
        sessionId,
        sourceId,
        status: "unavailable",
        reasonCode: "timeout",
        errorCode: "timeout",
        message: "检查失败：抓取超时。",
        checkedBy: "human:reviewer"
      }
    });
    await repository.insertCheck({
      record: {
        id: newId(),
        sessionId,
        sourceId,
        status: "failed",
        reasonCode: "rate_limited",
        errorCode: "rate_limited",
        message: "检查频率达到上限。",
        checkedBy: "human:reviewer"
      }
    });

    expect(await repository.countRecentChecks(sessionId, sourceId, since)).toBe(3);
    // Both ways of coming back empty count toward the retry budget.
    expect(
      await repository.countUnsuccessfulSince(sessionId, sourceId, since)
    ).toBe(2);

    // Before the window, neither budget sees anything.
    const earlier = new Date(Date.now() + 60_000).toISOString();
    expect(await repository.countRecentChecks(sessionId, sourceId, earlier)).toBe(0);
    expect(
      await repository.countUnsuccessfulSince(sessionId, sourceId, earlier)
    ).toBe(0);
  });
});

describe("revalidation task repository", () => {
  it("opens a task with an appended open event and deduplicates by trigger", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId, { title: "季度回顾" });
    const repository = new RevalidationTaskRepository(database);
    const triggerHash = "e".repeat(64);

    const task = await repository.insertTask({
      task: {
        id: newId(),
        sessionId,
        sourceId,
        sourceTitle: "季度回顾",
        triggerContentHash: triggerHash,
        previousSnapshotId: null,
        currentSnapshotId: null,
        affectedEvidenceIds: [],
        affectedClaimIds: [],
        reason: "来源内容发生变化"
      }
    });
    expect(task.status).toBe("open");
    expect(task.affectedEvidenceIds).toEqual([]);

    // The same trigger resolves to the existing row, so a repeated check
    // cannot open a second reminder for the same piece of work.
    const existing = await repository.findCurrentByTrigger(
      sessionId,
      sourceId,
      triggerHash
    );
    expect(existing?.id).toBe(task.id);

    const history = await repository.listTaskHistory(sessionId, task.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.fromStatus).toBeNull();
    expect(history[0]?.toStatus).toBe("open");
    expect(history[0]?.actor).toBe("source-monitoring");
  });

  it("closes only with a reason and an actor, and keeps every transition", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);
    const repository = new RevalidationTaskRepository(database);

    const task = await repository.insertTask({
      task: {
        id: newId(),
        sessionId,
        sourceId,
        sourceTitle: "季度回顾",
        triggerContentHash: "f".repeat(64),
        previousSnapshotId: null,
        currentSnapshotId: null,
        affectedEvidenceIds: [],
        affectedClaimIds: [],
        reason: "来源内容发生变化"
      }
    });

    await expect(
      repository.transitionTask({
        sessionId,
        taskId: task.id,
        status: "resolved",
        actor: "human:reviewer"
      })
    ).rejects.toThrow(/reason/i);

    const inReview = await repository.transitionTask({
      sessionId,
      taskId: task.id,
      status: "in_review",
      actor: "human:reviewer"
    });
    expect(inReview.status).toBe("in_review");
    // Moving to a non-closing status clears any closure fields.
    expect(inReview.resolvedBy).toBeNull();

    const closed = await repository.transitionTask({
      sessionId,
      taskId: task.id,
      status: "resolved",
      actor: "human:reviewer",
      note: "重新抓取后确认引用仍然成立"
    });
    expect(closed.status).toBe("resolved");
    expect(closed.resolvedBy).toBe("human:reviewer");
    expect(closed.resolutionNote).toBe("重新抓取后确认引用仍然成立");
    expect(closed.resolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The id a workspace shows stays addressable across transitions.
    expect(closed.id).toBe(task.id);

    const history = await repository.listTaskHistory(sessionId, task.id);
    expect(history.map((event) => event.toStatus)).toEqual([
      "resolved",
      "in_review",
      "open"
    ]);
    expect(history[0]?.note).toBe("重新抓取后确认引用仍然成立");
    expect(history[0]?.fromStatus).toBe("in_review");
  });

  it("scopes reads to the session and counts only unresolved work", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionA = await seedSession(database);
    const sessionB = await seedSession(database);
    const sourceId = await seedSource(database, sessionA);
    const repository = new RevalidationTaskRepository(database);

    const task = await repository.insertTask({
      task: {
        id: newId(),
        sessionId: sessionA,
        sourceId,
        sourceTitle: "季度回顾",
        triggerContentHash: "1".repeat(64),
        previousSnapshotId: null,
        currentSnapshotId: null,
        affectedEvidenceIds: [],
        affectedClaimIds: [],
        reason: "来源内容发生变化"
      }
    });

    // Another session's task does not exist here.
    await expect(
      repository.getTask(sessionB, task.id)
    ).rejects.toThrow(/not found/i);

    expect(await repository.listTasks(sessionA)).toHaveLength(1);
    expect(await repository.countUnresolved(sessionA)).toBe(1);
    expect(await repository.countUnresolved(sessionB)).toBe(0);

    await repository.transitionTask({
      sessionId: sessionA,
      taskId: task.id,
      status: "dismissed",
      actor: "human:reviewer",
      note: "该版本为转载页，已单独登记"
    });
    expect(await repository.countUnresolved(sessionA)).toBe(0);
    expect(
      (await repository.listTasks(sessionA, { status: "dismissed" })).length
    ).toBe(1);
    expect((await repository.listTasks(sessionA, { status: "open" })).length).toBe(
      0
    );
  });
});
