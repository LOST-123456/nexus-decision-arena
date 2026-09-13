import {
  ArenaRepository,
  createDatabase,
  DecisionSessionRepository,
  EventRepository,
  FinalReportRepository,
  InspectorRepository
} from "@nexus/db";
import { OpenAiCompatibleProvider } from "@nexus/llm";
import { createApp } from "./app";
import { PostgresIdempotencyStore } from "./api/plugins/idempotency";
import { CrossExaminationService } from "./arena/cross-examination";
import { DEFAULT_AGENT_ROLES } from "./arena/default-roles";
import {
  DeterministicAgentRunner,
  loadDeterministicFixtures
} from "./arena/deterministic-agent-runner";
import {
  RunSessionService,
  type RunSessionRuntime
} from "./arena/run-session";
import type { AgentRunner } from "./arena/agent-runner";
import { ProviderAgentRunner } from "./arena/provider-agent-runner";
import { EventBus } from "./execution/event-bus";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../..", ".env")
  );
} catch {
  // The process environment is still supported when .env is absent.
}

const port = Number(process.env.PORT ?? 4100);
const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://nexus:nexus@localhost:5432/nexus"
);
const eventBus = new EventBus();
const sessions = new DecisionSessionRepository(database);
const events = new EventRepository(database);
const arena = new ArenaRepository(database);
const reports = new FinalReportRepository(database);

const mode = process.env.LLM_MODE ?? "mock";
let agentRunner: AgentRunner;
let createCrossExamination: () => CrossExaminationService;
let createChallengePlans:
  | NonNullable<RunSessionRuntime["createChallengePlans"]>
  | undefined;

if (mode === "mock") {
  const fixtures = await loadDeterministicFixtures();
  const deterministicRunner = new DeterministicAgentRunner(fixtures);
  agentRunner = deterministicRunner;
  createCrossExamination = () =>
    new CrossExaminationService(
      deterministicRunner.createChallengeDependencies()
    );
  createChallengePlans = (roles, claims, runIdByRoleId) =>
    deterministicRunner.createChallengePlans(roles, claims, runIdByRoleId);
} else if (mode === "openai-compatible") {
  if (
    !process.env.LLM_BASE_URL ||
    !process.env.LLM_API_KEY ||
    !process.env.LLM_MODEL
  ) {
    throw new Error(
      "openai-compatible mode requires LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL"
    );
  }
  const provider = new OpenAiCompatibleProvider({
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL
  });
  const providerRunner = new ProviderAgentRunner(provider);
  agentRunner = providerRunner;
  createCrossExamination = () =>
    new CrossExaminationService(
      providerRunner.createChallengeDependencies()
    );
  createChallengePlans = (roles, claims, runIdByRoleId) =>
    providerRunner.createChallengePlans(roles, claims, runIdByRoleId);
} else {
  throw new Error(`Unsupported LLM_MODE: ${mode}`);
}

const runSession = new RunSessionService(agentRunner, {
  store: arena,
  roles: DEFAULT_AGENT_ROLES,
  crossExamination: createCrossExamination,
  createChallengePlans,
  appendEvent: (input) => events.append(input),
  eventBus,
  initialConclusion: "建议立项",
  postChallengeConclusion: "暂缓规模化扩张"
});

const app = createApp(
  {
    sessions,
    inspector: new InspectorRepository(database),
    reports,
    events,
    runSession
  },
  new PostgresIdempotencyStore(database),
  {
    eventBus,
    runtimeInfo:
      mode === "openai-compatible"
        ? {
            mode,
            provider: "OpenAI-compatible",
            model: process.env.LLM_MODEL ?? "unknown"
          }
        : {
            mode: "mock",
            provider: "MockLlmProvider",
            model: "deterministic-fixtures"
          },
    ...(process.env.WEB_ORIGIN
      ? { webOrigin: process.env.WEB_ORIGIN }
      : {})
  }
);

await app.listen({ host: "0.0.0.0", port });
