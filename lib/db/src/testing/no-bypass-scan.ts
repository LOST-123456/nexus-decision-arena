/**
 * 「无绕过」静态扫描（自动发现版）
 *
 * 目标：**自动发现**仓库内全部集成测试文件与 vitest 配置，逐条检查它们是否
 * 只能通过受保护的测试数据库工厂拿到数据库句柄 —— 而不是依赖一份固定文件清单
 * 或固定文件数量。新增的 `*.integration.test.ts` / `vitest*.config.ts` 会自动纳入扫描。
 *
 * 本模块是纯读文件 + 规则判定，不连接任何数据库、不修改任何文件。
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ScanFinding = {
  /** 仓库相对路径（POSIX 分隔符） */
  file: string;
  /** 规则 id */
  rule: string;
  /** 命中说明 */
  detail: string;
};

/** 受保护工厂：集成测试必须至少使用其中一个来获取数据库句柄。 */
export const GUARDED_FACTORY_CALLS: readonly string[] = [
  "createTestDatabase(",
  "createTestAdminDatabase(",
  "createTestDatabaseForUrl("
];

/** 需要扫描的工作区源码根（仓库相对）。 */
export const WORKSPACE_SOURCE_ROOTS: readonly string[] = [
  "lib/db/src",
  "services/core/src"
];

/** 需要扫描 vitest 配置的包目录（仓库相对）。 */
export const VITEST_CONFIG_PACKAGES: readonly string[] = ["lib/db", "services/core"];

/** 集成测试里不应出现的破坏性 SQL 字面量特征。 */
const DESTRUCTIVE_SQL = /\b(TRUNCATE|DROP\s+(TABLE|DATABASE|SCHEMA)|DELETE\s+FROM|ALTER\s+TABLE)\b/i;

/** 硬编码的 postgres 连接串（绕过守卫的典型写法）。 */
const HARDCODED_PG_URL = /postgres(ql)?:\/\//i;

/** 直接调用 createDatabase(...)（前面不是 `.`，避免误伤 `database.createDatabase`）。 */
const DIRECT_CREATE_DATABASE = /(^|[^.\w])createDatabase\s*\(/;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report"
]);

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/** 仓库根目录（本文件位于 <root>/lib/db/src/testing/）。 */
export function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

async function walkFiles(absoluteDir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(full, root, out);
    } else {
      out.push(toPosix(relative(root, full)));
    }
  }
}

/** 自动发现全部集成测试文件（仓库相对路径，已排序）。 */
export async function discoverIntegrationTestFiles(
  root: string = repositoryRoot()
): Promise<string[]> {
  const files: string[] = [];
  for (const sourceRoot of WORKSPACE_SOURCE_ROOTS) {
    await walkFiles(resolve(root, sourceRoot), root, files);
  }
  return files.filter((file) => file.endsWith(".integration.test.ts")).sort();
}

/** 自动发现全部 vitest 配置（仓库相对路径，已排序）。 */
export async function discoverVitestConfigs(
  root: string = repositoryRoot()
): Promise<string[]> {
  const files: string[] = [];
  for (const pkg of VITEST_CONFIG_PACKAGES) {
    await walkFiles(resolve(root, pkg), root, files);
  }
  return files.filter((file) => /(^|\/)vitest[^/]*\.config\.ts$/.test(file)).sort();
}

/**
 * 纯函数：检查一个集成测试源码是否遵守隔离约定。
 * 抽出来是为了让单元测试能直接喂「故意违规」的样例，验证规则真的会命中。
 */
export function inspectIntegrationTestSource(
  file: string,
  source: string
): ScanFinding[] {
  const findings: ScanFinding[] = [];

  if (source.includes("process.env.DATABASE_URL")) {
    findings.push({
      file,
      rule: "integration-test-reads-database-url",
      detail:
        "integration test references process.env.DATABASE_URL; it must use the guarded test-database factory instead"
    });
  }

  const direct = source.match(DIRECT_CREATE_DATABASE);
  if (direct) {
    findings.push({
      file,
      rule: "integration-test-direct-create-database",
      detail: `integration test calls createDatabase(...) directly ("${direct[0].trim()}"); use createTestDatabase()/createTestAdminDatabase()`
    });
  }

  if (HARDCODED_PG_URL.test(source)) {
    findings.push({
      file,
      rule: "integration-test-hardcoded-database-url",
      detail:
        "integration test contains a hardcoded postgres:// URL; the target must come from the guarded TEST_DATABASE_URL resolver"
    });
  }

  const usesGuardedFactory = GUARDED_FACTORY_CALLS.some((call) =>
    source.includes(call)
  );
  if (!usesGuardedFactory) {
    findings.push({
      file,
      rule: "integration-test-missing-guarded-factory",
      detail: `integration test does not use any guarded factory (${GUARDED_FACTORY_CALLS.join(
        ", "
      )})`
    });
  }

  if (DESTRUCTIVE_SQL.test(source) && !usesGuardedFactory) {
    findings.push({
      file,
      rule: "destructive-sql-without-guard",
      detail:
        "integration test contains destructive SQL but does not obtain its handle from a guarded factory"
    });
  }

  return findings;
}

/** 纯函数：检查 vitest 配置是否重新引入了「自动回退到应用库」的行为。 */
export function inspectVitestConfigSource(
  file: string,
  source: string
): ScanFinding[] {
  const findings: ScanFinding[] = [];

  // 在 test.env 里注入 DATABASE_URL（历史事故的成因）
  if (/env\s*:\s*\{[^}]*DATABASE_URL/.test(source)) {
    findings.push({
      file,
      rule: "vitest-config-injects-database-url",
      detail:
        "vitest config injects DATABASE_URL into test.env; integration tests must read TEST_DATABASE_URL via the guarded factory"
    });
  }

  // 任何形式的 `?? "postgres://..."` 回退
  if (/\?\?\s*["'`]postgres/i.test(source)) {
    findings.push({
      file,
      rule: "vitest-config-url-fallback",
      detail:
        'vitest config contains a `?? "postgres://..."` fallback; remove the default so missing config fails closed'
    });
  }

  if (HARDCODED_PG_URL.test(source)) {
    findings.push({
      file,
      rule: "vitest-config-hardcoded-database-url",
      detail:
        "vitest config contains a hardcoded postgres:// URL; configure test targets via TEST_DATABASE_URL only"
    });
  }

  return findings;
}

/** 纯函数：检查 package.json 的测试脚本是否会触发应用库迁移（防误用）。 */
export function inspectPackageJsonSource(
  file: string,
  source: string
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  let parsed: { scripts?: Record<string, string> };
  try {
    parsed = JSON.parse(source) as { scripts?: Record<string, string> };
  } catch {
    return findings;
  }

  for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
    if (!name.startsWith("test")) continue;
    // 测试脚本不得触发应用库迁移 CLI（`db:migrate`），只允许专用的测试库迁移。
    if (/\bdb:migrate\b/.test(command)) {
      findings.push({
        file,
        rule: "test-script-runs-app-migration",
        detail: `script "${name}" runs the application migration CLI (db:migrate); tests must never migrate the application database`
      });
    }
  }

  return findings;
}

export type ScanReport = {
  integrationTestFiles: string[];
  vitestConfigFiles: string[];
  packageJsonFiles: string[];
  findings: ScanFinding[];
};

/**
 * 全量扫描：自动发现 → 逐条检查。返回发现清单与发现到的文件清单
 * （文件清单用于「扫到了什么」的可审计输出，不作为保护强度的唯一依据）。
 */
export async function scanRepository(
  root: string = repositoryRoot()
): Promise<ScanReport> {
  const findings: ScanFinding[] = [];

  const integrationTestFiles = await discoverIntegrationTestFiles(root);
  for (const file of integrationTestFiles) {
    const source = await readFile(resolve(root, file), "utf8");
    findings.push(...inspectIntegrationTestSource(file, source));
  }

  const vitestConfigFiles = await discoverVitestConfigs(root);
  for (const file of vitestConfigFiles) {
    const source = await readFile(resolve(root, file), "utf8");
    findings.push(...inspectVitestConfigSource(file, source));
  }

  const packageJsonFiles: string[] = [];
  for (const rel of ["package.json", "lib/db/package.json", "services/core/package.json", "apps/web/package.json", "packages/shared/package.json", "lib/llm/package.json"]) {
    try {
      const source = await readFile(resolve(root, rel), "utf8");
      packageJsonFiles.push(rel);
      findings.push(...inspectPackageJsonSource(rel, source));
    } catch {
      // 缺少某个 package.json 不构成绕过
    }
  }

  return { integrationTestFiles, vitestConfigFiles, packageJsonFiles, findings };
}
