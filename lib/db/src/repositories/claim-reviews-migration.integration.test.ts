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
 * 0006 adds the `claim_reviews` table. It is purely additive, so the rollback
 * is a drop — but the ledger row has to be cleared too, otherwise a re-run
 * would skip the migration and leave the schema behind. This test proves both
 * directions and the re-apply on a throwaway database.
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

type TestDatabase = ReturnType<typeof createTestDatabaseForUrl>;

async function tableExists(database: TestDatabase, table: string) {
  const rows = (await database.execute(
    sql.raw(`select to_regclass('public.${table}') is null as absent`)
  )) as unknown as Array<{ absent: boolean }>;
  return rows[0]?.absent === false;
}

async function seedClaim(database: TestDatabase): Promise<{
  sessionId: string;
  claimId: string;
}> {
  const projectId = newId();
  const sessionId = newId();
  const claimId = newId();
  await database.execute(
    sql.raw(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'reviews', '{}'::jsonb)`
    )
  );
  await database.execute(
    sql.raw(`
      INSERT INTO decision_sessions (id, project_id, locale, phase, operational_status, next_event_sequence)
      VALUES ('${sessionId}', '${projectId}', 'zh-CN', 'ANALYZING', 'ACTIVE', 1)
    `)
  );
  await database.execute(
    sql.raw(`
      INSERT INTO claims (id, session_id, lens, statement, type, stance, importance, confidence, evidence_ids, status, root_claim_id, revision, relations)
      VALUES ('${claimId}', '${sessionId}', 'research', 'Human claim.', 'fact', 'support', 3, 0.5, '[]'::jsonb, 'proposed', '${claimId}', 1, '[]'::jsonb)
    `)
  );
  return { sessionId, claimId };
}

describe("0006 claim reviews migration", () => {
  it("creates, drops and re-applies the claim_reviews table", async () => {
    const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    const database = createTestDatabaseForUrl(tempDatabaseUrl(databaseName));

    try {
      const applied = (await runMigrations(database, resolve("migrations")))
        .applied;
      expect(applied).toContain("0006_claim_reviews.sql");
      expect(await tableExists(database, "claim_reviews")).toBe(true);

      const { sessionId, claimId } = await seedClaim(database);
      const reviewId = newId();
      await database.execute(
        sql.raw(`
          INSERT INTO claim_reviews (id, session_id, claim_id, outcome, rationale, reviewer, verdict_status_at_review, verdict_confidence_at_review)
          VALUES ('${reviewId}', '${sessionId}', '${claimId}', 'confirmed', 'Checked page 14.', 'Owner (owner)', 'supported', 0.6)
        `)
      );

      for (const statement of await statements(
        "rollback/0006_claim_reviews.down.sql"
      )) {
        await database.execute(sql.raw(statement));
      }

      expect(await tableExists(database, "claim_reviews")).toBe(false);
      const ledger = (await database.execute(
        sql.raw(
          "select count(*)::int as total from schema_migrations where filename = '0006_claim_reviews.sql'"
        )
      )) as unknown as Array<{ total: number }>;
      expect(ledger[0]?.total).toBe(0);

      // Re-applying must be a real run, not a skip.
      const reapplied = await runMigrations(database, resolve("migrations"));
      expect(reapplied.applied).toContain("0006_claim_reviews.sql");
      expect(await tableExists(database, "claim_reviews")).toBe(true);

      // The claim itself is untouched by the round trip.
      const claims = (await database.execute(
        sql.raw(`select count(*)::int as total from claims where id = '${claimId}'`)
      )) as unknown as Array<{ total: number }>;
      expect(claims[0]?.total).toBe(1);
    } finally {
      await database.end();
      await admin.execute(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
  });
});
