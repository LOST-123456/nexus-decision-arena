/**
 * 真实 Provider 验证门禁（fail-closed preflight，纯校验、不发起任何真实调用）
 *
 * 目的：把「真实模型验证」的前置条件变成**可执行、可复现**的判定，而不是只在报告里口头声明。
 *
 * 安全约定：
 * - 凭据**只**从环境变量读取；脚本从不打印任何密钥/口令值，只打印「是否已设置」。
 * - `LLM_BASE_URL` 只输出 origin（去掉 path/query/用户信息），避免把带凭据的 URL 写进日志。
 * - 数据库目标复用 `@nexus/db` 的 fail-closed 守卫做**隔离证明**：必须能证明目标是一次性专用
 *   测试库，否则在任何真实调用/写库之前直接阻断。
 * - 调用预算（次数 / 时长）必须显式给出，缺省即阻断。
 *
 * 退出码：`0` = READY（可安全执行真实 Provider 验证）；`1` = NOT RUN（存在阻断项）。
 * 本脚本自身**不会**运行 smoke；READY 之后由 `pnpm smoke:provider` 执行真实调用。
 */
import {
  assertSafeTestDatabaseUrl,
  describeTarget
} from "../lib/db/src/testing/test-database";

type Check = {
  id: string;
  ok: boolean;
  detail: string;
};

const checks: Check[] = [];

function record(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail });
}

function originOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return "<invalid URL>";
  }
}

function optionalUuid(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  return value === "" ? "<unset>" : value;
}

const mode = process.env.LLM_MODE?.trim() ?? "";
const baseUrl = process.env.LLM_BASE_URL?.trim() ?? "";
const apiKey = process.env.LLM_API_KEY?.trim() ?? "";
const model = process.env.LLM_MODEL?.trim() ?? "";

record(
  "LLM_MODE",
  mode === "openai-compatible",
  mode === ""
    ? "not set — mock runs do NOT count as real-provider verification"
    : mode === "mock"
      ? '"mock" — a mock run must never be reported as real-model verification'
      : `set to "${mode}" (expected "openai-compatible")`
);

record(
  "LLM_BASE_URL",
  baseUrl !== "" && originOf(baseUrl) !== "<invalid URL>",
  baseUrl === "" ? "not set" : `origin=${originOf(baseUrl)}`
);

// 只报告「是否存在」，绝不回显密钥内容或长度。
record("LLM_API_KEY", apiKey !== "", apiKey === "" ? "not set" : "present (value withheld)");

record("LLM_MODEL", model !== "", model === "" ? "not set" : `model=${model}`);

const maxCalls = Number(process.env.PROVIDER_MAX_CALLS ?? "");
record(
  "PROVIDER_MAX_CALLS",
  Number.isInteger(maxCalls) && maxCalls > 0,
  Number.isInteger(maxCalls) && maxCalls > 0 ? `${maxCalls} calls` : "must be a positive integer"
);

const maxDurationMs = Number(process.env.PROVIDER_MAX_DURATION_MS ?? "");
record(
  "PROVIDER_MAX_DURATION_MS",
  Number.isInteger(maxDurationMs) && maxDurationMs > 0,
  Number.isInteger(maxDurationMs) && maxDurationMs > 0
    ? `${maxDurationMs}ms`
    : "must be a positive integer"
);

// 隔离证明：复用测试库守卫，无法证明目标是专用隔离库就不允许任何真实写操作。
const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? "";
let databaseOk = false;
let databaseDetail = "TEST_DATABASE_URL is not set — cannot prove database isolation";
if (testDatabaseUrl !== "") {
  try {
    assertSafeTestDatabaseUrl(testDatabaseUrl);
    databaseOk = true;
    databaseDetail = `isolation proven: ${describeTarget(testDatabaseUrl)}`;
  } catch (error) {
    databaseDetail = error instanceof Error ? error.message : String(error);
  }
}
record("TEST_DATABASE_URL", databaseOk, databaseDetail);

const blockers = checks.filter((check) => !check.ok);
const ready = blockers.length === 0;

const report = {
  gate: "provider-verification",
  status: ready ? "READY" : "NOT RUN",
  checked_at: new Date().toISOString(),
  // 便于在真实模型报告中标注溯源信息（不涉及任何密钥）。
  provenance: {
    provider: ready ? "openai-compatible" : "<unset>",
    model: model === "" ? "<unset>" : model,
    session_fixture_id: optionalUuid("PROVIDER_SESSION_FIXTURE_ID"),
    prompt_version: optionalUuid("PROVIDER_PROMPT_VERSION")
  },
  checks,
  blockers: blockers.map((check) => `${check.id}: ${check.detail}`),
  safe_execution_path: [
    "1) 凭据只经环境变量注入（例如本机 shell 的 export / CI secret），不写入仓库、报告或日志。",
    "2) 设置 TEST_DATABASE_URL 指向一次性专用测试库，并通过本门禁证明隔离。",
    "3) 设定 PROVIDER_MAX_CALLS / PROVIDER_MAX_DURATION_MS 预算。",
    "4) 本门禁返回 READY 后，依次执行 pnpm smoke:provider（最小 smoke）与必要的端到端检查。",
    "5) 结束后清理专用测试会话与专用测试库；失败时同样清理。"
  ]
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!ready) {
  process.stderr.write(
    `\n[provider-gate] NOT RUN — ${blockers.length} blocker(s). No real provider call was made.\n`
  );
  process.exitCode = 1;
}
