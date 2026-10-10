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
 * 0007 adds the research-intake shape: retrieval state on `sources`, an
 * append-only `source_snapshots` table, and the locator anchors on `evidence`.
 *
 * This test proves three things on a throwaway database:
 *  1. the up migration lands the columns, the partial unique index and the
 *     CHECK constraints that keep the new value sets closed;
 *  2. the documented down script really removes them and clears the ledger row,
 *     so a later `db:migrate` re-applies instead of silently skipping;
 *  3. the *limits* that matter are enforced by the database, not only by Zod —
 *     a second source with the same canonical url in one session is rejected,
 *     while manual sources (no canonical url) stay unconstrained, and an
 *     unknown retrieval status is refused.
 *
 * Runs only against a dedicated test database: the guard refuses before
 * connecting when TEST_DATABASE_URL is missing or points anywhere unsafe.
 */
const databaseUrl = resolveTestDatabaseUrl().toString();
const admin = createTestAdminDatabase();

/**
 * Every throwaway database this file creates is dropped in `afterAll`, so a
 * failed assertion cannot leave one behind for the next run to trip over.
 */
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

async function columns(database: TestDatabase, table: string): Promise<string[]> {
  const rows = (await database.execute(
    sql.raw(
      `select column_name from information_schema.columns where table_name = '${table}'`
    )
  )) as unknown as Array<{ column_name: string }>;
  return rows.map((row) => row.column_name);
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

async function freshMigratedDatabase(): Promise<{
  databaseName: string;
  database: TestDatabase;
}> {
  const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
  await admin.execute(`CREATE DATABASE "${databaseName}"`);
  createdDatabases.push(databaseName);
  const database = createTestDatabaseForUrl(tempDatabaseUrl(databaseName));
  const applied = (await runMigrations(database, resolve("migrations"))).applied;
  expect(applied).toContain("0007_source_intake.sql");
  return { databaseName, database };
}

async function seedSession(database: TestDatabase): Promise<string> {
  const projectId = newId();
  const sessionId = newId();
  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'migration', '{}'::jsonb)`
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
  input: { title: string; canonicalUrl: string | null }
): Promise<string> {
  const sourceId = newId();
  const canonical =
    input.canonicalUrl === null ? "NULL" : `'${input.canonicalUrl}'`;
  await database.execute(
    sql.raw(`
      INSERT INTO sources (id, session_id, title, kind, url, canonical_url, created_by)
      VALUES ('${sourceId}', '${sessionId}', '${input.title}', 'url', 'https://example.test/a', ${canonical}, 'human')
    `)
  );
  return sourceId;
}

describe("0007 source intake migration", () => {
  it("adds the retrieval shape and can be rolled back and re-applied", async () => {
    const { database } = await freshMigratedDatabase();

    const sourceColumns = await columns(database, "sources");
    expect(sourceColumns).toContain("canonical_url");
    expect(sourceColumns).toContain("retrieval_status");
    expect(sourceColumns).toContain("retrieval_attempts");
    expect(sourceColumns).toContain("retrieved_at");
    expect(sourceColumns).toContain("retrieval_error");
    expect(sourceColumns).toContain("content_type");
    expect(sourceColumns).toContain("content_hash");
    expect(sourceColumns).toContain("content_bytes");

    const evidenceColumns = await columns(database, "evidence");
    expect(evidenceColumns).toContain("locator_kind");
    expect(evidenceColumns).toContain("locator_status");
    expect(evidenceColumns).toContain("anchor_text");
    expect(evidenceColumns).toContain("source_content_hash");

    expect(await tableExists(database, "source_snapshots")).toBe(true);

    // Roll back.
    for (const statement of await statements(
      "rollback/0007_source_intake.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }

    const rolledBackSources = await columns(database, "sources");
    expect(rolledBackSources).not.toContain("canonical_url");
    expect(rolledBackSources).not.toContain("retrieval_status");
    expect(rolledBackSources).not.toContain("content_hash");
    const rolledBackEvidence = await columns(database, "evidence");
    expect(rolledBackEvidence).not.toContain("locator_status");
    expect(rolledBackEvidence).not.toContain("anchor_text");
    expect(await tableExists(database, "source_snapshots")).toBe(false);
    expect(await ledger(database)).not.toContain("0007_source_intake.sql");

    // Re-apply.
    const reapplied = await runMigrations(database, resolve("migrations"));
    expect(reapplied.applied).toContain("0007_source_intake.sql");
    expect(await columns(database, "sources")).toContain("canonical_url");
    expect(await tableExists(database, "source_snapshots")).toBe(true);
  });

  it("enforces the new value sets and the canonical-url uniqueness rule", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);

    // One page per session: the second import of the same page is refused.
    await seedSource(database, sessionId, {
      title: "first",
      canonicalUrl: "https://example.test/story"
    });
    await expect(
      seedSource(database, sessionId, {
        title: "second",
        canonicalUrl: "https://example.test/story"
      })
    ).rejects.toThrow(/sources_session_canonical_url_idx|duplicate key/);

    // Manual sources carry no canonical url and stay unconstrained.
    await seedSource(database, sessionId, { title: "manual-a", canonicalUrl: null });
    await seedSource(database, sessionId, { title: "manual-b", canonicalUrl: null });

    // The retrieval status set is closed.
    await expect(
      database.execute(
        sql.raw(
          `UPDATE sources SET retrieval_status = 'guessed' WHERE title = 'first'`
        )
      )
    ).rejects.toThrow(/sources_retrieval_status_check/);

    // Fresh rows default to "not_requested" rather than an invented state.
    const rows = (await database.execute(
      sql.raw(
        `SELECT retrieval_status, retrieval_attempts FROM sources WHERE title = 'first'`
      )
    )) as unknown as Array<{
      retrieval_status: string;
      retrieval_attempts: number;
    }>;
    expect(rows[0]?.retrieval_status).toBe("not_requested");
    expect(rows[0]?.retrieval_attempts).toBe(0);
  });

  it("keeps older snapshots when a page is captured again", async () => {
    const { database } = await freshMigratedDatabase();
    const sessionId = await seedSession(database);
    const sourceId = await seedSource(database, sessionId, {
      title: "drifts",
      canonicalUrl: "https://example.test/drift"
    });

    const insertSnapshot = (hash: string, content: string) =>
      database.execute(
        sql.raw(`
          INSERT INTO source_snapshots
            (id, session_id, source_id, canonical_url, content_hash, content_type, content, content_bytes, char_count, retrieved_at)
          VALUES
            ('${newId()}', '${sessionId}', '${sourceId}', 'https://example.test/drift', '${hash}', 'text/html', '${content}', ${content.length}, ${content.length}, now())
        `)
      );

    await insertSnapshot("hash-v1", "first capture");
    await insertSnapshot("hash-v2", "second capture");
    // The same content hash twice is one version, not two rows.
    await expect(insertSnapshot("hash-v1", "first capture")).rejects.toThrow(
      /source_snapshots_version_idx|duplicate key/
    );

    const rows = (await database.execute(
      sql.raw(
        `SELECT content_hash FROM source_snapshots WHERE source_id = '${sourceId}' ORDER BY content_hash`
      )
    )) as unknown as Array<{ content_hash: string }>;
    expect(rows.map((row) => row.content_hash)).toEqual(["hash-v1", "hash-v2"]);
  });
});
