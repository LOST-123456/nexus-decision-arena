/**
 * 创建专用测试库（幂等）。
 *
 * 只读 `TEST_DATABASE_URL`：未配置或目标非法时在建立连接前抛错。
 * 建库用的管理连接由 `createTestAdminDatabase()` 派生，库名逐条经过一次性库名校验。
 *
 * 用法：TEST_DATABASE_URL=postgres://nexus:nexus@localhost:5432/nexus_test pnpm db:test:create
 */
import {
  assertDisposableDatabaseName,
  createTestAdminDatabase,
  describeTarget,
  resolveTestDatabaseUrl
} from "./test-database";

export async function ensureTestDatabase(): Promise<{
  database: string;
  target: string;
  created: boolean;
}> {
  const url = resolveTestDatabaseUrl();
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  assertDisposableDatabaseName(databaseName);

  const admin = createTestAdminDatabase();
  try {
    const existing = (await admin.execute(
      `SELECT 1 AS present FROM pg_database WHERE datname = '${databaseName}'`
    )) as unknown as unknown[];

    if (existing.length > 0) {
      return { database: databaseName, target: describeTarget(url.toString()), created: false };
    }

    // 经过守卫：CREATE DATABASE 的库名必须是一次性测试库名
    await admin.execute(`CREATE DATABASE "${databaseName}"`);
    return { database: databaseName, target: describeTarget(url.toString()), created: true };
  } finally {
    await admin.end();
  }
}

async function main() {
  const result = await ensureTestDatabase();
  console.log(
    `[db:test:create] ${result.created ? "created" : "exists"} ${result.target}`
  );
}

await main();
