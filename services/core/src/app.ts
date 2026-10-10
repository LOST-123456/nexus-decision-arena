import type {
  ArenaRepository,
  DecisionSessionRepository,
  EventRepository,
  EvidenceRepository,
  FinalReportRepository,
  InspectorRepository,
  ReviewRepository
} from "@nexus/db";
import Fastify, { type FastifyInstance } from "fastify";
import {
  InMemoryIdempotencyStore,
  type IdempotencyStore
} from "./api/plugins/idempotency";
import { registerAuthRoutes } from "./api/routes/auth";
import { registerEvidenceRoutes } from "./api/routes/evidence";
import { registerEventRoutes } from "./api/routes/events";
import { registerHumanDecisionRoutes } from "./api/routes/human-decisions";
import { registerInspectorRoutes } from "./api/routes/inspector";
import { registerReportRoutes } from "./api/routes/reports";
import { registerReviewRoutes } from "./api/routes/review";
import { registerSessionRoutes } from "./api/routes/sessions";
import { registerClaimExtractionRoutes } from "./api/routes/claim-extraction";
import { registerCitationReviewRoutes } from "./api/routes/citation-review";
import { registerSourceIntakeRoutes } from "./api/routes/source-intake";
import { EventBus } from "./execution/event-bus";
import type { CrossReviewService } from "./research/cross-review-service";
import type { ClaimExtractionService } from "./research/claim-extraction-service";
import type { CitationReviewService } from "./research/citation-review-service";
import type { SourceImportService } from "./research/source-import-service";

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
  /** Imports a page and keeps the failure record when it cannot be read. */
  sourceIntake?: SourceImportService;
  /** Suggests claims and excerpts from a saved capture for a person to rule on. */
  claimExtraction?: ClaimExtractionService;
  /**
   * Checks whether citations still resolve (deterministic) and how each excerpt
   * bears on its claim (model-assisted advice).
   */
  citationReview?: CitationReviewService;
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
  registerClaimExtractionRoutes(app, dependencies, idempotency);
  registerCitationReviewRoutes(app, dependencies, idempotency);
  registerSourceIntakeRoutes(app, dependencies, idempotency);
  registerReviewRoutes(app, dependencies, idempotency, eventBus);
  registerEventRoutes(app, {
    bus: eventBus,
    repository: dependencies.events
  }, allowedOrigins);

  return app;
}
