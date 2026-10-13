import {
  ArenaRepository,
  createDatabase,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  FinalReportRepository,
  InspectorRepository,
  ResearchPlanRepository,
  ResearchSearchRepository,
  ReportSnapshotRepository,
  RevalidationTaskRepository,
  ReviewRepository,
  ClaimExtractionRepository,
  CitationReviewRepository,
  SourceCheckRepository,
  SourceFileRepository,
  SourceIndependenceRepository
} from "@nexus/db";
import { OpenAiCompatibleProvider, type LlmProvider } from "@nexus/llm";
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
import { AgentRunService } from "./research/agent-run-service";
import { ClaimExtractionService } from "./research/claim-extraction-service";
import { CitationReviewService } from "./research/citation-review-service";
import { SourceIndependenceService } from "./research/source-independence-service";
import { DeterministicExtractionProvider } from "./research/deterministic-extraction-provider";
import { createPageFetcher } from "./research/page-fetch";
import { createNodePageTransport, dnsAddressResolver } from "./research/node-page-transport";
import { SourceImportService } from "./research/source-import-service";
import { FileIngestionService } from "./research/file-ingestion-service";
import { SourceMonitorService } from "./research/source-monitor-service";
import { ResearchReportSnapshotService } from "./research/report-snapshot-service";
import { ResearchWorkspaceService } from "./research/workspace-service";
import { DiskFileStorage } from "./research/file-storage";
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
// One task repository for the process: source monitoring creates re-checks,
// and a report version records the same risk state the monitor sees.
const revalidationTasks = new RevalidationTaskRepository(database);
// Shared with the plan routes and the snapshot service, so a saved version
// reads the plan items the plan page shows.
const researchPlan = new ResearchPlanRepository(database);

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
/** Which model does the claim-extraction pass, and under what name. */
let extractionProvider: { name: string; model: string; provider: LlmProvider };

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
  const deterministicExtraction = new DeterministicExtractionProvider();
  extractionProvider = {
    name: deterministicExtraction.name,
    model: deterministicExtraction.model,
    provider: deterministicExtraction
  };
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
  extractionProvider = {
    name: "OpenAI-compatible",
    model: process.env.LLM_MODEL ?? "unknown",
    provider
  };
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

/**
 * The research workspace projection.
 *
 * One instance for the process, so the evidence map, the research plan and
 * source monitoring all read the same claims, verdicts and gaps rather than
 * three slightly different answers to the same question.
 */
const workspaceService = new ResearchWorkspaceService({
  evidence: researchEvidence,
  arena,
  reviews: researchReviews,
  getSession: async (sessionId) => {
    const session = await sessions.getById(sessionId);
    if (!session) return null;
    return {
      id: session.id,
      phase: session.phase,
      operationalStatus: session.operationalStatus,
      researchQuestion: session.researchQuestion ?? null,
      currentConclusion: session.currentConclusion ?? null
    };
  }
});

/**
 * Where imported files are kept.
 *
 * Outside the database, outside the web root, and reached only through the
 * session-scoped file endpoints. The ceiling below is a deployment decision
 * rather than a default nobody chose, and it is enforced again by the ingestion
 * service so the two cannot drift apart unnoticed.
 */
const fileStorage = new DiskFileStorage(
  process.env.NEXUS_FILE_STORAGE_DIR ??
    resolve(dirname(fileURLToPath(import.meta.url)), "../../..", ".data", "files")
);
const configuredMaxMb = Number(process.env.NEXUS_MAX_UPLOAD_MB ?? 10);

/**
 * Local research files: one uploaded document becomes one Source plus one
 * capture, or a recorded explanation of why it could not be read.
 */
const fileIngestion = new FileIngestionService({
  files: new SourceFileRepository(database),
  evidence: researchEvidence,
  storage: fileStorage,
  maxBytes:
    Number.isFinite(configuredMaxMb) && configuredMaxMb > 0
      ? Math.floor(configuredMaxMb * 1024 * 1024)
      : undefined
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
    /** Agent Operations Center: surfaces `agent_runs`, reusing the same table. */
    agentRuns: new AgentRunService({
      reviews: researchReviews,
      arena,
      events,
      crossReview
    }),
    sourceIntake: new SourceImportService({
      evidence: researchEvidence,
      // One fetcher for the process: the concurrency limit is only meaningful
      // if it is shared, and the address guard is what decides what may be
      // contacted.
      fetch: (url) => pageFetcher.fetch(url)
    }),
    fileIngestion,
    claimExtraction: new ClaimExtractionService({
      provider: extractionProvider.provider,
      providerName: extractionProvider.name,
      model: extractionProvider.model,
      runs: new ClaimExtractionRepository(database),
      evidence: researchEvidence
    }),
    citationReview: new CitationReviewService({
      readClaims: async (sessionId) => {
        const artifacts = await arena.getSessionArtifacts(sessionId);
        return artifacts.claims;
      },
      evidence: researchEvidence,
      citations: new CitationReviewRepository(database),
      provider: extractionProvider.provider,
      providerName: extractionProvider.name,
      model: extractionProvider.model
    }),
    sourceIndependence: new SourceIndependenceService({
      sources: researchEvidence,
      assertions: new SourceIndependenceRepository(database)
    }),
    // Source monitoring: whether registered pages and documents have moved,
    // what that reaches, and the re-check a person owes when they have. The
    // same fetcher and the same SSRF guard as the intake, and the same
    // workspace projection the UI reads.
    sourceMonitor: new SourceMonitorService({
      evidence: researchEvidence,
      checks: new SourceCheckRepository(database),
      tasks: revalidationTasks,
      files: new SourceFileRepository(database),
      fetch: (url) => pageFetcher.fetch(url),
      workspace: async (sessionId) => {
        const workspace = await workspaceService.getWorkspace(sessionId);
        if (!workspace) return null;
        // The projection itself, unmodified: monitoring reads the same claims
        // and verdicts the workspace shows, so the two cannot disagree.
        return {
          claims: workspace.claims,
          verdicts: workspace.verdicts
        };
      },
      appendEvent: (input) => events.append(input)
    }),
    // Immutable report versions. The same read path the live report uses,
    // wrapped in one repeatable-read transaction per save so a version can
    // never straddle an update; the monitor's task repository is shared so
    // the risk state a version records is the state at that moment.
    reportSnapshots: new ResearchReportSnapshotService({
      database,
      sessions,
      arena,
      evidence: researchEvidence,
      reviews: researchReviews,
      events,
      researchPlan,
      monitorTasks: revalidationTasks,
      snapshots: new ReportSnapshotRepository(database)
    }),
    // No controlled web-search integration exists in this build, so the plan
    // is wired with searchAvailable=false and offers start_search nowhere.
    researchPlan,
    // Controlled research search: the deterministic, network-free provider is
    // the default; approving a task creates sources, never evidence.
    researchSearch: new ResearchSearchRepository(database),
    arena,
    reports,
    events,
    runSession,
  },  new PostgresIdempotencyStore(database),
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
