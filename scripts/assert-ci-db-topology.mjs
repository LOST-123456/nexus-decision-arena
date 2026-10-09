#!/usr/bin/env node
/**
 * CI 数据库拓扑断言（fail-closed）。
 *
 * 目的：确保「应用迁移目标」与「集成测试目标」在 CI 中被**显式配置且互不相同**，
 * 且测试目标永远是专用/一次性数据库 —— 绝不允许 `nexus` 同时充当应用默认库和测试目标。
 *
 * 该脚本是纯配置校验：不连接任何数据库、不修改任何数据。
 * 任一条件不满足即退出码 1。
 */
import { appendFileSync } from "node:fs";
const PROTECTED = new Set(["nexus", "postgres", "template0", "template1"]);
const failures = [];

function readEnvUrl(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    failures.push(`${name} is not set`);
    return null;
  }
  try {
    const url = new URL(value);
    return {
      raw: value,
      protocol: url.protocol,
      host: url.hostname,
      port: url.port || "5432",
      database: decodeURIComponent(url.pathname.replace(/^\//, "")),
      user: decodeURIComponent(url.username)
    };
  } catch {
    failures.push(`${name} is not a valid URL`);
    return null;
  }
}

const app = readEnvUrl("DATABASE_URL");
const test = readEnvUrl("TEST_DATABASE_URL");

if (app && !/^postgres(ql)?:$/.test(app.protocol)) {
  failures.push(`DATABASE_URL has unsupported protocol ${app.protocol}`);
}
if (test && !/^postgres(ql)?:$/.test(test.protocol)) {
  failures.push(`TEST_DATABASE_URL has unsupported protocol ${test.protocol}`);
}

if (test) {
  if (PROTECTED.has(test.database)) {
    failures.push(
      `TEST_DATABASE_URL targets protected database "${test.database}" — the test target must be a dedicated database`
    );
  }
}

if (app && test) {
  const sameTarget =
    app.host === test.host &&
    app.port === test.port &&
    app.database === test.database;
  if (sameTarget) {
    failures.push(
      `DATABASE_URL and TEST_DATABASE_URL resolve to the SAME database (${test.host}:${test.port}/${test.database}); ` +
        "the integration test target must be separate from the application database"
    );
  }
}

const describe = (t) => (t ? `${t.user}@${t.host}:${t.port}/${t.database}` : "<unset>");

// 记录到 job summary（若在 GHA 上运行）
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  try {
    const lines = [
      "### CI database topology",
      "",
      `- application migration target (\`DATABASE_URL\`): \`${describe(app)}\``,
      `- integration test target (\`TEST_DATABASE_URL\`): \`${describe(test)}\``,
      ""
    ];
    appendFileSync(summaryPath, lines.join("\n") + "\n");
  } catch {
    // summary 写入失败不影响结论
  }
}

if (failures.length > 0) {
  console.error("[ci-db-topology] FAIL");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log("[ci-db-topology] OK");
console.log(`  application migration target : ${describe(app)}`);
console.log(`  integration test target      : ${describe(test)}`);
