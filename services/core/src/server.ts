import {
  ArenaRepository,
  createDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  FinalReportRepository,
  InspectorRepository,
  ReviewRepository
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
import { CrossReviewService } from "./research/cross-review-service";
import { createPageFetcher } from "./research/page-fetch";
import { createNodePageTransport, dnsAddressResolver } from "./research/node-page-transport";
import { SourceImportService } from "./research/source-import-service";
import { AuthService } from "./auth";

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
const researchEvidence = new EvidenceRepository(database);
const researchReviews = new ReviewRepository(database);

const auth = new AuthService({
  usersPath:
    process.env.AUTH_USERS_PATH ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../..", ".data", "users.json"),
  secret: process.env.AUTH_SECRET ?? "nexus-local-demo-secret",
  defaultOwnerPassword: process.env.AUTH_DEFAULT_OWNER_PASSWORD ?? "nexus-owner",
  defaultViewerPassword: process.env.AUTH_DEFAULT_VIEWER_PASSWORD ?? "nexus-viewer"
});
await auth.initialize();
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

/**
 * Claim-level cross-examination. It reuses the arena's challenger selection
 * and CrossExaminationService, but gives every challenger its own agent run so
 * the research workspace can show real task status and real failure reasons.
 */
const crossReview = new CrossReviewService({
  readArtifacts: (sessionId) => arena.getSessionArtifacts(sessionId),
  readRoles: async (sessionId) => {
    const context = await arena.getRunContext(sessionId);
    if (!context) {
      return [];
    }
    const configured =
      DEFAULT_AGENT_ROLES.length > 0 ? DEFAULT_AGENT_ROLES : context.roles;
    return arena.ensureAgentRoles(configured);
  },
  runs: researchReviews,
  arena,
  getClaimValidationContext: (claimId) =>
    arena.getClaimValidationContext(claimId),
  crossExamination: createCrossExamination,
  appendEvent: (input) => events.append(input),
  eventBus,
  maxChallengers: Number(process.env.CROSS_EXAMINATION_MAX_CHALLENGERS ?? 2)
});

/**
 * Page retrieval for the research intake.
 *
 * Built once for the process so the concurrency limit is actually shared. The
 * transport pins every connection to the address the guard validated, which is
 * what stops a page from redirecting the server at its own network.
 */
const pageFetcher = createPageFetcher({
  resolve: dnsAddressResolver,
  transport: createNodePageTransport()
});

const app = createApp(
  {
    sessions,
    auth,
    sessionHistory: sessions,
    inspector: new InspectorRepository(database),
    evidence: researchEvidence,
    reviews: researchReviews,
    crossReview,
    sourceIntake: new SourceImportService({
      evidence: researchEvidence,
      // One fetcher for the process: the concurrency limit is only meaningful
      // if it is shared, and the address guard is what decides what may be
      // contacted.
      fetch: (url) => pageFetcher.fetch(url)
    }),
    arena,
    reports,
    events,
    runSession,
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
