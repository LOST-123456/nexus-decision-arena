import { afterAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { newId } from "@nexus/shared";
import { createDatabase } from "./client";
import { runMigrations } from "./migrate";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const postgresUrl = new URL(databaseUrl);
postgresUrl.pathname = "/postgres";
const admin = createDatabase(postgresUrl.toString());

afterAll(async () => {
  await admin.end();
});

describe("migration runner", () => {
  it("applies each migration once, records it, and rejects checksum drift", async () => {
    const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
    const migrationUrl = new URL(databaseUrl);
    migrationUrl.pathname = `/${databaseName}`;
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    const migrationDatabase = createDatabase(migrationUrl.toString());

    try {
      const migrationDirectory = resolve("migrations");
      const firstRun = await runMigrations(
        migrationDatabase,
        migrationDirectory
      );
      const secondRun = await runMigrations(
        migrationDatabase,
        migrationDirectory
      );

      expect(firstRun).toEqual({
        applied: [
          "0001_initial.sql",
          "0002_claim_inspector_view.sql",
          "0003_idempotency_leases.sql",
          "0004_live_orchestration_and_reports.sql"
        ],
        skipped: []
      });
      expect(secondRun).toEqual({
        applied: [],
        skipped: [
          "0001_initial.sql",
          "0002_claim_inspector_view.sql",
          "0003_idempotency_leases.sql",
          "0004_live_orchestration_and_reports.sql"
        ]
      });

      const records = (await migrationDatabase.execute(
        "SELECT filename, checksum, applied_at FROM schema_migrations ORDER BY filename"
      )) as unknown as Array<{
        filename: string;
        checksum: string;
        applied_at: string;
      }>;

      expect(records).toHaveLength(4);
      expect(records.map((record) => record.filename)).toEqual([
        "0001_initial.sql",
        "0002_claim_inspector_view.sql",
        "0003_idempotency_leases.sql",
        "0004_live_orchestration_and_reports.sql"
      ]);
      expect(records.every((record) => record.checksum.length === 64)).toBe(
        true
      );
      expect(records.every((record) => Boolean(record.applied_at))).toBe(true);

      await migrationDatabase.execute(
        "UPDATE schema_migrations SET checksum = 'drifted' WHERE filename = '0001_initial.sql'"
      );
      await expect(
        runMigrations(migrationDatabase, migrationDirectory)
      ).rejects.toThrow("checksum drift");
    } finally {
      await migrationDatabase.end();
      await admin.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    }
  });
});
