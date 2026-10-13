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
import { ReportSnapshotRepository } from "./report-snapshot-repository";

/**
 * 0015 adds the immutable report versions: one row per saved version, holding
 * the frozen payload, the exact source versions it cited, the verdicts, the
 * rulings and the monitoring risk state.
 *
 * What only a real database can prove here:
 *  1. the up migration lands the table with its CHECK constraints, and the
 *     documented down script really removes it and clears the ledger, so a
 *     later `db:migrate` re-applies instead of silently skipping;
 *  2. the honesty rules are enforced by PostgreSQL, not only by Zod — a zero
 *     or negative version, an unattributed save, an unknown payload shape,
 *     a fingerprint that is not 16 hex characters, a hash that is not a
 *     sha256, and reference sets that are not arrays are all rejected;
 *  3. one version number per session, and one snapshot per idempotency key
 *     per session, while the same key in another session is different work;
 *  4. the repository behaves: a save lands in the same transaction as its
 *     audit event, the list carries no payloads, and a cited capture that
 *     has since been deleted is reported as absent rather than as present.
 *
 * Runs only against a dedicated test database: the guard refuses before
 * connecting when TEST_DATABASE_URL is missing or points anywhere unsafe.
 */
const NOW_ISO = "2026-02-01T00:00:00.000Z";

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

/**
 * A throwaway database with the full schema applied.
 *
 * Each test gets its own, so CHECK violations and duplicate-key rejections
 * cannot leave half-written state behind for the next one.
 */
async function freshMigratedDatabase(): Promise<{ database: TestDatabase }> {
  const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
  await admin.execute(`CREATE DATABASE "${databaseName}"`);
  createdDatabases.push(databaseName);
  const database = createTestDatabaseForUrl(tempDatabaseUrl(databaseName));
  const applied = (await runMigrations(database, resolve("migrations"))).applied;
  expect(applied).toContain("0015_research_report_snapshots.sql");
  return { database };
}

async function seedSession(database: TestDatabase): Promise<string> {
  const projectId = newId();
  const sessionId = newId();
  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'report-snapshots', '{}'::jsonb)`
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

/** A full snapshot row, assembled so each DB rule can be broken on its own. */
async function insertSnapshotRow(
  database: TestDatabase,
  sessionId: string,
  overrides: {
    id?: string;
    version?: number;
    createdBy?: string;
    reportSchemaVersion?: number;
    materialsFingerprint?: string;
    snapshotHash?: string;
    reportPayload?: string;
    sourceReferences?: string;
    evidenceReferences?: string;
    claimReferences?: string;
    reviewReferences?: string;
    monitoringReferences?: string;
    idempotencyKey?: string | null;
  } = {}
): Promise<string> {
  const id = overrides.id ?? newId();
  const version = overrides.version ?? 1;
  const createdBy = overrides.createdBy ?? "reviewer (alice)";
  const schemaVersion = overrides.reportSchemaVersion ?? 1;
  const fingerprint = overrides.materialsFingerprint ?? "a".repeat(16);
  const hash = overrides.snapshotHash ?? "b".repeat(64);
  const payload =
    overrides.reportPayload ??
    `'{"sessionId":"${sessionId}","materialsFingerprint":"${fingerprint}","findings":[],"gaps":{"unresolvedConflicts":[]}}'::jsonb`;
  const idempotencyKey =
    overrides.idempotencyKey === undefined || overrides.idempotencyKey === null
      ? "NULL"
      : `'${overrides.idempotencyKey}'`;
  await database.execute(
    sql.raw(`
      INSERT INTO research_report_snapshots (id, session_id, version, created_by,
                                             report_schema_version, materials_fingerprint,
                                             snapshot_hash, report_payload, source_references,
                                             evidence_references, claim_references,
                                             review_references, monitoring_references,
                                             idempotency_key)
      VALUES ('${id}', '${sessionId}', ${version}, '${createdBy}', ${schemaVersion},
              '${fingerprint}', '${hash}', ${payload},
              ${overrides.sourceReferences ?? "'[]'::jsonb"},
              ${overrides.evidenceReferences ?? "'[]'::jsonb"},
              ${overrides.claimReferences ?? "'[]'::jsonb"},
              ${overrides.reviewReferences ?? "'[]'::jsonb"},
              ${overrides.monitoringReferences ?? "'[]'::jsonb"},
              ${idempotencyKey})
    `)
  );
  return id;
}

/**
 * The Postgres error behind a rejected statement.
 *
 * A failed `execute` surfaces the driver error itself, whose `code` is the
 * SQLSTATE and whose `constraint_name` names the rule that fired. `23514` is a
 * check violation; a value Postgres cannot even parse fails earlier with
 * `22P02` and names no constraint. Telling the two apart is what proves the
 * constraint itself is doing the rejecting.
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

describe("0015 report snapshots migration", () => {
  it("creates the table and can be rolled back and re-applied", async () => {
    const { database } = await freshMigratedDatabase();

    expect(await tableExists(database, "research_report_snapshots")).toBe(true);

    for (const statement of await statements(
      "rollback/0015_research_report_snapshots.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await tableExists(database, "research_report_snapshots")).toBe(false);
    expect(await ledger(database)).not.toContain(
      "0015_research_report_snapshots.sql"
    );

    const reapplied = (await runMigrations(database, resolve("migrations")))
      .applied;
    expect(reapplied).toContain("0015_research_report_snapshots.sql");
    expect(await tableExists(database, "research_report_snapshots")).toBe(true);

    // A down script only undoes its own migration: rolling 0015 back through
    // the ledger (newest first) must leave the older migrations' down scripts
    // working, here proven with 0014's, whose sources 0015 references.
    await rollbackMigrationsAfter(database, "0014_source_monitoring.sql");
    expect(await tableExists(database, "research_report_snapshots")).toBe(false);
    for (const statement of await statements(
      "rollback/0014_source_monitoring.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await tableExists(database, "source_checks")).toBe(false);
  });

  it("refuses a version that was never numbered and an unattributed save", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);

    const zero = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionId, { version: 0 })
    );
    expect(zero.code).toBe("23514");
    expect(zero.constraint).toBe("research_report_snapshots_version_check");

    const negative = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionId, { version: -1 })
    );
    expect(negative.constraint).toBe("research_report_snapshots_version_check");

    // History nobody owns is history nobody can be asked about.
    const anonymous = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionId, { createdBy: "" })
    );
    expect(anonymous.code).toBe("23514");
    expect(anonymous.constraint).toBe(
      "research_report_snapshots_created_by_check"
    );

    const blank = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionId, { createdBy: "   " })
    );
    expect(blank.constraint).toBe("research_report_snapshots_created_by_check");
  });

  it("keeps the payload declared, sized and array-shaped", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);

    const wrongSchema = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionId, { reportSchemaVersion: 0 })
    );
    expect(wrongSchema.code).toBe("23514");
    expect(wrongSchema.constraint).toBe(
      "research_report_snapshots_schema_version_check"
    );

    const shortFingerprint = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionId, { materialsFingerprint: "abc" })
    );
    expect(shortFingerprint.constraint).toBe(
      "research_report_snapshots_fingerprint_check"
    );

    const shortHash = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionId, { snapshotHash: "abc" })
    );
    expect(shortHash.constraint).toBe("research_report_snapshots_hash_check");

    const scalarPayload = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionId, { reportPayload: "'5'::jsonb" })
    );
    expect(scalarPayload.code).toBe("23514");
    expect(scalarPayload.constraint).toBe(
      "research_report_snapshots_payload_object_check"
    );

    const notAnArray = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionId, {
        sourceReferences: "'{\"sourceId\":\"x\"}'::jsonb"
      })
    );
    expect(notAnArray.code).toBe("23514");
    expect(notAnArray.constraint).toBe(
      "research_report_snapshots_source_references_array_check"
    );
  });

  it("allows one version number per session and one snapshot per key, scoped by session", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionA = await seedSession(database);
    const sessionB = await seedSession(database);

    await insertSnapshotRow(database, sessionA, {
      version: 1,
      idempotencyKey: "save-1"
    });

    const secondVersionOne = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionA, {
        version: 1,
        idempotencyKey: "save-2"
      })
    );
    expect(
      secondVersionOne.constraint ?? secondVersionOne.code
    ).toMatch(/research_report_snapshots_session_version_idx|23505/);

    const sameKeyAgain = await rejectedStatement(() =>
      insertSnapshotRow(database, sessionA, {
        version: 2,
        idempotencyKey: "save-1"
      })
    );
    expect(sameKeyAgain.constraint ?? sameKeyAgain.code).toMatch(
      /research_report_snapshots_session_idempotency_idx|23505/
    );

    // The same key in another session is different work: the index is scoped.
    await insertSnapshotRow(database, sessionB, {
      version: 1,
      idempotencyKey: "save-1"
    });
    const rows = (await database.execute(
      sql.raw("select session_id from research_report_snapshots")
    )) as unknown as Array<{ session_id: string }>;
    expect(rows).toHaveLength(2);

    // Ordinary saves carry no key at all and are unaffected by the index.
    await insertSnapshotRow(database, sessionA, { version: 3 });
    await insertSnapshotRow(database, sessionA, { version: 4 });
    const all = (await database.execute(
      sql.raw("select version from research_report_snapshots order by version")
    )) as unknown as Array<{ version: number }>;
    // Nothing was written by either rejected attempt: the second "version 1"
    // and the duplicate key both rolled back on their own.
    expect(all.map((row) => row.version)).toEqual([1, 1, 3, 4]);
  });
});

describe("report snapshot repository", () => {
  async function seeded(): Promise<{
    database: TestDatabase;
    repository: ReportSnapshotRepository;
    sessionId: string;
  }> {
    const { database } = await freshMigratedDatabase();
    return {
      database,
      repository: new ReportSnapshotRepository(database),
      sessionId: await seedSession(database)
    };
  }

  it("saves a version with its audit event in one transaction and lists it without the payload", async () => {
    const { database, repository, sessionId } = await seeded();
    const snapshotId = newId();

    const snapshot = await database.transaction(async (transaction) => {
      return repository.insertSnapshot(transaction, {
        snapshot: {
          id: snapshotId,
          sessionId,
          version: 1,
          createdBy: "reviewer (alice)",
          researchQuestion: "成本是否下降？",
          reportSchemaVersion: 1,
          materialsFingerprint: "a".repeat(16),
          snapshotHash: "c".repeat(64),
          reportPayload: { hello: "world" },
          sourceReferences: [
            {
              sourceId: newId(),
              snapshotId: newId(),
              contentHash: "d".repeat(64),
              title: "季度报告",
              retrievedAt: NOW_ISO
            }
          ],
          evidenceReferences: [],
          claimReferences: [],
          reviewReferences: [],
          monitoringReferences: [],
          changeReason: "定稿",
          idempotencyKey: "key-a"
        },
        event: {
          correlationId: snapshotId,
          type: "REPORT_SNAPSHOT_CREATED",
          payload: { snapshotId, version: 1 }
        }
      });
    });

    expect(snapshot.snapshot).toMatchObject({
      snapshotId,
      sessionId,
      version: 1,
      createdBy: "reviewer (alice)",
      changeReason: "定稿"
    });
    expect(snapshot.snapshot.sourceReferences[0]?.present).toBe(false);

    const summaries = await repository.listSummaries(sessionId);
    expect(summaries).toHaveLength(1);
    // The list is a table of contents: it must not carry every payload.
    expect(
      Object.keys(summaries[0] ?? {}).includes("reportPayload")
    ).toBe(false);
    expect(summaries[0]?.sourceCount).toBe(1);

    expect(await repository.maxVersion(sessionId)).toBe(1);
  });

  it("reports a cited capture as absent once it is gone, and reads by key and version", async () => {
    const { database, repository, sessionId } = await seeded();
    const sourceId = newId();
    const snapshotRowId = newId();

    await database.execute(
      sql.raw(`
        INSERT INTO sources (id, session_id, title, kind, url, canonical_url, created_by)
        VALUES ('${sourceId}', '${sessionId}', '季度报告', 'url',
                'https://example.org/a', 'https://example.org/a', 'human')
      `)
    );
    await database.execute(
      sql.raw(`
        INSERT INTO source_snapshots (id, session_id, source_id, canonical_url, content_hash,
                                      title, content_type, content, content_bytes, char_count, retrieved_at)
        VALUES ('${snapshotRowId}', '${sessionId}', '${sourceId}', 'https://example.org/a',
                '${"e".repeat(64)}', '季度报告', 'text/html', '正文', 2, 2, now())
      `)
    );

    const captured = await database.transaction(
      async (transaction) =>
        (
          await repository.insertSnapshot(transaction, {
            snapshot: {
              id: newId(),
              sessionId,
              version: 1,
              createdBy: "reviewer (alice)",
              researchQuestion: null,
              reportSchemaVersion: 1,
              materialsFingerprint: "a".repeat(16),
              snapshotHash: "f".repeat(64),
              reportPayload: { hello: "world" },
              sourceReferences: [
                {
                  sourceId,
                  snapshotId: snapshotRowId,
                  contentHash: "e".repeat(64),
                  title: "季度报告",
                  retrievedAt: NOW_ISO
                }
              ],
              evidenceReferences: [],
              claimReferences: [],
              reviewReferences: [],
              monitoringReferences: [],
              changeReason: null,
              idempotencyKey: "key-b"
            },
            event: {
              correlationId: newId(),
              type: "REPORT_SNAPSHOT_CREATED",
              payload: {}
            }
          })
        ).snapshot
    );

    expect(captured.sourceReferences[0]?.present).toBe(true);
    expect(await repository.findByVersion(sessionId, 1)).toMatchObject({
      snapshotId: captured.snapshotId
    });
    expect(
      await repository.findByIdempotencyKey(sessionId, "key-b")
    ).toMatchObject({ snapshotId: captured.snapshotId });
    // Another session cannot reach it.
    const otherSession = await seedSession(database);
    await expect(
      repository.getSnapshot(otherSession, captured.snapshotId)
    ).rejects.toThrow(/not found/i);
  });
});
