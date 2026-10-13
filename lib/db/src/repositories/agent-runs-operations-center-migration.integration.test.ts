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
 * 0016 widens the single `agent_runs` table for the Agent Operations Center.
 *
 * What only a real database can prove here:
 *  1. the up migration lands every new column, the newest-first index, and the
 *     three CHECK constraints; the documented down script really removes all of
 *     them and clears the ledger, so a later `db:migrate` re-applies instead of
 *     silently skipping;
 *  2. the honesty rules are enforced by PostgreSQL, not only by Zod — an error
 *     code outside the closed set, a non-positive attempt, and a non-object
 *     token usage are all rejected by name;
 *  3. the down script undoes only 0016: rolling back through the ledger leaves
 *     the older migrations' down scripts (proven with 0015's) still working.
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

const NEW_COLUMNS = [
  "task_type",
  "error_code",
  "provider",
  "model",
  "attempt",
  "parent_run_id",
  "token_usage",
  "created_at",
  "duration_ms"
];

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
  expect(applied).toContain("0016_agent_runs_operations_center.sql");
  return { database };
}

/** The minimal FK chain an `agent_runs` row needs: session, role, prompt. */
async function seedRunChain(
  database: TestDatabase
): Promise<{ sessionId: string; roleId: string; promptVersionId: string }> {
  const projectId = newId();
  const sessionId = newId();
  const roleId = newId();
  const promptVersionId = newId();
  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'agent-runs-0016', '{}'::jsonb)`
    )
  );
  await database.execute(
    sql.raw(`
      INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence)
      VALUES ('${sessionId}', '${projectId}', 'zh-CN', 'CREATED', 'ACTIVE', 1)
    `)
  );
  await database.execute(
    sql.raw(
      `INSERT INTO prompt_versions (id, name, version, content) VALUES ('${promptVersionId}', 'challenger', '${promptVersionId}', 'Challenge the claim.')`
    )
  );
  await database.execute(
    sql.raw(`
      INSERT INTO agent_roles (id, key, name, goal, perspective, evaluation_criteria,
                               evidence_required, conflict_preference, lenses, prompt_version_id)
      VALUES ('${roleId}', '${roleId}', '质疑者', 'g', 'p',
              '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '${promptVersionId}')
    `)
  );
  return { sessionId, roleId, promptVersionId };
}

/** One `agent_runs` INSERT assembled from overrides, so each rule has one diff. */
async function insertRun(
  database: TestDatabase,
  chain: { sessionId: string; roleId: string; promptVersionId: string },
  overrides: {
    errorCode?: string | null;
    attempt?: number;
    tokenUsage?: string;
  } = {}
): Promise<void> {
  const errorCode =
    overrides.errorCode === undefined || overrides.errorCode === null
      ? "NULL"
      : `'${overrides.errorCode}'`;
  const attempt =
    overrides.attempt === undefined ? "DEFAULT" : `${overrides.attempt}`;
  const tokenUsage = overrides.tokenUsage ?? "NULL";
  await database.execute(
    sql.raw(`
      INSERT INTO agent_runs (id, session_id, role_id, prompt_version_id, status,
                              error_code, attempt, token_usage)
      VALUES ('${newId()}', '${chain.sessionId}', '${chain.roleId}', '${chain.promptVersionId}',
              'failed', ${errorCode}, ${attempt}, ${tokenUsage})
    `)
  );
}

describe("0016 agent runs operations center migration", () => {
  it("widens agent_runs, then rolls back and re-applies cleanly", async () => {
    const { database } = await freshMigratedDatabase();

    // up: every new column and the index are present.
    const landed = await columns(database, "agent_runs");
    for (const column of NEW_COLUMNS) {
      expect(landed).toContain(column);
    }
    expect(await indexExists(database, "agent_runs_session_created_idx")).toBe(
      true
    );

    // down: all of them are gone and the ledger forgets 0016.
    for (const statement of await statements(
      "rollback/0016_agent_runs_operations_center.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    const rolledBack = await columns(database, "agent_runs");
    for (const column of NEW_COLUMNS) {
      expect(rolledBack).not.toContain(column);
    }
    expect(await indexExists(database, "agent_runs_session_created_idx")).toBe(
      false
    );
    expect(await ledger(database)).not.toContain(
      "0016_agent_runs_operations_center.sql"
    );

    // re-apply: a later db:migrate re-applies rather than silently skipping.
    const reapplied = (await runMigrations(database, resolve("migrations")))
      .applied;
    expect(reapplied).toContain("0016_agent_runs_operations_center.sql");
    const again = await columns(database, "agent_runs");
    for (const column of NEW_COLUMNS) {
      expect(again).toContain(column);
    }

    // down undoes only 0016: rolling it back through the ledger leaves 0015's
    // down script working — 0016's self-reference must not have coupled them.
    await rollbackMigrationsAfter(database, "0015_research_report_snapshots.sql");
    expect(await indexExists(database, "agent_runs_session_created_idx")).toBe(
      false
    );
    for (const statement of await statements(
      "rollback/0015_research_report_snapshots.down.sql"
    )) {
      await database.execute(sql.raw(statement));
    }
    const afterOldRollback = await columns(database, "research_report_snapshots");
    expect(afterOldRollback).toHaveLength(0);
  });

  it("keeps the failure-code set closed at the database level", async () => {
    const { database } = await freshMigratedDatabase();
    const chain = await seedRunChain(database);

    await expect(
      insertRun(database, chain, { errorCode: "not_a_real_code" })
    ).rejects.toThrow(/agent_runs_error_code_check/i);

    // A code inside the closed set, and the honest "none recorded", both store.
    await insertRun(database, chain, { errorCode: "cancelled_by_user" });
    await insertRun(database, chain, { errorCode: null });
    const rows = (await database.execute(
      sql.raw("select error_code from agent_runs order by created_at")
    )) as unknown as Array<{ error_code: string | null }>;
    expect(rows.map((row) => row.error_code)).toEqual([
      "cancelled_by_user",
      null
    ]);
  });

  it("keeps attempt positive and token usage object-shaped", async () => {
    const { database } = await freshMigratedDatabase();
    const chain = await seedRunChain(database);

    await expect(insertRun(database, chain, { attempt: 0 })).rejects.toThrow(
      /agent_runs_attempt_check/i
    );

    await expect(
      insertRun(database, chain, { tokenUsage: `'["prompt"]'::jsonb` })
    ).rejects.toThrow(/agent_runs_token_usage_object_check/i);

    // A real object is stored; a missing one stays NULL (the UI says 未提供).
    await insertRun(database, chain, {
      tokenUsage: `'{"promptTokens":3,"completionTokens":4,"totalTokens":7}'::jsonb`
    });
    await insertRun(database, chain, { tokenUsage: "NULL" });
    const rows = (await database.execute(
      sql.raw("select token_usage from agent_runs order by created_at")
    )) as unknown as Array<{ token_usage: unknown }>;
    expect(rows[0]?.token_usage).toMatchObject({ totalTokens: 7 });
    expect(rows[1]?.token_usage).toBeNull();
  });
});
