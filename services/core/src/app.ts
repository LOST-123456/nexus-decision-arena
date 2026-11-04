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
  SourceLibraryRepository,
  TerminologyRepository,
  TranslationRepository
} from "@nexus/db";
import Fastify, { type FastifyInstance } from "fastify";
import {
  InMemoryIdempotencyStore,
  type IdempotencyStore
} from "./api/plugins/idempotency";
import { registerAuthRoutes } from "./api/routes/auth";
import type { AuthAuditSink } from "./auth-audit";
import { LoginThrottle } from "./login-rate-limit";
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
import { registerResearchLibraryRoutes } from "./api/routes/research-library";
import { registerTeamCollaborationRoutes } from "./api/routes/research-collaboration";
import { registerAgentRunRoutes } from "./api/routes/agent-runs";
import { EventBus } from "./execution/event-bus";
import {
  registerBrowserSecurity
} from "./api/security/browser-security";
import {
  resolveOriginPolicy,
  type OriginPolicy
} from "./api/security/origin-policy";
import type { CrossReviewService } from "./research/cross-review-service";
import type { AgentRunService } from "./research/agent-run-service";
import type { ClaimExtractionService } from "./research/claim-extraction-service";
import type { CitationReviewService } from "./research/citation-review-service";
import type { SourceImportService } from "./research/source-import-service";
import type { FileIngestionService } from "./research/file-ingestion-service";
import type { SourceIndependenceService } from "./research/source-independence-service";
import type { SourceMonitorService } from "./research/source-monitor-service";
import type { TeamCollaborationRepository } from "@nexus/db";
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
  /**
   * Who the research belongs to, from the server-side login identity. Null
   * for sessions created without an authenticated user: the library treats
   * those as legacy workspace sessions and restricts grant administration
   * on them to the `owner` role.
   */
  ownerUserId?: string | null;
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
  /**
   * Cross-research library: share grants, copy lineage, and the authorized
   * reads that back them. A caller sees a session's material only when they
   * own it or hold a live grant; unknown or unauthorized ids answer 404. See
   * services/core/src/research/source-library-service.ts.
   */
  sourceLibrary?: SourceLibraryRepository;
  /**
   * Team collaboration & human review: members, work items, threaded comments
   * and review requests, all keyed by `session_id` so nothing crosses the
   * session boundary. Every write is gated on the caller's collaboration role
   * (owner/editor/reviewer/viewer), derived from session ownership or their
   * membership; unknown or unauthorized sessions answer 404. See
   * services/core/src/research/team-collaboration-service.ts.
   */
  teamCollaboration?: TeamCollaborationRepository;
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

/**
 * What "the database is not there" looks like from here.
 *
 * SQLSTATE class 08 is the connection exception family; 53 is insufficient
 * resources; `57P03` is `cannot_connect_now`, which is exactly what PostgreSQL
 * answers while it is still replaying its WAL after a restart — the case that
 * took three and a half minutes last time. The socket errors are what the
 * driver reports when the container is simply not up.
 */
const DATABASE_UNAVAILABLE_CODES = new Set([
  "57P03",
  "53300",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT"
]);

function isDatabaseUnavailable(code: unknown): boolean {
  return (
    typeof code === "string" && DATABASE_UNAVAILABLE_CODES.has(code.toUpperCase())
  );
}

export type AppOptions = {
  eventBus?: EventBus;
  /**
   * The web origin this deployment serves. Kept for the single-origin case;
   * it seeds the trusted-origin policy. Every write request is checked against
   * that policy — see `api/security/origin-policy.ts`.
   */
  webOrigin?: string;
  /**
   * The trusted-origin policy, resolved once by the process that owns the
   * deployment (`server.ts`). Left unset, it is resolved from the environment
   * here, which is what a test app wants: the same rules, without a process.
   */
  originPolicy?: OriginPolicy;
  /** Turn the CSRF guard off for a non-browser process. Never used in service. */
  enforceOriginGuard?: boolean;
  runtimeInfo?: {
    mode: "mock" | "openai-compatible";
    provider: string;
    model: string;
  };
  /**
   * How the authentication routes behave. Left unset, a test app gets an
   * in-process throttle and a non-secure cookie; `server.ts` passes the real
   * deployment values resolved from the environment.
   */
  authRuntime?: {
    secureCookies?: boolean;
    loginThrottle?: LoginThrottle;
    auditSink?: AuthAuditSink;
  };
  /**
   * Where an unexpected failure is written down. The response body cannot
   * carry it (see the error handler in `createApp`), so this is the only
   * place the operator can still find out what actually broke. Left unset
   * nothing is written, which is what a test app wants.
   */
  reportError?: (
    error: unknown,
    context: { method: string; url: string; statusCode: number }
  ) => void;
};

export function createApp(
  dependencies: AppDependencies,
  idempotency: IdempotencyStore = new InMemoryIdempotencyStore(),
  options: AppOptions = {}
): FastifyInstance {
  const app = Fastify();
  const eventBus = options.eventBus ?? new EventBus();
  const originPolicy =
    options.originPolicy ??
    resolveOriginPolicy(process.env, {
      webOriginOverride: options.webOrigin ?? ""
    });

  /**
   * One place decides what a failure looks like on the wire.
   *
   * Fastify's default body is `{ statusCode, code, error, message }`, and it
   * fills `code` from whatever was thrown — which is how "ECONNREFUSED",
   * "57P03" and a driver's internal wording ended up in a response the
   * browser renders. A 4xx is the caller's problem and its message is meant
   * to be read; a 5xx is this machine's problem and leaves as one sentence.
   * The detail goes to `reportError` instead, where an operator can find it.
   */
  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const statusCode =
      typeof error.statusCode === "number" && error.statusCode >= 400
        ? error.statusCode
        : 500;
    if (statusCode < 500) {
      // Business codes that routes attach themselves (`session_not_found`)
      // survive, because a client switches on them.
      const code = (error as { code?: unknown }).code;
      return reply
        .code(statusCode)
        .send(
          typeof code === "string" && /^[a-z0-9_]+$/.test(code)
            ? { error: error.message, code }
            : { error: error.message }
        );
    }
    options.reportError?.(error, {
      method: request.method,
      url: request.url,
      statusCode
    });
    /**
     * "The database is not reachable right now" is different from "this
     * request blew up": nothing is broken in this process, and the operator's
     * next move is to wait or to start the container, not to read a stack
     * trace. It gets its own status and a stable code, so the page can say so
     * — without naming the driver that said it.
     */
    const code = (error as { code?: unknown }).code;
    if (isDatabaseUnavailable(code)) {
      return reply
        .code(503)
        .send({ error: "Database unavailable", code: "database_unavailable" });
    }
    // Deliberately no `message` key: a client that prefers `message` over
    // `error` (apps/web/lib/api-transport.ts) would otherwise render an
    // empty string instead of its own operator-facing copy.
    return reply.code(statusCode).send({ error: "Internal server error" });
  });

  /**
   * CORS and CSRF share this one policy. Installing them before any route
   * means both run ahead of every handler, and that a refusal happens before a
   * body is parsed or a lease is taken.
   */
  registerBrowserSecurity(app, originPolicy, {
    enforce: options.enforceOriginGuard !== false
  });
  const allowedOrigins = originPolicy.allowed;

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
    const authRuntime = options.authRuntime;
    registerAuthRoutes(app, dependencies.auth, {
      secureCookies: authRuntime?.secureCookies === true,
      loginThrottle: authRuntime?.loginThrottle ?? new LoginThrottle(),
      // Spread rather than assign: `exactOptionalPropertyTypes` is on, and
      // passing an explicit `undefined` here would be a different type.
      ...(authRuntime?.auditSink ? { auditSink: authRuntime.auditSink } : {})
    });
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
  registerResearchLibraryRoutes(app, dependencies, idempotency);
  registerTeamCollaborationRoutes(app, dependencies, idempotency);
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
