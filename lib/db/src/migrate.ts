import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { createDatabase, type Database } from "./client";

const migrationsTableSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamp with time zone NOT NULL DEFAULT now()
)`;

type MigrationRecord = {
  filename: string;
  checksum: string;
};

export type MigrationRunResult = {
  applied: string[];
  skipped: string[];
};

export async function runMigrations(
  database: Database,
  migrationDirectory = resolve("migrations")
): Promise<MigrationRunResult> {
  const files = (await readdir(migrationDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations = await Promise.all(
    files.map(async (filename) => {
      const contents = await readFile(
        resolve(migrationDirectory, filename),
        "utf8"
      );
      return {
        filename,
        contents,
        checksum: createHash("sha256").update(contents).digest("hex")
      };
    })
  );

  const result: MigrationRunResult = { applied: [], skipped: [] };

  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('nexus_schema_migrations'))`
    );
    await transaction.execute(migrationsTableSql);

    const appliedRows = (await transaction.execute(
      "SELECT filename, checksum FROM schema_migrations"
    )) as unknown as MigrationRecord[];
    const applied = new Map(
      appliedRows.map((record) => [record.filename, record.checksum])
    );

    for (const migration of migrations) {
      const recordedChecksum = applied.get(migration.filename);
      if (
        recordedChecksum !== undefined &&
        recordedChecksum !== migration.checksum
      ) {
        throw new Error(
          `Migration checksum drift for ${migration.filename}: expected ${recordedChecksum}, got ${migration.checksum}`
        );
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.filename)) {
        result.skipped.push(migration.filename);
        console.log(`skipped ${migration.filename}`);
        continue;
      }

      const statements = migration.contents
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter(Boolean);

      for (const statement of statements) {
        await transaction.execute(sql.raw(statement));
      }

      await transaction.execute(
        sql`INSERT INTO schema_migrations (filename, checksum) VALUES (${migration.filename}, ${migration.checksum})`
      );

      result.applied.push(migration.filename);
      console.log(`applied ${migration.filename}`);
    }
  });

  return result;
}

async function main() {
  const database = createDatabase(
    process.env.DATABASE_URL ??
      "postgres://nexus:nexus@localhost:5432/nexus"
  );

  try {
    await runMigrations(database);
  } finally {
    await database.end();
  }
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === entrypoint) {
  await main();
}