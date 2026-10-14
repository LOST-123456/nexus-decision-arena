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
 * 0017 adds the multilingual research tables.
 *
 * What only a real database can prove here:
 *  1. the up migration lands the three tables, the nullable
 *     `source_snapshots.source_language` column, the dedup unique index and the
 *     glossary uniqueness index; the documented down script really removes all
 *     of them and clears the ledger, so a later `db:migrate` re-applies instead
 *     of silently skipping;
 *  2. the honesty rules are enforced by PostgreSQL, not only by Zod — a target
 *     language outside the supported set, a lifecycle state outside the closed
 *     set, a review action or status outside their closed sets, and a second
 *     identical translation of the same snapshot version are all rejected by
 *     name;
 *  3. the earlier `language_detection` idea is *not* shipped: no code reads it,
 *     so the column is absent after up and there is nothing for down to undo;
 *  4. the down script undoes only 0017: rolling back through the ledger leaves
 *     0016's down script working.
 *
 * Runs only against a dedicated throwaway database: the guard refuses before
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

async function columns(
  database: TestDatabase,
  table: string
): Promise<string[]> {
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
    sql.raw(
      `select 1 as found from information_schema.tables where table_name = '${table}'`
    )
  )) as unknown as Array<{ found: number }>;
  return rows.length > 0;
}

async function indexExists(
  database: TestDatabase,
  index: string
): Promise<boolean> {
  const rows = (await database.execute(
    sql.raw(`select 1 as found from pg_indexes where indexname = '${index}'`)
  )) as unknown as Array<{ found: number }>;
  return rows.length > 0;
}

async function ledger(database: TestDatabase): Promise<string[]> {
  const rows = (await database.execute(
    sql.raw("select filename from schema_migrations order by filename")
  )) as unknown as Array<{ filename: string }>;
  return rows.map((row) => row.filename);
}

/**
 * Rolls back every migration applied after `filename`, newest first. The list
 * comes from the ledger, not a hard-coded filename, so adding a migration does
 * not silently invalidate this test.
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
  expect(applied).toContain("0017_multilingual_translations.sql");
  return { database };
}

/** The minimal FK chain a translation needs: session, source, snapshot. */
async function seedSnapshotChain(
  database: TestDatabase
): Promise<{ sessionId: string; snapshotId: string }> {
  const projectId = newId();
  const sessionId = newId();
  const sourceId = newId();
  const snapshotId = newId();
  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'multilingual-0017', '{}'::jsonb)`
    )
  );
  await database.execute(
    sql.raw(
      `INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence)
       VALUES ('${sessionId}', '${projectId}', 'zh-CN', 'EVIDENCE', 'ACTIVE', 1)`
    )
  );
  await database.execute(
    sql.raw(
      `INSERT INTO sources (id, session_id, title, kind, created_by)
       VALUES ('${sourceId}', '${sessionId}', 'Quarterly costs', 'document', 'researcher')`
    )
  );
  await database.execute(
    sql.raw(
      `INSERT INTO source_snapshots (id, session_id, source_id, canonical_url, content_hash,
                                     content_type, content, content_bytes, char_count, retrieved_at,
                                     source_language)
       VALUES ('${snapshotId}', '${sessionId}', '${sourceId}', 'https://example.org/costs',
               'hash-1', 'text/plain', 'Costs rose by 12%.', 17, 17, now(), 'en')`
    )
  );
  return { sessionId, snapshotId };
}

/** One `translations` INSERT assembled from overrides, so each rule has one diff. */
async function insertTranslation(
  database: TestDatabase,
  chain: { sessionId: string; snapshotId: string },
  overrides: {
    targetLanguage?: string;
    status?: string;
    textHash?: string;
    provider?: string;
    model?: string;
  } = {}
): Promise<void> {
  await database.execute(
    sql.raw(`
      INSERT INTO translations (id, session_id, source_snapshot_id, source_language,
                                target_language, text_hash, translated_text, segment_mappings,
                                provider, model, status, created_by)
      VALUES ('${newId()}', '${chain.sessionId}', '${chain.snapshotId}', 'en',
              '${overrides.targetLanguage ?? "zh-Hans"}',
              '${overrides.textHash ?? "hash-1"}',
              '成本上升了 12%。', '[]'::jsonb,
              '${overrides.provider ?? "deterministic-mock"}',
              '${overrides.model ?? "n/a"}',
              '${overrides.status ?? "completed"}', 'researcher')
    `)
  );
}

describe("0017 multilingual translations migration", () => {
  it("adds the multilingual tables, then rolls back and re-applies cleanly", async () => {
    const { database } = await freshMigratedDatabase();

    // up: the column, the three tables and both indexes are present.
    expect(await columns(database, "source_snapshots")).toContain(
      "source_language"
    );
    expect(await tableExists(database, "translations")).toBe(true);
    expect(await tableExists(database, "translation_reviews")).toBe(true);
    expect(await tableExists(database, "terminology")).toBe(true);
    expect(await indexExists(database, "translations_dedup_idx")).toBe(true);
    expect(await indexExists(database, "terminology_session_term_idx")).toBe(
      true
    );

    // The dropped `language_detection` idea is not shipped: no code reads it.
    expect(await columns(database, "source_snapshots")).not.toContain(
      "language_detection"
    );

    // down: all of them are gone and the ledger forgets 0017.
    for (const statement of await statements(
      "rollback/0017_multilingual_translations.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await columns(database, "source_snapshots")).not.toContain(
      "source_language"
    );
    expect(await tableExists(database, "translations")).toBe(false);
    expect(await tableExists(database, "translation_reviews")).toBe(false);
    expect(await tableExists(database, "terminology")).toBe(false);
    expect(await ledger(database)).not.toContain(
      "0017_multilingual_translations.sql"
    );

    // re-apply: a later db:migrate re-applies rather than silently skipping.
    const reapplied = (await runMigrations(database, resolve("migrations")))
      .applied;
    expect(reapplied).toContain("0017_multilingual_translations.sql");
    expect(await tableExists(database, "translations")).toBe(true);
    expect(await indexExists(database, "translations_dedup_idx")).toBe(true);

    // down undoes only 0017: rolling it back through the ledger leaves 0016's
    // down script working — 0017's self-reference must not have coupled them.
    await rollbackMigrationsAfter(
      database,
      "0016_agent_runs_operations_center.sql"
    );
    expect(await tableExists(database, "translations")).toBe(false);
    for (const statement of await statements(
      "rollback/0016_agent_runs_operations_center.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    expect(await columns(database, "agent_runs")).not.toContain("task_type");
  });

  it("keeps the language and lifecycle sets closed at the database level", async () => {
    const { database } = await freshMigratedDatabase();
    const chain = await seedSnapshotChain(database);

    // A target language outside the supported set is rejected by name.
    await expect(
      insertTranslation(database, chain, { targetLanguage: "latin" })
    ).rejects.toThrow(/translations_target_language_check/i);

    // A lifecycle state outside the closed set is rejected by name.
    await expect(
      insertTranslation(database, chain, { status: "done" })
    ).rejects.toThrow(/translations_status_check/i);

    // The honest states all store, including the "no provider" one.
    await insertTranslation(database, chain, { status: "completed" });
    await insertTranslation(database, chain, {
      status: "unavailable",
      textHash: "hash-2"
    });
    const rows = (await database.execute(
      sql.raw("select status from translations order by created_at")
    )) as unknown as Array<{ status: string }>;
    expect(rows.map((row) => row.status)).toEqual([
      "completed",
      "unavailable"
    ]);
  });

  it("keeps the review action and status sets closed at the database level", async () => {
    const { database } = await freshMigratedDatabase();
    const chain = await seedSnapshotChain(database);
    await insertTranslation(database, chain);

    const translationId = (
      (await database.execute(
        sql.raw("select id from translations limit 1")
      )) as unknown as Array<{ id: string }>
    )[0]!.id;

    const insertReview = async (
      action: string,
      reviewStatus: string
    ): Promise<void> => {
      await database.execute(
        sql.raw(`
          INSERT INTO translation_reviews (id, session_id, translation_id, reviewed_by,
                                           action, review_status)
          VALUES ('${newId()}', '${chain.sessionId}', '${translationId}', 'researcher',
                  '${action}', '${reviewStatus}')
        `)
      );
    };

    await expect(insertReview("like", "approved")).rejects.toThrow(
      /translation_reviews_action_check/i
    );
    await expect(insertReview("approve", "ok")).rejects.toThrow(
      /translation_reviews_review_status_check/i
    );

    // A real human ruling stores; the log is append-only by construction.
    await insertReview("approve", "approved");
    const rows = (await database.execute(
      sql.raw("select action, review_status from translation_reviews")
    )) as unknown as Array<{ action: string; review_status: string }>;
    expect(rows).toEqual([{ action: "approve", review_status: "approved" }]);
  });

  it("treats one snapshot version's identical translation as the same cache entry", async () => {
    const { database } = await freshMigratedDatabase();
    const chain = await seedSnapshotChain(database);

    await insertTranslation(database, chain);

    // The exact same snapshot version, languages, text, provider and model is
    // the same cache entry: the database refuses a second row.
    await expect(insertTranslation(database, chain)).rejects.toThrow(
      /translations_dedup_idx/i
    );

    // A different target language is a different entry, not a duplicate.
    await insertTranslation(database, chain, { targetLanguage: "ja" });
    // So is a different text (a new capture of the same page).
    await insertTranslation(database, chain, { textHash: "hash-2" });
    const rows = (await database.execute(
      sql.raw("select target_language, text_hash from translations order by created_at")
    )) as unknown as Array<{ target_language: string; text_hash: string }>;
    expect(rows).toEqual([
      { target_language: "zh-Hans", text_hash: "hash-1" },
      { target_language: "ja", text_hash: "hash-1" },
      { target_language: "zh-Hans", text_hash: "hash-2" }
    ]);
  });

  it("keeps one glossary entry per term per session", async () => {
    const { database } = await freshMigratedDatabase();
    const chain = await seedSnapshotChain(database);

    const insertTerm = async (sourceTerm: string): Promise<void> => {
      await database.execute(
        sql.raw(`
          INSERT INTO terminology (id, session_id, source_term, language)
          VALUES ('${newId()}', '${chain.sessionId}', '${sourceTerm}', 'en')
        `)
      );
    };

    await insertTerm("Headcount");
    // The same term twice in one session is one glossary entry.
    await expect(insertTerm("Headcount")).rejects.toThrow(
      /terminology_session_term_idx/i
    );
    // A different term is a different entry.
    await insertTerm("Gross margin");
    const rows = (await database.execute(
      sql.raw("select source_term from terminology order by source_term")
    )) as unknown as Array<{ source_term: string }>;
    expect(rows.map((row) => row.source_term)).toEqual([
      "Gross margin",
      "Headcount"
    ]);
  });
});
