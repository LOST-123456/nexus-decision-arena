/**
 * 测试数据库 fail-closed 守卫
 *
 * 目的：任何会清空 / 删除 / 重建 / 修改数据库的测试，都只能在**显式的专用测试库**上运行。
 *
 * 规则：
 *  1. 只读取 `TEST_DATABASE_URL`，**没有默认值**。未配置 → 在建立连接、执行任何 SQL 之前抛错。
 *  2. 目标库名必须命中允许前缀（默认 `nexus_test*` / `nexus_it*` / `nexus_migration_*`）或显式
 *     `TEST_DB_ALLOWLIST`；`nexus`、`postgres`、`template0/1` 等受保护库永远拒绝。
 *  3. 默认只允许本机 host（localhost / 127.0.0.1 / ::1）；其他 host 一律拒绝。
 *  4. 若 `DATABASE_URL`（应用库）与测试目标指向**同一个库**，直接拒绝。
 *  5. 破坏性 SQL（TRUNCATE / DROP / DELETE FROM / ALTER TABLE / CREATE DATABASE ...）只有在
 *     句柄由本模块校验过时才允许通过（纵深防御，防止有人绕过工厂直接执行）。
 *
 * 本模块不读取也不修改应用配置；`server.ts` / `migrate.ts` / `drizzle.config.ts` 的目标不受影响。
 */
import { type SQL } from "drizzle-orm";
import { createDatabase, type Database } from "../client";

/** 受保护的库名：永远不会被当作测试库。 */
export const PROTECTED_DATABASE_NAMES: ReadonlySet<string> = new Set([
  "nexus",
  "postgres",
  "template0",
  "template1"
]);

/** 默认允许的测试库名前缀。 */
export const DEFAULT_TEST_DB_PREFIXES: readonly string[] = [
  "nexus_test",
  "nexus_it",
  "nexus_migration_"
];

const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]"
];

/** 破坏性语句特征（仅用于字符串形式的 SQL 的纵深防御）。 */
export const DESTRUCTIVE_SQL_PATTERN =
  /\b(TRUNCATE|DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|OWNED)|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+DATABASE|REINDEX|VACUUM\s+FULL)\b/i;

/** 从 CREATE/DROP DATABASE 语句中提取库名。 */
export const DATABASE_DDL_NAME_PATTERN =
  /\b(?:CREATE|DROP)\s+DATABASE\s+(?:IF\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/i;

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseGuardError";
  }
}

export type ParsedTarget = {
  host: string;
  port: string;
  database: string;
  username: string;
};

function parseTarget(url: URL): ParsedTarget {
  return {
    host: url.hostname,
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    username: decodeURIComponent(url.username)
  };
}

function allowedPrefixes(): string[] {
  const fromEnv = (process.env.TEST_DB_PREFIX ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : [...DEFAULT_TEST_DB_PREFIXES];
}

function allowlist(): string[] {
  return (process.env.TEST_DB_ALLOWLIST ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/**
 * 纯校验函数：判定一个 URL 是否可作为测试库目标。不产生任何连接。
 * 命中任意规则即抛出，错误信息里包含被拒绝的目标，便于排查。
 */
export function assertSafeTestDatabaseUrl(
  rawUrl: string | undefined | null
): URL {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new TestDatabaseGuardError(
      "[test-db-guard] TEST_DATABASE_URL is not set. Refusing to run destructive " +
        "tests without an explicit dedicated test database. " +
        "Set TEST_DATABASE_URL, e.g. postgres://nexus:nexus@localhost:5432/nexus_test"
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TestDatabaseGuardError(
      "[test-db-guard] TEST_DATABASE_URL is not a valid URL."
    );
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new TestDatabaseGuardError(
      `[test-db-guard] unsupported protocol "${url.protocol}" in TEST_DATABASE_URL (expected postgres://).`
    );
  }

  const target = parseTarget(url);

  if (target.database === "") {
    throw new TestDatabaseGuardError(
      "[test-db-guard] TEST_DATABASE_URL must include an explicit database name."
    );
  }

  if (PROTECTED_DATABASE_NAMES.has(target.database)) {
    throw new TestDatabaseGuardError(
      `[test-db-guard] refusing to target protected database "${target.database}". ` +
        "Destructive tests must run on a dedicated test database."
    );
  }

  // 应用库同一目标 -> 拒绝
  const appUrl = process.env.DATABASE_URL;
  if (typeof appUrl === "string" && appUrl.trim() !== "") {
    try {
      const appTarget = parseTarget(new URL(appUrl));
      if (
        appTarget.host === target.host &&
        appTarget.port === target.port &&
        appTarget.database === target.database
      ) {
        throw new TestDatabaseGuardError(
          `[test-db-guard] TEST_DATABASE_URL points at the application database ` +
            `"${target.database}" (same as DATABASE_URL). Refusing before connecting.`
        );
      }
    } catch (error) {
      if (error instanceof TestDatabaseGuardError) throw error;
      // DATABASE_URL 非法时忽略，不影响测试库校验
    }
  }

  const prefixes = allowedPrefixes();
  const explicitAllow = allowlist();
  const nameAllowed =
    explicitAllow.includes(target.database) ||
    prefixes.some((prefix) => target.database.startsWith(prefix));

  if (!nameAllowed) {
    throw new TestDatabaseGuardError(
      `[test-db-guard] database "${target.database}" is not an allowed test database ` +
        `(allowed prefixes: ${prefixes.join(", ")}). ` +
        "Use TEST_DB_PREFIX / TEST_DB_ALLOWLIST to widen, never to point at the app database."
    );
  }

  if (process.env.TEST_DB_ALLOW_REMOTE !== "1") {
    const allowedHosts = (
      process.env.TEST_DB_ALLOWED_HOSTS ?? DEFAULT_ALLOWED_HOSTS.join(",")
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (!allowedHosts.includes(target.host)) {
      throw new TestDatabaseGuardError(
        `[test-db-guard] host "${target.host}" is not in the allowed local hosts ` +
          `(${allowedHosts.join(", ")}). Refusing to run destructive tests against a remote host.`
      );
    }
  }

  return url;
}

/** 读取并校验 TEST_DATABASE_URL（无默认值）。 */
export function resolveTestDatabaseUrl(): URL {
  return assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
}

/**
 * 校验「一次性库名」（用于 CREATE / DROP DATABASE）是否在允许范围内。
 * 所有建库/删库入口都必须先调用它，确保不会误建/误删 `nexus` 等受保护库。
 */
export function assertDisposableDatabaseName(databaseName: string): void {
  if (PROTECTED_DATABASE_NAMES.has(databaseName)) {
    throw new TestDatabaseGuardError(
      `[test-db-guard] refusing to create/drop protected database "${databaseName}".`
    );
  }
  const prefixes = allowedPrefixes();
  const allow = allowlist();
  const ok =
    allow.includes(databaseName) ||
    prefixes.some((prefix) => databaseName.startsWith(prefix));
  if (!ok) {
    throw new TestDatabaseGuardError(
      `[test-db-guard] refusing to create/drop database "${databaseName}": name must start with ` +
        `an allowed test prefix (${prefixes.join(", ")}).`
    );
  }
}

function toSqlText(query: string | SQL): string | null {
  if (typeof query === "string") return query;
  // drizzle SQL 对象的字符串化不可靠，仅尽力而为；对象形式仍受「句柄已校验」这一前提保护。
  return null;
}

function guardDestructiveSql(
  database: Database,
  validatedUrl: URL,
  onBlocked?: (query: string) => void
): Database {
  const originalExecute = database.execute.bind(database);

  return Object.assign(database, {
    execute: (query: string | SQL) => {
      const text = toSqlText(query);
      if (text && DESTRUCTIVE_SQL_PATTERN.test(text)) {
        // 1) 目标库必须仍是合法测试库
        try {
          assertSafeTestDatabaseUrl(validatedUrl.toString());
        } catch (error) {
          onBlocked?.(text);
          throw error;
        }
        // 2) 若涉及 CREATE/DROP DATABASE，库名必须是一次性测试库名（防止误删 nexus）
        const ddlMatch = text.match(DATABASE_DDL_NAME_PATTERN);
        if (ddlMatch && ddlMatch[1]) {
          try {
            assertDisposableDatabaseName(ddlMatch[1]);
          } catch (error) {
            onBlocked?.(text);
            throw error;
          }
        }
      }
      return originalExecute(query);
    }
  }) as Database;
}

/**
 * 创建**已校验**的测试数据库句柄。校验失败时在建连之前抛错。
 */
export function createTestDatabase(
  options: { url?: string; onBlocked?: (query: string) => void } = {}
): Database {
  const url = assertSafeTestDatabaseUrl(
    options.url ?? process.env.TEST_DATABASE_URL
  );
  const database = createDatabase(url.toString());
  return guardDestructiveSql(database, url, options.onBlocked);
}

/**
 * 创建用于「建/删临时库」的管理连接：同一主机/凭据，库名换成 `postgres`。
 * 只有在 TEST_DATABASE_URL 本身是合法测试库时才允许派生，避免误连真实集群的管理库做操作。
 */
export function createTestAdminDatabase(): Database {
  const url = resolveTestDatabaseUrl();
  const admin = new URL(url.toString());
  admin.pathname = "/postgres";
  // 仍然挂上守卫：CREATE/DROP DATABASE 的库名会被逐条校验
  return guardDestructiveSql(createDatabase(admin.toString()), url);
}

/**
 * 为一次性临时库（如 `nexus_migration_<uuid>`）创建句柄，同样走校验。
 */
export function createTestDatabaseForUrl(url: string): Database {
  return createTestDatabase({ url });
}

/** 供诊断/日志使用（不含密码）。 */
export function describeTarget(rawUrl: string): string {
  const target = parseTarget(new URL(rawUrl));
  return `${target.username}@${target.host}:${target.port}/${target.database}`;
}
