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
  "--repeat-each=20"
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
  const childEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  delete childEnv.FORCE_COLOR;
  delete childEnv.NO_COLOR;
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: childEnv,
    shell: true
  });
  const durationMs = Math.round(performance.now() - started);
  const completedAt = new Date().toISOString();
  const stdout = stripAnsi(result.stdout ?? "");
  const stderr = stripAnsi(
    `${result.error?.message ?? ""}${result.stderr ?? ""}`
  );
  const commandLine = [command, ...args].join(" ");
  const output = [
    "Nexus Decision Arena 20-run stability output",
    `command: ${commandLine}`,
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
  await writeFile(outputPath, output, "utf8");

  if (result.status !== 0) {
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    throw new Error(`Stability run failed with exit ${result.status}`);
  }

  console.log(
    `stability complete: 20 desktop and 20 mobile runs passed in ${durationMs}ms`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
