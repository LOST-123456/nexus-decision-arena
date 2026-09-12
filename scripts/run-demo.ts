import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newId } from "@nexus/shared";
import { CrossExaminationService } from "../services/core/src/arena/cross-examination";
import { DEFAULT_AGENT_ROLES } from "../services/core/src/arena/default-roles";
import {
  DeterministicAgentRunner,
  loadDeterministicFixtures
} from "../services/core/src/arena/deterministic-agent-runner";
import { MemoryRunSessionStore } from "../services/core/src/arena/memory-run-session-store";
import { RunSessionService } from "../services/core/src/arena/run-session";
import { EventBus } from "../services/core/src/execution/event-bus";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readFixture<T>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(resolve(repositoryRoot, "fixtures", name), "utf8")
  ) as T;
}

async function main(): Promise<void> {
  const [project, expectedReport, fixtures] = await Promise.all([
    readFixture<Record<string, unknown>>("lab-safety-project.json"),
    readFixture<Record<string, unknown>>("expected-final-report.json"),
    loadDeterministicFixtures(repositoryRoot)
  ]);
  const sessionId = newId();
  const store = new MemoryRunSessionStore(
    {
      id: sessionId,
      phase: "CREATED",
      operationalStatus: "ACTIVE",
      currentConclusion: null,
      supplementRound: 0
    },
    project,
    DEFAULT_AGENT_ROLES
  );
  const runner = new DeterministicAgentRunner(fixtures);
  const eventBus = new EventBus();
  const service = new RunSessionService(runner, {
    store,
    roles: DEFAULT_AGENT_ROLES,
    crossExamination: new CrossExaminationService(
      runner.createChallengeDependencies()
    ),
    createChallengePlans: (roles, claims, runIdByRoleId) =>
      runner.createChallengePlans(roles, claims, runIdByRoleId),
    appendEvent: (input) => store.appendEvent(input),
    eventBus,
    initialConclusion: String(expectedReport.initialConclusion),
    postChallengeConclusion: String(expectedReport.postChallengeConclusion)
  });

  await service.start(sessionId);

  const opposingClaimCount = store.claims.filter(
    (claim) => claim.stance === "oppose"
  ).length;
  if (
    opposingClaimCount < 3 ||
    store.challenges.length < 5 ||
    store.conflicts.length < 3 ||
    !store.events.some((event) => event.type === "HUMAN_REVIEW_REQUIRED")
  ) {
    throw new Error("Deterministic engine did not satisfy demo minimums");
  }

  console.log(
    JSON.stringify(
      {
        mode: "mock",
        networkAccess: false,
        provider: "MockLlmProvider",
        project,
        roleCount: DEFAULT_AGENT_ROLES.length,
        claimCount: store.claims.length,
        opposingClaimCount,
        challengeCount: store.challenges.length,
        conflictCount: store.conflicts.length,
        eventCount: store.events.length,
        finalPhase: await store.getRunContext(sessionId).then(
          (context) => context?.session.phase
        ),
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
