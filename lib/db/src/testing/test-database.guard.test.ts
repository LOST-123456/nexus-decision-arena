/**
 * 守卫与「无绕过」扫描的回归测试。
 *
 * 全部是纯逻辑测试：**不连接任何数据库**。即使环境里存在 TEST_DATABASE_URL，
 * 这里也不会执行任何 SQL —— 校验失败一律发生在建连之前。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  DESTRUCTIVE_SQL_PATTERN,
  DATABASE_DDL_NAME_PATTERN,
  DEFAULT_TEST_DB_PREFIXES,
  PROTECTED_DATABASE_NAMES,
  TestDatabaseGuardError,
  assertDisposableDatabaseName,
  assertSafeTestDatabaseUrl,
  createTestDatabase,
  describeTarget,
  resolveTestDatabaseUrl
} from "./test-database";
import {
  inspectIntegrationTestSource,
  inspectPackageJsonSource,
  inspectVitestConfigSource,
  scanRepository
} from "./no-bypass-scan";

const MANAGED_ENV_KEYS = [
  "TEST_DATABASE_URL",
  "DATABASE_URL",
  "TEST_DB_PREFIX",
  "TEST_DB_ALLOWLIST",
  "TEST_DB_ALLOW_HOSTS",
  "TEST_DB_ALLOW_REMOTE",
  "TEST_DB_ALLOWED_HOSTS"
] as const;

const savedEnv = new Map<string, string | undefined>();
for (const key of MANAGED_ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearManagedEnv() {
  for (const key of MANAGED_ENV_KEYS) delete process.env[key];
}

describe("assertSafeTestDatabaseUrl — fail-closed", () => {
  it("rejects when TEST_DATABASE_URL is unset", () => {
    clearManagedEnv();
    expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow(
      TestDatabaseGuardError
    );
    expect(() => assertSafeTestDatabaseUrl(undefined)).toThrow(
      /TEST_DATABASE_URL is not set/
    );
  });

  it("rejects blank values", () => {
    expect(() => assertSafeTestDatabaseUrl("   ")).toThrow(/is not set/);
    expect(() => assertSafeTestDatabaseUrl("")).toThrow(/is not set/);
  });

  it("rejects a malformed URL", () => {
    expect(() => assertSafeTestDatabaseUrl("not-a-url")).toThrow(
      /not a valid URL/
    );
  });

  it("rejects a non-postgres protocol", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("mysql://nexus:nexus@localhost:3306/nexus_test")
    ).toThrow(/unsupported protocol/);
  });

  it("rejects a URL without a database name", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgres://nexus:nexus@localhost:5432/")
    ).toThrow(/explicit database name/);
  });

  it.each([...PROTECTED_DATABASE_NAMES])(
    "rejects protected database %s",
    (name) => {
      clearManagedEnv();
      expect(() =>
        assertSafeTestDatabaseUrl(`postgres://nexus:nexus@localhost:5432/${name}`)
      ).toThrow(/protected database/);
    }
  );

  it("rejects a database that is not on the allowed prefix list", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgres://nexus:nexus@localhost:5432/random_db")
    ).toThrow(/not an allowed test database/);
  });

  it("rejects a remote host", () => {
    expect(() =>
      assertSafeTestDatabaseUrl("postgres://nexus:nexus@db.example.com:5432/nexus_test")
    ).toThrow(/not in the allowed local hosts/);
  });

  it("rejects a test target identical to DATABASE_URL", () => {
    process.env.DATABASE_URL = "postgres://nexus:nexus@localhost:5432/nexus_test";
    expect(() =>
      assertSafeTestDatabaseUrl("postgres://nexus:nexus@localhost:5432/nexus_test")
    ).toThrow(/application database/);
  });

  it("allows a same-host but different-database target", () => {
    process.env.DATABASE_URL = "postgres://nexus:nexus@localhost:5432/nexus";
    const url = assertSafeTestDatabaseUrl(
      "postgres://nexus:nexus@localhost:5432/nexus_test"
    );
    expect(url.pathname).toBe("/nexus_test");
  });

  it.each([...DEFAULT_TEST_DB_PREFIXES])(
    "accepts the default test prefix %s",
    (prefix) => {
      clearManagedEnv();
      const url = assertSafeTestDatabaseUrl(
        `postgres://nexus:nexus@localhost:5432/${prefix}sample`
      );
      expect(url.pathname).toBe(`/${prefix}sample`);
    }
  );

  it("accepts an explicit allowlist entry", () => {
    clearManagedEnv();
    process.env.TEST_DB_ALLOWLIST = "my_special_db";
    const url = assertSafeTestDatabaseUrl(
      "postgres://nexus:nexus@localhost:5432/my_special_db"
    );
    expect(url.pathname).toBe("/my_special_db");
  });

  it("accepts a custom prefix via TEST_DB_PREFIX", () => {
    clearManagedEnv();
    process.env.TEST_DB_PREFIX = "ci_tmp_";
    const url = assertSafeTestDatabaseUrl(
      "postgres://nexus:nexus@localhost:5432/ci_tmp_alpha"
    );
    expect(url.pathname).toBe("/ci_tmp_alpha");
  });

  it("describeTarget never leaks the password", () => {
    expect(
      describeTarget("postgres://nexus:sup3r-secret@localhost:5432/nexus_test")
    ).toBe("nexus@localhost:5432/nexus_test");
  });
});

describe("createTestDatabase — failing before connecting", () => {
  it("throws when config is missing (no connection is attempted)", () => {
    clearManagedEnv();
    expect(() => createTestDatabase()).toThrow(TestDatabaseGuardError);
  });

  it("throws for a protected target (no connection is attempted)", () => {
    clearManagedEnv();
    expect(() =>
      createTestDatabase({ url: "postgres://nexus:nexus@localhost:59999/nexus" })
    ).toThrow(/protected database/);
  });

  it("resolveTestDatabaseUrl has no default value", () => {
    clearManagedEnv();
    expect(() => resolveTestDatabaseUrl()).toThrow(/is not set/);
  });
});

describe("destructive SQL patterns", () => {
  it.each([
    "TRUNCATE idempotency_keys",
    "truncate table claims cascade",
    "DROP TABLE claims",
    "DROP DATABASE nexus",
    "DELETE FROM projects",
    "ALTER TABLE claims ADD COLUMN x int",
    "CREATE DATABASE nexus_test_x",
    "REINDEX TABLE claims",
    "VACUUM FULL claims"
  ])("flags %s", (statement) => {
    expect(DESTRUCTIVE_SQL_PATTERN.test(statement)).toBe(true);
  });

  it.each(["SELECT 1", "INSERT INTO claims VALUES ()", "UPDATE claims SET x = 1"])(
    "does not flag %s",
    (statement) => {
      expect(DESTRUCTIVE_SQL_PATTERN.test(statement)).toBe(false);
    }
  );

  it("extracts the database name from CREATE/DROP DATABASE", () => {
    expect(
      DATABASE_DDL_NAME_PATTERN.exec('CREATE DATABASE "nexus_migration_abc"')?.[1]
    ).toBe("nexus_migration_abc");
    expect(DATABASE_DDL_NAME_PATTERN.exec("DROP DATABASE IF EXISTS nexus")?.[1]).toBe(
      "nexus"
    );
  });
});

describe("assertDisposableDatabaseName", () => {
  it("refuses protected names", () => {
    expect(() => assertDisposableDatabaseName("nexus")).toThrow(
      /protected database/
    );
  });

  it("refuses names outside the allowed prefixes", () => {
    expect(() => assertDisposableDatabaseName("random_db")).toThrow(
      /allowed test prefix/
    );
  });

  it("allows disposable migration databases", () => {
    expect(() =>
      assertDisposableDatabaseName("nexus_migration_deadbeef")
    ).not.toThrow();
  });
});

describe("no-bypass scanner — rule detection (synthetic violations)", () => {
  it("flags a test that reads the application DATABASE_URL", () => {
    const findings = inspectIntegrationTestSource(
      "x.integration.test.ts",
      'const url = process.env.DATABASE_URL;\nconst db = createTestDatabase();'
    );
    expect(findings.map((f) => f.rule)).toContain(
      "integration-test-reads-database-url"
    );
  });

  it("flags a test that calls createDatabase directly", () => {
    const findings = inspectIntegrationTestSource(
      "x.integration.test.ts",
      'import { createDatabase } from "../client";\nconst db = createDatabase(url);'
    );
    expect(findings.map((f) => f.rule)).toContain(
      "integration-test-direct-create-database"
    );
  });

  it("flags a test with a hardcoded postgres URL", () => {
    const findings = inspectIntegrationTestSource(
      "x.integration.test.ts",
      'const db = createTestDatabase({ url: "postgres://nexus:nexus@localhost:5432/nexus" });'
    );
    expect(findings.map((f) => f.rule)).toContain(
      "integration-test-hardcoded-database-url"
    );
  });

  it("flags a test that never uses a guarded factory", () => {
    const findings = inspectIntegrationTestSource(
      "x.integration.test.ts",
      "const db = makeMyOwnHandle();\nawait db.execute('TRUNCATE claims');"
    );
    expect(findings.map((f) => f.rule)).toContain(
      "integration-test-missing-guarded-factory"
    );
    expect(findings.map((f) => f.rule)).toContain(
      "destructive-sql-without-guard"
    );
  });

  it("accepts a compliant integration test", () => {
    const findings = inspectIntegrationTestSource(
      "x.integration.test.ts",
      'import { createTestDatabase } from "../testing/test-database";\nconst db = createTestDatabase();\nawait db.execute("TRUNCATE claims");'
    );
    expect(findings).toEqual([]);
  });

  it("flags the historical vitest DATABASE_URL fallback", () => {
    const findings = inspectVitestConfigSource(
      "lib/db/vitest.config.ts",
      'export default { test: { env: { DATABASE_URL: process.env.DATABASE_URL ?? "postgres://nexus:nexus@localhost:5432/nexus" } } };'
    );
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain("vitest-config-injects-database-url");
    expect(rules).toContain("vitest-config-url-fallback");
  });

  it("accepts a hardened vitest config", () => {
    const findings = inspectVitestConfigSource(
      "lib/db/vitest.config.ts",
      "export default { test: { fileParallelism: false, hookTimeout: 30000 } };"
    );
    expect(findings).toEqual([]);
  });

  it("flags a test script that runs the application migration CLI", () => {
    const findings = inspectPackageJsonSource(
      "package.json",
      JSON.stringify({ scripts: { "test:integration": "pnpm db:migrate && vitest run" } })
    );
    expect(findings.map((f) => f.rule)).toContain("test-script-runs-app-migration");
  });

  it("accepts a test script that only runs the dedicated test-db migration", () => {
    const findings = inspectPackageJsonSource(
      "lib/db/package.json",
      JSON.stringify({ scripts: { "db:test:migrate": "tsx src/testing/migrate-test-db.ts" } })
    );
    expect(findings).toEqual([]);
  });
});

describe("no-bypass scanner — repository-wide (auto-discovery)", () => {
  it("discovers every integration test and finds zero bypasses", async () => {
    const report = await scanRepository();

    // 门槛是「至少发现一个」，而不是固定数量：新增集成测试会自动纳入扫描。
    expect(report.integrationTestFiles.length).toBeGreaterThan(0);
    expect(report.vitestConfigFiles.length).toBeGreaterThan(0);
    expect(report.findings).toEqual([]);

    // 可审计输出：把本次真正扫描到的文件打印出来，便于复核覆盖范围。
    // eslint-disable-next-line no-console
    console.log(
      `[no-bypass-scan] integration tests (${report.integrationTestFiles.length}):\n  ` +
        report.integrationTestFiles.join("\n  ")
    );
    // eslint-disable-next-line no-console
    console.log(
      `[no-bypass-scan] vitest configs (${report.vitestConfigFiles.length}):\n  ` +
        report.vitestConfigFiles.join("\n  ")
    );
  });
});
