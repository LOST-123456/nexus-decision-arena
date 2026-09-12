import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("serializes concurrent migration runners with an advisory lock", async () => {
    const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
    const migrationUrl = new URL(databaseUrl);
    migrationUrl.pathname = `/${databaseName}`;
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    const migrationDatabase = createDatabase(migrationUrl.toString());
    const directory = await mkdtemp(join(tmpdir(), "nexus-migration-"));

    try {
      await writeFile(
        join(directory, "0001_concurrent.sql"),
        "CREATE TABLE concurrent_migration_probe (id integer PRIMARY KEY);",
        "utf8"
      );
      const runs = await Promise.all([
        runMigrations(migrationDatabase, directory),
        runMigrations(migrationDatabase, directory)
      ]);

      const applied = runs.reduce(
        (count, run) => count + run.applied.length,
        0
      );
      const skipped = runs.reduce(
        (count, run) => count + run.skipped.length,
        0
      );
      expect(applied).toBe(1);
      expect(skipped).toBe(1);
    } finally {
      await migrationDatabase.end();
      await rm(directory, { recursive: true, force: true });
      await admin.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    }
  });

  it("rolls back the full migration transaction on failure", async () => {
    const databaseName = `nexus_migration_${newId().replaceAll("-", "")}`;
    const migrationUrl = new URL(databaseUrl);
    migrationUrl.pathname = `/${databaseName}`;
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    const migrationDatabase = createDatabase(migrationUrl.toString());
    const directory = await mkdtemp(join(tmpdir(), "nexus-migration-"));

    try {
      await writeFile(
        join(directory, "0001_failure.sql"),
        [
          "CREATE TABLE migration_rollback_probe (id integer PRIMARY KEY);",
          "SELECT definitely_not_a_function();"
        ].join("\n--> statement-breakpoint\n"),
        "utf8"
      );

      await expect(runMigrations(migrationDatabase, directory)).rejects.toThrow();
      const tables = (await migrationDatabase.execute(
        "SELECT to_regclass('public.migration_rollback_probe') AS table_name"
      )) as unknown as Array<{ table_name: string | null }>;
      expect(tables[0]?.table_name).toBeNull();
      const ledger = (await migrationDatabase.execute(
        "SELECT to_regclass('public.schema_migrations') AS table_name"
      )) as unknown as Array<{ table_name: string | null }>;
      expect(ledger[0]?.table_name).toBeNull();
    } finally {
      await migrationDatabase.end();
      await rm(directory, { recursive: true, force: true });
      await admin.execute(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    }
  });
});
