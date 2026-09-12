import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = "corepack";
const args = [
  "pnpm",
  "--filter",
  "@nexus/web",
  "exec",
  "playwright",
  "test",
  "--repeat-each=20",
  "--project=desktop-1440x900"
];
const outputPath = resolve(
  repositoryRoot,
  "docs",
  "experiments",
  "stability-output.txt"
);
const startedAt = new Date().toISOString();

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function main(): Promise<void> {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32"
  });
  const durationMs = Math.round(performance.now() - started);
  const completedAt = new Date().toISOString();
  const stdout = stripAnsi(result.stdout ?? "");
  const stderr = stripAnsi(
    `${result.error?.message ?? ""}${result.stderr ?? ""}`
  );
  const output = [
    "Nexus Decision Arena 20-run stability output",
    "command: corepack pnpm --filter @nexus/web exec playwright test --repeat-each=20 --project=desktop-1440x900",
    `started_at: ${startedAt}`,
    `completed_at: ${completedAt}`,
    `duration_ms: ${durationMs}`,
    `exit_code: ${result.status}`,
    `overall_result: ${result.status === 0 ? "PASS" : "FAIL"}`,
    "",
    "--- stdout ---",
    stdout.trimEnd(),
    "--- stderr ---",
    stderr.trimEnd(),
    ""
  ].join("\n");

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${output}\n`, "utf8");

  if (result.status !== 0) {
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    throw new Error(`Stability run failed with exit ${result.status}`);
  }

  console.log(`stability complete: 20 desktop runs passed in ${durationMs}ms`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});