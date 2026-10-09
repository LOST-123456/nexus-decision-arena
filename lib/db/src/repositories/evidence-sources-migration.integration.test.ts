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
 * 0005 is the only migration in this branch that rewrites an existing table
 * (single-claim evidence -> multi-claim evidence with citable sources), so it
 * ships with a manual rollback script. This test proves both directions on a
 * throwaway database: the up migration backfills real rows, and the documented
 * down script restores the previous shape without losing the claim link.
 *
 * It also pins the *limit* of the rollback: the down script restores
 * `claims.agent_run_id NOT NULL`, which is only reachable while every claim is
 * agent-authored. A used workspace (human-authored claims) cannot be rolled
 * back, and the test asserts that the script refuses rather than corrupting
 * data. Tests and docs must agree on this, so both behaviours are covered here.
 *
 * Runs only against a dedicated test database: the guard refuses before
 * connecting when TEST_DATABASE_URL is missing or points anywhere unsafe.
 */
const databaseUrl = resolveTestDatabaseUrl().toString();
const admin = createTestAdminDatabase();

const tempDatabaseUrl = (databaseName: string) => {
  assertDisposableDatabaseName(databaseName);
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
};

afterAll(async () => {
  await admin.end();
});

async function statements(file: string): Promise<string[]> {
  const contents = await readFile(resolve("migrations", file), "utf8");
  return contents
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function columns(
  database: ReturnType<typeof createTestDatabaseForUrl>,
  table: string
): Promise<string[]> {
  const rows = (await database.execute(
    sql.raw(
      `select column_name from information_schema.columns where table_name = '${table}'`
    )
  )) as unknown as Array<{ column_name: string }>;
  return rows.map((row) => row.column_name);
}

type TestDatabase = ReturnType<typeof createTestDatabaseForUrl>;

/** Creates the throwaway database, runs 0001-0005, and returns a handle. */
async function freshMigratedDatabase(): Promise<{
  databaseName: string;
  database: TestDatabase;
}> {
  const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
  await admin.execute(`CREATE DATABASE "${databaseName}"`);
  const database = createTestDatabaseForUrl(tempDatabaseUrl(databaseName));
  const applied = (await runMigrations(database, resolve("migrations"))).applied;
  expect(applied).toContain("0005_evidence_sources.sql");
  return { databaseName, database };
}

/** Seeds a project + session and returns the session id. */
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

/**
 * Seeds a claim that satisfies the pre-0005 constraints (`agent_run_id` and
 * `role_id` NOT NULL) so the documented rollback script can actually run.
 */
async function seedAgentAuthoredClaim(
  database: TestDatabase,
  sessionId: string
): Promise<string> {
  const promptVersionId = newId();
  const roleId = newId();
  const runId = newId();
  const claimId = newId();

  await database.execute(
    sql.raw(`
      INSERT INTO prompt_versions (id, name, version, content)
      VALUES ('${promptVersionId}', 'researcher', 'v1', 'prompt body')
    `)
  );
  await database.execute(
    sql.raw(`
      INSERT INTO agent_roles (id, key, name, goal, perspective, evaluation_criteria, evidence_required, conflict_preference, lenses, prompt_version_id)
      VALUES ('${roleId}', 'market-analyst', 'Market Analyst', 'Assess demand', 'skeptical', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '${promptVersionId}')
    `)
  );
  await database.execute(
    sql.raw(`
      INSERT INTO agent_runs (id, session_id, role_id, prompt_version_id, status)
      VALUES ('${runId}', '${sessionId}', '${roleId}', '${promptVersionId}', 'succeeded')
    `)
  );
  await database.execute(
    sql.raw(`
      INSERT INTO claims (id, session_id, agent_run_id, role_id, lens, statement, type, stance, importance, confidence, evidence_ids, status, root_claim_id, revision, relations)
      VALUES ('${claimId}', '${sessionId}', '${runId}', '${roleId}', 'market', 'Agent claim.', 'fact', 'support', 3, 0.5, '[]'::jsonb, 'proposed', '${claimId}', 1, '[]'::jsonb)
    `)
  );
  return claimId;
}

/** Seeds an empty claim (agent_run_id / role_id NULL: the post-0005 shape). */
async function seedHumanAuthoredClaim(
  database: TestDatabase,
  sessionId: string
): Promise<string> {
  const claimId = newId();
  await database.execute(
    sql.raw(`
      INSERT INTO claims (id, session_id, lens, statement, type, stance, importance, confidence, evidence_ids, status, root_claim_id, revision, relations)
      VALUES ('${claimId}', '${sessionId}', 'market', 'Human claim.', 'fact', 'support', 3, 0.5, '[]'::jsonb, 'proposed', '${claimId}', 1, '[]'::jsonb)
    `)
  );
  return claimId;
}

async function seedEvidence(
  database: TestDatabase,
  sessionId: string,
  claimId: string
): Promise<string> {
  const evidenceId = newId();
  await database.execute(
    sql.raw(`
      INSERT INTO evidence (id, session_id, claim_ids, kind, title, content, description, direction, reliability, verification_status, retrieved_at, created_by)
      VALUES ('${evidenceId}', '${sessionId}', '["${claimId}"]'::jsonb, 'external_reference', 'Excerpt', 'Body', 'Why it matters', 'supports', 0.7, 'unverified', now(), 'human')
    `)
  );
  return evidenceId;
}

describe("0005 evidence sources migration", () => {
  it("backfills existing evidence and can be rolled back and re-applied", async () => {
    const { databaseName, database } = await freshMigratedDatabase();

    try {
      const sessionId = await seedSession(database);
      const claimId = await seedAgentAuthoredClaim(database, sessionId);
      const evidenceId = await seedEvidence(database, sessionId, claimId);

      expect(await columns(database, "evidence")).toContain("claim_ids");

      // The new view must be readable in the post-0005 shape before rolling back.
      await database.execute(sql.raw("select 1 from claim_inspector_view limit 1"));

      // --- roll back ---
      for (const statement of await statements(
        "rollback/0005_evidence_sources.down.sql"
      )) {
        await database.execute(sql.raw(statement));
      }

      const rolledBack = await columns(database, "evidence");
      expect(rolledBack).toContain("claim_id");
      expect(rolledBack).not.toContain("claim_ids");
      expect(rolledBack).not.toContain("verified_by");
      expect(rolledBack).not.toContain("source_id");

      const sources = (await database.execute(
        sql.raw("select to_regclass('public.sources') is null as absent")
      )) as unknown as Array<{ absent: boolean }>;
      expect(sources[0]?.absent).toBe(true);

      // The claim link must survive the rollback...
      const link = (await database.execute(
        sql.raw(
          `select claim_id::text as claim_id from evidence where id = '${evidenceId}'`
        )
      )) as unknown as Array<{ claim_id: string }>;
      expect(link[0]?.claim_id).toBe(claimId);

      // ...and the recreated view must query the restored column, not claim_ids.
      const inspected = (await database.execute(
        sql.raw("select count(*)::int as total from claim_inspector_view")
      )) as unknown as Array<{ total: number }>;
      expect(inspected[0]?.total).toBe(1);

      // --- re-apply; the down script clears its ledger row, so this is a real re-run ---
      const reapplied = await runMigrations(database, resolve("migrations"));
      expect(reapplied.applied).toContain("0005_evidence_sources.sql");
      const finalColumns = await columns(database, "evidence");
      expect(finalColumns).toContain("claim_ids");
      expect(finalColumns).not.toContain("claim_id");

      const backfilled = (await database.execute(
        sql.raw(
          `select claim_ids::text as claim_ids from evidence where id = '${evidenceId}'`
        )
      )) as unknown as Array<{ claim_ids: string }>;
      expect(backfilled[0]?.claim_ids).toBe(`["${claimId}"]`);

      // 0005 rebuilds the view against claim_ids; it must be usable again.
      const reInspected = (await database.execute(
        sql.raw("select count(*)::int as total from claim_inspector_view")
      )) as unknown as Array<{ total: number }>;
      expect(reInspected[0]?.total).toBe(1);
    } finally {
      await database.end();
      await admin.execute(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
  }, 60_000);

  it("rollback refuses once a human-authored claim exists", async () => {
    const { databaseName, database } = await freshMigratedDatabase();

    try {
      const sessionId = await seedSession(database);
      const claimId = await seedHumanAuthoredClaim(database, sessionId);
      await seedEvidence(database, sessionId, claimId);

      const failure = async () => {
        for (const statement of await statements(
          "rollback/0005_evidence_sources.down.sql"
        )) {
          await database.execute(sql.raw(statement));
        }
      };

      // The script restores `claims.agent_run_id NOT NULL`; with a human claim
      // present that is impossible, and the rollback must fail loudly.
      await expect(failure()).rejects.toThrow(/agent_run_id/);

      // Evidence itself already moved back to the single-claim shape before the
      // failure, which is why this is documented as a manual, guarded script.
      expect(await columns(database, "evidence")).toContain("claim_id");
    } finally {
      await database.end();
      await admin.execute(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
  }, 60_000);
});
