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
  SourceIndependenceRepository,
  SourceLibraryRepository,
  NotificationRepository,
  TeamCollaborationRepository,
  listSessionPage,
  loadOversightCounts
} from "@nexus/db";
import { OpenAiCompatibleProvider, type LlmProvider } from "@nexus/llm";
import { materialsFromEvents } from "@nexus/shared";
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
import {
  createSearchProviderFromEnv,
  describeSearch
} from "./arena/web-search";
import { EventBus } from "./execution/event-bus";
import { ModelConfigStore } from "./llm/model-config-store";
import { ModelNotConfiguredError, ModelRuntime } from "./llm/model-runtime";
import { CrossReviewService } from "./research/cross-review-service";
import { AgentRunService } from "./research/agent-run-service";
import { RunCancellationRegistry } from "./research/run-cancellation";
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
import { ResearchQualityService } from "./research/research-quality-service";
import { ResearchTranslationService } from "./research/research-translation-service";
import { LanguageDetectionService } from "./research/language-detection-service";
import {
  OpenAiCompatibleTranslationProvider,
  UnavailableTranslationProvider
} from "./research/translation-provider";
import {
  TerminologyRepository,
  TranslationRepository
} from "@nexus/db";
import { ResearchWorkspaceService } from "./research/workspace-service";
import { DiskFileStorage } from "./research/file-storage";
import { resolveAuthConfig } from "./auth-config";
import {
  resolveOriginPolicy,
  type OriginPolicy
} from "./api/security/origin-policy";
import { createConsoleAuditSink } from "./auth-audit";
import { LoginThrottle } from "./login-rate-limit";
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
// Controlled research search: the deterministic, network-free provider is the
// default; approving a task creates sources, never evidence. The quality
// assessment reads its task rows to report what was actually executed.
const researchSearch = new ResearchSearchRepository(database);
const translations = new TranslationRepository(database);
const terminology = new TerminologyRepository(database);
// Multilingual translation is auxiliary and never fabricates a reading: with no
// operator-configured translation endpoint it stays honestly unavailable. A real
// provider is activated purely by environment (TRANSLATION_BASE_URL +
// TRANSLATION_API_KEY); credentials are never hard-coded or sent to the client.
const translationProvider =
  process.env.TRANSLATION_BASE_URL && process.env.TRANSLATION_API_KEY
    ? new OpenAiCompatibleTranslationProvider({
        baseUrl: process.env.TRANSLATION_BASE_URL,
        apiKey: process.env.TRANSLATION_API_KEY,
        model: process.env.TRANSLATION_MODEL ?? "gpt-4o-mini"
      })
    : new UnavailableTranslationProvider();

/**
 * Authentication is resolved before anything listens, so a deployment that is
 * not allowed to run never serves a single request. See `auth-config.ts` for
 * why a public deployment may not fall back to the built-in secret or to the
 * built-in owner password.
 */
const authConfig = resolveAuthConfig(process.env, {
  usersPath: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../..",
    ".data",
    "users.json"
  )
});
if (!authConfig.secretFromEnvironment) {
  process.stderr.write(
    "[auth] AUTH_SECRET is not set, so session tokens are signed with the built-in demo secret. That is acceptable for a local development run only; set AUTH_SECRET before this service is reachable by anyone else.\n"
  );
}
if (authConfig.mode === "public" && !authConfig.secureCookies) {
  process.stderr.write(
    "[auth] This deployment is public but its session cookie is not marked Secure. Point WEB_ORIGIN at an https:// origin, or set AUTH_COOKIE_SECURE=true.\n"
  );
}

/**
 * Which browser origins may change state here, resolved before anything
 * listens — a public deployment with no configured origin refuses to start
 * rather than serving writes it cannot attribute to a page it trusts. See
 * `api/security/origin-policy.ts`.
 */
const originPolicy: OriginPolicy = resolveOriginPolicy(process.env);
if (originPolicy.source === "local-default") {
  process.stderr.write(
    `[security] WEB_ORIGIN is not set, so this local run trusts ${[...originPolicy.allowed].join(", ")}. Set WEB_ORIGIN (or WEB_ORIGINS) to name the web origin explicitly.\n`
  );
}
const insecureOrigins = [...originPolicy.allowed].filter((origin) =>
  origin.startsWith("http://")
);
if (authConfig.mode === "public" && insecureOrigins.length > 0) {
  process.stderr.write(
    `[security] This deployment is public but trusts plain-http origin(s): ${insecureOrigins.join(", ")}. Any page served over http on that host can change state here. Serve the UI over https.\n`
  );
}

const auth = new AuthService({
  usersPath: authConfig.usersPath,
  secret: authConfig.secret,
  defaultOwnerPassword: authConfig.defaultOwnerPassword,
  defaultViewerPassword: authConfig.defaultViewerPassword,
  allowDemoBootstrap: authConfig.allowDemoBootstrap
});
await auth.initialize();
/**
 * Which model answers. Resolved **per call**, not per process, so a key typed
 * into the settings page is used by the very next run without a restart.
 *
 * Precedence:
 *   saved settings  >  LLM_* environment  >  fixtures (only when LLM_MODE=mock)  >  refuse
 *
 * Fixtures stay reachable because the fixed demo page and the whole test suite
 * depend on them — but they are now an explicit opt-in through `LLM_MODE=mock`,
 * never the silent default. A deployment nobody configured refuses to analyse
 * instead of inventing a conclusion about a project the model never read.
 */
const modelConfigStore = new ModelConfigStore(
  ModelConfigStore.defaultPath(dirname(dirname(authConfig.usersPath)))
);
modelConfigStore.load();
/**
 * 外部检索只在显式配置时存在。
 *
 * 没有 `SEARCH_API_URL` 就是 `null`，提示词里不会再出现"来源"这类词——
 * 一个没接检索的部署，不能在界面上暗示自己查过。`/api/runtime` 会把这件事
 * 如实回给前端，谁都能一眼看出这一轮到底有没有联网。
 */
const searchProvider = createSearchProviderFromEnv(process.env);
const searchStatus = describeSearch(searchProvider);

const modelRuntime = new ModelRuntime(modelConfigStore, async (sessionId) => {
  /**
   * 材料只从事件流里读。
   *
   * 不另设一张 materials 表，是因为"哪一轮之前交的"必须和质询、裁决落在同一条
   * 序列上；单独一张表迟早会需要一份影子时间线来还原先后顺序。
   * `events` 在下面才初始化，但这个箭头函数只会在真正质询时执行。
   */
  const recorded = await events.listAfter(sessionId, 0);
  return materialsFromEvents(recorded);
}, searchProvider);

const legacyMode = process.env.LLM_MODE ?? "mock";
/**
 * 固定样例只有在"显式允许"时才装载。
 *
 * 之前只要 `LLM_MODE=mock` 就会装上，于是"没配模型"和"配了模型"跑的是同一套
 * 代码，只是产出真假不同——用户看到的是五个角色跑完、给出一段和项目无关的结论。
 * 现在多一道 `NEXUS_ALLOW_FIXTURE_RUNS=1`：演示与 E2E 显式打开它，一个真实的
 * 部署不会因为默认值而"看起来能用"。
 */
const fixtureRunsAllowed = process.env.NEXUS_ALLOW_FIXTURE_RUNS === "1";
const fixtures =
  legacyMode === "mock" && fixtureRunsAllowed
    ? await loadDeterministicFixtures()
    : null;
const deterministicRunner = fixtures
  ? new DeterministicAgentRunner(fixtures)
  : null;
const deterministicExtraction =
  legacyMode === "mock" && fixtureRunsAllowed
    ? new DeterministicExtractionProvider()
    : null;

const envProvider =
  legacyMode === "openai-compatible" &&
  process.env.LLM_BASE_URL &&
  process.env.LLM_API_KEY &&
  process.env.LLM_MODEL
    ? new OpenAiCompatibleProvider({
        baseUrl: process.env.LLM_BASE_URL,
        apiKey: process.env.LLM_API_KEY,
        model: process.env.LLM_MODEL
      })
    : null;
if (
  legacyMode === "openai-compatible" &&
  !envProvider &&
  !modelRuntime.isConfigured()
) {
  throw new Error(
    "openai-compatible mode requires LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL, or a saved model configuration from the settings page."
  );
}
const envRunner = envProvider
  ? new ProviderAgentRunner(envProvider, undefined, searchProvider)
  : null;

/**
 * The concrete provider runner to use right now, or null when this process has
 * no model at all. Both `ProviderAgentRunner` and `DeterministicAgentRunner`
 * expose the challenger-side methods the arena needs, so callers below treat
 * them uniformly.
 */
function activeRunner(): ProviderAgentRunner | null {
  if (modelRuntime.isConfigured()) {
    return modelRuntime.providerRunner();
  }
  return envRunner;
}

const agentRunner: AgentRunner = {
  async run(role, projectInput) {
    const runner = activeRunner();
    if (runner) {
      return runner.run(role, projectInput);
    }
    if (deterministicRunner) {
      return deterministicRunner.run(role, projectInput);
    }
    throw new ModelNotConfiguredError();
  }
};

const createCrossExamination = (): CrossExaminationService => {
  const runner = activeRunner();
  if (runner) {
    return new CrossExaminationService(runner.createChallengeDependencies());
  }
  if (deterministicRunner) {
    return new CrossExaminationService(
      deterministicRunner.createChallengeDependencies()
    );
  }
  throw new ModelNotConfiguredError();
};

const createChallengePlans: NonNullable<
  RunSessionRuntime["createChallengePlans"]
> = (roles, claims, runIdByRoleId) => {
  const runner = activeRunner();
  if (runner) {
    return runner.createChallengePlans(roles, claims, runIdByRoleId);
  }
  if (deterministicRunner) {
    return deterministicRunner.createChallengePlans(
      roles,
      claims,
      runIdByRoleId
    );
  }
  throw new ModelNotConfiguredError();
};

/**
 * Claim extraction and citation review capture their provider when they are
 * constructed, so they get a stable wrapper whose `generate()` picks the
 * current model on every call. The getters keep the recorded provider name and
 * model honest across a key or model change.
 */
const switchableExtraction: LlmProvider = {
  generate(request, signal) {
    if (modelRuntime.isConfigured()) {
      return modelRuntime.extractionProvider().generate(request, signal);
    }
    if (deterministicExtraction) {
      return deterministicExtraction.generate(request, signal);
    }
    throw new ModelNotConfiguredError();
  }
};

const extractionProvider: { name: string; model: string; provider: LlmProvider } =
  {
    get name() {
      if (modelRuntime.isConfigured()) {
        return modelRuntime.extractionDescriptor().name;
      }
      return deterministicExtraction?.name ?? "尚未配置模型";
    },
    get model() {
      if (modelRuntime.isConfigured()) {
        return modelRuntime.extractionDescriptor().model;
      }
      return deterministicExtraction?.model ?? "unconfigured";
    },
    provider: switchableExtraction
  };

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
 *
 * `cancellations` is process-scoped and shared with the operations center: the
 * executor registers a signal per run, the cancel endpoint aborts it. Sharing
 * one instance is the whole point — two instances would each abort nothing.
 * Correctness never depends on it, though; the arena's row-locked writes reject
 * results from a cancelled run whichever process produced them.
 */
const cancellations = new RunCancellationRegistry();
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
  cancellations,
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
    // The session's title is its project's name (decision_sessions has no
    // title column). Read it in the same call path so the workspace header can
    // name the research; a missing project degrades to null, never to a guess.
    const project = await sessions.getProjectBySessionId(sessionId);
    return {
      id: session.id,
      phase: session.phase,
      operationalStatus: session.operationalStatus,
      researchQuestion: session.researchQuestion ?? null,
      currentConclusion: session.currentConclusion ?? null,
      title: project?.name ?? null
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
 * Which sources are the same information, so reprints are not counted as
 * corroboration. One instance for the process: the quality assessment reads
 * the same analysis the workspace panel does.
 */
const sourceIndependence = new SourceIndependenceService({
  sources: researchEvidence,
  assertions: new SourceIndependenceRepository(database)
});
// The human relation rows behind that analysis, shared so a saved report
// version freezes the same pair statements the live reading merges with.
const sourceRelations = new SourceIndependenceRepository(database);

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

/**
 * Cross-research library: share grants and copy lineage. The service is
 * constructed per request in the route; the repository is shared.
 */
const sourceLibrary = new SourceLibraryRepository(database);

/**
 * Team collaboration & human review. The repository is shared with the route,
 * which builds the service per request so the authorization context is derived
 * from the live caller rather than cached.
 */
const teamCollaboration = new TeamCollaborationRepository(database);

/**
 * The notification centre stores read markers and nothing else; every card it
 * serves is derived from a membership or a run at request time.
 */
const notifications = new NotificationRepository(database);

const app = createApp(
  {
    sessions,
    auth,
    sessionHistory: sessions,
    /**
     * The paged session list. Curried over `database` here rather than handed
     * the repository, because the query lives in `session-page.ts` for now
     * (see `AppDependencies.sessionPages`).
     */
    sessionPages: {
      listPage: (page, sessionIds) => listSessionPage(database, page, sessionIds)
    },
    /**
     * The governance page's counts. Curried over `database` for the same reason
     * as `sessionPages`: it is a set of queries, not a thing with state.
     */
    oversight: {
      loadCounts: (sessionIds) => loadOversightCounts(database, sessionIds)
    },
    inspector: new InspectorRepository(database),
    evidence: researchEvidence,
    sourceLibrary,
    teamCollaboration,
    notifications,
    reviews: researchReviews,
    crossReview,
    /** Agent Operations Center: surfaces `agent_runs`, reusing the same table. */
    agentRuns: new AgentRunService({
      reviews: researchReviews,
      arena,
      events,
      cancellations,
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
    sourceIndependence,
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
      // Read inside the save transaction so a frozen version records the
      // quality reading of its own moment, never a later one.
      sourceRelations,
      searchTasks: researchSearch,
      // Read inside the save transaction so a frozen version's multilingual
      // summary describes the reading aids that existed at that moment.
      translations,
      snapshots: new ReportSnapshotRepository(database)
    }),
    // No controlled web-search integration exists in this build, so the plan
    // is wired with searchAvailable=false and offers start_search nowhere.
    researchPlan,
    // Research quality assessment: a read-only projection over the same
    // workspace the research UI reads, plus the analyses that are configured.
    // It writes nothing; each absent analysis makes its dimension answer
    // "insufficient data" instead of guessing.
    translations,
    terminology,
    translationProvider,
    researchQuality: new ResearchQualityService({
      workspace: async (sessionId) => workspaceService.getWorkspace(sessionId),
      independence: sourceIndependence,
      monitoring: {
        tasks: revalidationTasks,
        snapshots: researchEvidence
      },
      planItems: researchPlan,
      searchTasks: researchSearch
    }),
    // Controlled research search: the deterministic, network-free provider is
    // the default; approving a task creates sources, never evidence.
    researchSearch,
    arena,
    reports,
    events,
    runSession,
    /**
     * The settings page and the arena share one store, so a saved key is
     * picked up by the next run without either side reloading from disk.
     */
    modelConfig: {
      store: modelConfigStore,
      runtime: modelRuntime,
      auth,
      canRunAnalysis: () =>
        modelRuntime.isConfigured() ||
        envProvider !== null ||
        fixtureRunsAllowed
    },
  },  new PostgresIdempotencyStore(database),
  {
    eventBus,
    /**
     * Read per request: the answer changes the moment a key is saved, and the
     * UI uses it to decide whether the primary buttons are allowed to do
     * anything at all.
     */
    runtimeInfo: () => {
      const settings = modelRuntime.settings();
      const canRun =
        modelRuntime.isConfigured() || envProvider !== null || fixtureRunsAllowed;
      if (settings) {
        return {
          mode: "openai-compatible" as const,
          provider: settings.providerLabel,
          model: settings.model,
          configured: true,
          canRunAnalysis: canRun,
          search: searchStatus
        };
      }
      if (envProvider) {
        return {
          mode: "openai-compatible" as const,
          provider: "OpenAI-compatible",
          model: process.env.LLM_MODEL ?? "unknown",
          configured: true,
          canRunAnalysis: canRun,
          search: searchStatus
        };
      }
      return {
        mode: "mock" as const,
        /*
         * 没配置、也没显式允许固定样例时，别说自己是 "MockLlmProvider"——
         * 那会让「运行在 mock 模式」听起来像一件已生效的事，而实际上一个
         * provider 都没有装载。这里如实说：没有模型。
         */
        provider: deterministicExtraction?.name ?? "尚未配置模型",
        model: deterministicExtraction?.model ?? "none",
        configured: false,
        canRunAnalysis: canRun,
        search: searchStatus
      };
    },
    ...(process.env.WEB_ORIGIN
      ? { webOrigin: process.env.WEB_ORIGIN }
      : {}),
    originPolicy,
    authRuntime: {
      secureCookies: authConfig.secureCookies,
      loginThrottle: new LoginThrottle(),
      auditSink: createConsoleAuditSink()
    },
    /**
     * The response body no longer says why a 5xx happened, so this is the
     * only record of it. stderr is where the launcher's log already collects
     * the process output (`scripts/serve-public.mjs`).
     */
    reportError: (error, context) => {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      process.stderr.write(
        `[error] ${context.method} ${context.url} -> ${context.statusCode}: ${message}\n` +
          (stack ? `${stack}\n` : "")
      );
    }
  }
);

await app.listen({ host: "0.0.0.0", port });
