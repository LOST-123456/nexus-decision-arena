/**
 * 对**专用测试库**执行迁移（与应用库迁移 CLI `db:migrate` 完全分离）。
 *
 * 只读 `TEST_DATABASE_URL`：未配置或目标非法时在建立连接前抛错。
 * 该脚本永远不会读取 `DATABASE_URL`，因此不可能把迁移打到应用库上。
 *
 * 用法：TEST_DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus_test pnpm db:test:migrate
 */
import { resolve } from "node:path";
import { runMigrations } from "../migrate";
import {
  createTestDatabase,
  describeTarget,
  resolveTestDatabaseUrl
} from "./test-database";

export async function migrateTestDatabase(migrationDirectory = resolve("migrations")) {
  const url = resolveTestDatabaseUrl();
  const database = createTestDatabase();
  try {
    const result = await runMigrations(database, migrationDirectory);
    return { target: describeTarget(url.toString()), ...result };
  } finally {
    await database.end();
  }
}

async function main() {
  const result = await migrateTestDatabase();
  console.log(
    `[db:test:migrate] ${result.target} applied=${result.applied.length} skipped=${result.skipped.length}`
  );
}

await main();
