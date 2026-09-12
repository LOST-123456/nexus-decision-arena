import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MockLlmProvider, type LlmRequest } from "@nexus/llm";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(resolve(repositoryRoot, "fixtures", name), "utf8")
  ) as T;
}

async function main(): Promise<void> {
  const [project, analysis, challenges, expectedReport] = await Promise.all([
    readFixture<Record<string, unknown>>("lab-safety-project.json"),
    readFixture<unknown[]>("mock-analysis.json"),
    readFixture<unknown[]>("mock-challenges.json"),
    readFixture<Record<string, unknown>>("expected-final-report.json")
  ]);

  const provider = new MockLlmProvider({
    "challenge:create": () => JSON.stringify(challenges[0]),
    "challenge:respond": () =>
      JSON.stringify({
        disposition: "insufficient_evidence",
        statement: "Current evidence does not support the original target."
      }),
    "challenge:evaluate": () => JSON.stringify({ status: "unresolved" })
  });
  const request: LlmRequest = {
    schemaName: "challenge:create",
    system: "Use only the fixed decision-arena fixtures.",
    user: JSON.stringify(project),
    correlationId: "demo-fixture-correlation"
  };
  const generatedChallenge = JSON.parse(
    await provider.generate(request, new AbortController().signal)
  ) as unknown;

  console.log(
    JSON.stringify(
      {
        mode: "fixture",
        networkAccess: false,
        provider: provider.constructor.name,
        project,
        roleCount: analysis.length,
        challengeCount: challenges.length,
        generatedChallenge,
        expectedReport
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});