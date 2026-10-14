import type {
  ArenaRepository,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  FinalReportRepository,
  InspectorRepository,
  ResearchPlanRepository,
  ResearchSearchRepository,
  ReviewRepository,
  TerminologyRepository,
  TranslationRepository
} from "@nexus/db";
import Fastify, { type FastifyInstance } from "fastify";
import {
  InMemoryIdempotencyStore,
  type IdempotencyStore
} from "./api/plugins/idempotency";
import { registerAuthRoutes } from "./api/routes/auth";
import { registerEvidenceRoutes } from "./api/routes/evidence";
import { registerEvidenceMapRoutes } from "./api/routes/evidence-map";
import { registerEventRoutes } from "./api/routes/events";
import { registerFileRoutes } from "./api/routes/files";
import { registerHumanDecisionRoutes } from "./api/routes/human-decisions";
import { registerInspectorRoutes } from "./api/routes/inspector";
import { registerReportRoutes } from "./api/routes/reports";
import { registerReviewRoutes } from "./api/routes/review";
import { registerSessionRoutes } from "./api/routes/sessions";
import { registerClaimExtractionRoutes } from "./api/routes/claim-extraction";
import { registerCitationReviewRoutes } from "./api/routes/citation-review";
import { registerResearchPlanRoutes } from "./api/routes/research-plan";
import { registerResearchSearchRoutes } from "./api/routes/research-search";
import { registerReportSnapshotRoutes } from "./api/routes/report-snapshots";
import { registerResearchQualityRoutes } from "./api/routes/research-quality";
import { registerMultilingualRoutes } from "./api/routes/multilingual";
import { registerSourceIndependenceRoutes } from "./api/routes/source-independence";
import { registerSourceIntakeRoutes } from "./api/routes/source-intake";
import { registerSourceMonitoringRoutes } from "./api/routes/source-monitoring";
import { registerAgentRunRoutes } from "./api/routes/agent-runs";
import { EventBus } from "./execution/event-bus";
import type { CrossReviewService } from "./research/cross-review-service";
import type { AgentRunService } from "./research/agent-run-service";
import type { ClaimExtractionService } from "./research/claim-extraction-service";
import type { CitationReviewService } from "./research/citation-review-service";
import type { SourceImportService } from "./research/source-import-service";
import type { FileIngestionService } from "./research/file-ingestion-service";
import type { SourceIndependenceService } from "./research/source-independence-service";
import type { SourceMonitorService } from "./research/source-monitor-service";
import type { ResearchReportSnapshotService } from "./research/report-snapshot-service";
import type { ResearchQualityService } from "./research/research-quality-service";

export type ProjectInput = {
  name: string;
  summary: string;
  targetUsers: string;
  businessModel: string;
  expectedData: string;
};

export type SessionInput = {
  id: string;
  projectId: string;
  locale: string;
  phase: string;
  operationalStatus: string;
  currentConclusion: string | null;
  /** The question the research set out to answer. */
  researchQuestion?: string | null;
};

export type SessionRecord = NonNullable<
  Awaited<ReturnType<DecisionSessionRepository["createWithProject"]>>
>;

import type { AuthService } from "./auth";
export type AppDependencies = {
  auth?: AuthService;
  sessions: Pick<
    DecisionSessionRepository,
    | "createWithProject"
    | "getById"
    | "getView"
    | "recordHumanDecision"
    | "getProjectBySessionId"
  >;
  sessionHistory?: Pick<
    DecisionSessionRepository,
    "listSummaries" | "deleteById"
  >;
  inspector: Pick<InspectorRepository, "getInspector">;
  /** Research evidence and source management. */
  evidence?: EvidenceRepository;
  /** Cross-examination run records and human fact-check rulings. */
  reviews?: ReviewRepository;
  /** Runs cross-examination against a single claim, reusing the arena. */
  crossReview?: CrossReviewService;
  /** Surfaces agent runs as an operations center; reuses `agent_runs`. */
  agentRuns?: AgentRunService;
  /** Imports a page and keeps the failure record when it cannot be read. */
  sourceIntake?: SourceImportService;
  /**
   * Imports local research files (PDF/DOCX/TXT/Markdown/CSV).
   *
   * A successful read registers a Source and stores one capture of the text;
   * both go through the evidence repository, so nothing here can create a
   * second way of becoming citable. Unreadable files stay visible as
   * `needs_ocr` or `failed`.
   */
  fileIngestion?: FileIngestionService;
  /** Suggests claims and excerpts from a saved capture for a person to rule on. */
  claimExtraction?: ClaimExtractionService;
  /**
   * Checks whether citations still resolve (deterministic) and how each excerpt
   * bears on its claim (model-assisted advice).
   */
  citationReview?: CitationReviewService;
  /**
   * Reads which sources are the same information, so reprints are not counted
   * as corroboration. Computed from stored sources; writes only human rulings.
   */
  sourceIndependence?: SourceIndependenceService;
  /**
   * Source monitoring and re-check tasks: whether the material moved, what
   * that reaches, and the persisted, attributed work a person owes when it
   * did. Writes only the check trail, new captures and tasks — never a
   * verification status, never a verdict. See
   * services/core/src/research/source-monitor-service.ts.
   */
  sourceMonitor?: SourceMonitorService;
  /**
   * Immutable report versions: saving the current fact-check report as a
   * frozen snapshot, reading history, comparing two versions and exporting
   * one. Writes nothing but the snapshot row and its audit event — a save
   * never touches a claim status, a verification status or a ruling. See
   * services/core/src/research/report-snapshot-service.ts.
   */
  reportSnapshots?: ResearchReportSnapshotService;
  /**
   * The research plan: which diagnosed gaps a person decided to pursue, and
   * what came of each. Gaps are derived; plan items are stored and attributed.
   */
  researchPlan?: Pick<
    ResearchPlanRepository,
    | "addPlanItem"
    | "listCurrentPlanItems"
    | "listPlanItemHistory"
    | "getPlanItem"
    | "replacePlanItem"
  >;
  /**
   * Research quality assessment: a read-only projection of the workspace into
   * six explainable dimensions, findings and recommendations. Writes nothing —
   * it cannot change a claim status, a verdict, a verification state, a ruling
   * or a saved report. See
   * services/core/src/research/research-quality-projection.ts.
   */
  researchQuality?: ResearchQualityService;
  /**
   * The controlled research search: tasks and the candidates they surface.
   * Approving a task copies candidates into `sources`; it never writes
   * evidence. See services/core/src/research/search-provider.ts for the
   * (network-free, deterministic) provider contract.
   */
  researchSearch?: Pick<
    ResearchSearchRepository,
    | "createSearchTask"
    | "getSearchTask"
    | "startSearch"
    | "completeSearch"
    | "failSearch"
    | "rejectTask"
    | "markCandidateApproved"
    | "listCandidates"
    | "listSearchTasksWithCounts"
  >;
  /** Override for tests; defaults to the deterministic provider in production. */
  searchProvider?: import("./research/search-provider").SearchProvider;
  /**
   * Multilingual research: auxiliary translations of source snapshots, their
   * human reviews, and the session-scoped terminology glossary. A translation
   * is an auxiliary reading aid — nothing here writes evidence, a verification
   * status or a verdict. See
   * services/core/src/research/research-translation-service.ts.
   */
  translations?: TranslationRepository;
  terminology?: TerminologyRepository;
  /** Override for tests; production defaults to the unavailable provider. */
  translationProvider?: import("./research/translation-provider").TranslationProvider;
  arena?: Pick<ArenaRepository, "createResearchClaim" | "getSessionArtifacts">;
  reports?: Pick<
    FinalReportRepository,
    "getBySessionId" | "generateAndPersist"
  >;
  events: Pick<EventRepository, "append" | "listAfter">;
  runSession: {
    start(sessionId: string): Promise<void>;
  };
};

export type AppOptions = {
  eventBus?: EventBus;
  webOrigin?: string;
  runtimeInfo?: {
    mode: "mock" | "openai-compatible";
    provider: string;
    model: string;
  };
};

export function createApp(
  dependencies: AppDependencies,
  idempotency: IdempotencyStore = new InMemoryIdempotencyStore(),
  options: AppOptions = {}
): FastifyInstance {
  const app = Fastify();
  const eventBus = options.eventBus ?? new EventBus();
  const webOrigin =
    options.webOrigin ??
    process.env.WEB_ORIGIN ??
    "http://localhost:3000";
  const allowedOrigins = new Set([
    webOrigin,
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]);

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
      reply.header(
        "access-control-allow-headers",
        "content-type, idempotency-key, last-event-id"
      );
      reply.header(
        "access-control-allow-methods",
        "GET, POST, DELETE, OPTIONS"
      );
    }
    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  app.get("/health", async () => ({ status: "ok" }));

  // File uploads arrive as raw bytes, so those content types are read as buffers
  // with an explicit ceiling: unbounded bodies are not accepted anywhere, and
  // the ingestion service repeats this check rather than relying on it alone.
  if (dependencies.fileIngestion) {
    const configuredMb = Number(process.env.NEXUS_MAX_UPLOAD_MB ?? 10);
    const maxUploadBytes =
      (Number.isFinite(configuredMb) && configuredMb > 0
        ? configuredMb
        : 10) *
      1024 *
      1024;
    // A megabyte of slack lets the service answer with a useful message about
    // the limit instead of the connection being cut mid-body.
    const bodyLimit = maxUploadBytes + 1024 * 1024;
    const parseAsBuffer = (
      _request: unknown,
      body: unknown,
      done: (error: Error | null, value: unknown) => void
    ) => done(null, body);
    for (const contentType of [
      "application/octet-stream",
      "application/pdf",
      "text/csv",
      "text/markdown",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ]) {
      app.addContentTypeParser(contentType, { parseAs: "buffer", bodyLimit }, parseAsBuffer);
    }
    // `text/plain` has a built-in string parser; replace it so an .txt upload is
    // handled the same way as every other file instead of being decoded twice.
    try {
      app.removeContentTypeParser("text/plain");
      app.addContentTypeParser("text/plain", { parseAs: "buffer", bodyLimit }, parseAsBuffer);
    } catch {
      // Nothing to replace: text uploads keep working through the other types.
    }
  }

  app.get("/api/runtime", async () =>
    options.runtimeInfo ?? {
      mode: "mock",
      provider: "MockLlmProvider",
      model: "deterministic-fixtures"
    }
  );

  if (dependencies.auth) {
    registerAuthRoutes(app, dependencies.auth);
  }
  registerSessionRoutes(app, dependencies, idempotency);
  registerInspectorRoutes(app, dependencies);
  registerReportRoutes(app, dependencies);
  registerHumanDecisionRoutes(app, dependencies, idempotency, eventBus);
  registerEvidenceRoutes(app, dependencies, idempotency, eventBus);
  registerEvidenceMapRoutes(app, dependencies);
  registerClaimExtractionRoutes(app, dependencies, idempotency);
  registerCitationReviewRoutes(app, dependencies, idempotency);
  registerSourceIndependenceRoutes(app, dependencies, idempotency);
  registerSourceIntakeRoutes(app, dependencies, idempotency);
  registerSourceMonitoringRoutes(app, dependencies, idempotency);
  registerFileRoutes(app, dependencies, idempotency);
  registerResearchPlanRoutes(app, dependencies, idempotency);
  registerResearchSearchRoutes(app, dependencies, idempotency);
  registerReportSnapshotRoutes(app, dependencies, idempotency);
  registerResearchQualityRoutes(app, dependencies);
  registerMultilingualRoutes(app, dependencies, idempotency);
  registerAgentRunRoutes(app, dependencies, idempotency);
  registerReviewRoutes(app, dependencies, idempotency, eventBus);
  registerEventRoutes(app, {
    bus: eventBus,
    repository: dependencies.events
  }, allowedOrigins);

  return app;
}
