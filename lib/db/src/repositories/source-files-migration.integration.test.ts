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

/**
 * 0013 adds the local research-file ledger: one row per uploaded file, its
 * content identity, and how the read settled.
 *
 * What only a real database can prove here:
 *  1. the up migration lands the table, the four CHECK constraints that keep the
 *     outcome vocabulary closed, and the uniqueness that makes identical bytes
 *     one row per session;
 *  2. those limits are enforced by PostgreSQL, not only by Zod — an out-of-set
 *     kind, an out-of-set status, a `failed` row without a reason and a
 *     `source_id` on a row that never parsed are all rejected;
 *  3. the documented down script really removes the table and clears the ledger
 *     row, so a later `db:migrate` re-applies instead of silently skipping.
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
  const contents = await readFile(resolve("migrations", file), "utf8");
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
 * A down script only undoes its own migration, so it must not have to cope with
 * objects a later migration adds. The list comes from the ledger rather than a
 * hard-coded filename, so adding a migration does not silently invalidate this
 * test.
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

async function freshMigratedDatabase(): Promise<{
  databaseName: string;
  database: TestDatabase;
}> {
  const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
  await admin.execute(`CREATE DATABASE "${databaseName}"`);
  createdDatabases.push(databaseName);
  const database = createTestDatabaseForUrl(tempDatabaseUrl(databaseName));
  const applied = (await runMigrations(database, resolve("migrations"))).applied;
  expect(applied).toContain("0013_source_files.sql");
  await rollbackMigrationsAfter(database, "0013_source_files.sql");
  return { databaseName, database };
}

async function seedSession(database: TestDatabase): Promise<string> {
  const projectId = newId();
  const sessionId = newId();
  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'file-migration', '{}'::jsonb)`
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

async function seedSource(database: TestDatabase, sessionId: string): Promise<string> {
  const sourceId = newId();
  await database.execute(
    sql.raw(`
      INSERT INTO sources (id, session_id, title, kind, url, canonical_url, created_by)
      VALUES ('${sourceId}', '${sessionId}', 'notes.txt', 'document', 'file:///sha256/abc', 'file:///sha256/abc', 'human')
    `)
  );
  return sourceId;
}

/** One INSERT assembled from the caller's overrides, so each rule has one diff. */
async function insertFile(
  database: TestDatabase,
  sessionId: string,
  overrides: Partial<{
    id: string;
    detectedKind: string;
    parseStatus: string;
    parseError: string | null;
    sourceId: string | null;
    sha256: string;
  }> = {}
): Promise<void> {
  const id = overrides.id ?? newId();
  const detectedKind = overrides.detectedKind ?? "txt";
  const parseStatus = overrides.parseStatus ?? "parsed";
  const parseError =
    overrides.parseError === undefined ? null : overrides.parseError;
  const sourceId =
    overrides.sourceId === undefined ? null : overrides.sourceId;
  const sha256 = overrides.sha256 ?? newId().replaceAll("-", "");
  const error = parseError === null ? "NULL" : `'${parseError}'`;
  const source = sourceId === null ? "NULL" : `'${sourceId}'`;
  await database.execute(
    sql.raw(`
      INSERT INTO source_files
        (id, session_id, source_id, file_name, declared_mime_type, detected_kind,
         byte_size, sha256, parse_status, parse_error, parse_stats, storage_key, parser_version)
      VALUES ('${id}', '${sessionId}', ${source}, 'notes.txt', 'application/octet-stream',
              '${detectedKind}', 10, '${sha256}', '${parseStatus}', ${error},
              NULL, '${sessionId}/${id}', 'nexus-file-parsers@1')
    `)
  );
}

describe("0013 source files migration", () => {
  it("creates the ledger and can be rolled back and re-applied", async () => {
    const { database } = await freshMigratedDatabase();

    expect(await tableExists(database, "source_files")).toBe(true);

    for (const statement of await statements(
      "rollback/0013_source_files.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await tableExists(database, "source_files")).toBe(false);
    expect(await ledger(database)).not.toContain("0013_source_files.sql");

    const reapplied = (await runMigrations(database, resolve("migrations")))
      .applied;
    expect(reapplied).toContain("0013_source_files.sql");
    expect(await tableExists(database, "source_files")).toBe(true);
  });

  it("refuses a kind or status outside the closed sets", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);

    await expect(
      insertFile(database, sessionId, { detectedKind: "xlsx" })
    ).rejects.toThrow(/detected_kind/i);
    await expect(
      insertFile(database, sessionId, { parseStatus: "parsed_by_ai" })
    ).rejects.toThrow(/parse_status/i);
  });

  it("refuses a failure that does not say why", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);

    await expect(
      insertFile(database, sessionId, {
        parseStatus: "failed",
        parseError: null
      })
    ).rejects.toThrow(/failed_has_error/i);

    // With a reason the same row is accepted, and stays visible as a failure.
    await insertFile(database, sessionId, {
      parseStatus: "failed",
      parseError: "unreadable"
    });
    const rows = (await database.execute(
      sql.raw("select parse_status from source_files")
    )) as unknown as Array<{ parse_status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parse_status).toBe("failed");
  });

  it("refuses a source on a file that produced no text", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId);

    await expect(
      insertFile(database, sessionId, {
        parseStatus: "needs_ocr",
        sourceId
      })
    ).rejects.toThrow(/source_requires_parsed/i);

    await insertFile(database, sessionId, { parseStatus: "parsed", sourceId });
    const rows = (await database.execute(
      sql.raw("select source_id is not null as linked from source_files")
    )) as unknown as Array<{ linked: boolean }>;
    expect(rows[0]?.linked).toBe(true);
  });

  it("keeps identical bytes to one row per session, and separates sessions", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionA = await seedSession(database);
    const sessionB = await seedSession(database);
    const hash = "a".repeat(64);

    await insertFile(database, sessionA, { sha256: hash });
    await expect(
      insertFile(database, sessionA, { sha256: hash })
    ).rejects.toThrow(/session_hash|duplicate key/i);

    // The same document in another session is a different row: content identity
    // is scoped, never global.
    await insertFile(database, sessionB, { sha256: hash });
    const rows = (await database.execute(
      sql.raw("select session_id from source_files")
    )) as unknown as Array<{ session_id: string }>;
    expect(new Set(rows.map((row) => row.session_id)).size).toBe(2);
  });
});
