import type {
  DecisionSessionRepository,
  EventRepository,
  FinalReportRepository,
  InspectorRepository
} from "@nexus/db";
import Fastify, { type FastifyInstance } from "fastify";
import {
  InMemoryIdempotencyStore,
  type IdempotencyStore
} from "./api/plugins/idempotency";
import { registerEventRoutes } from "./api/routes/events";
import { registerHumanDecisionRoutes } from "./api/routes/human-decisions";
import { registerInspectorRoutes } from "./api/routes/inspector";
import { registerReportRoutes } from "./api/routes/reports";
import { registerSessionRoutes } from "./api/routes/sessions";
import { EventBus } from "./execution/event-bus";

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
};

export type SessionRecord = NonNullable<
  Awaited<ReturnType<DecisionSessionRepository["createWithProject"]>>
>;

export type AppDependencies = {
  sessions: Pick<
    DecisionSessionRepository,
    | "createWithProject"
    | "getById"
    | "getView"
    | "recordHumanDecision"
    | "getProjectBySessionId"
  >;
  inspector: Pick<InspectorRepository, "getInspector">;
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
        "GET, POST, OPTIONS"
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

  registerSessionRoutes(app, dependencies, idempotency);
  registerInspectorRoutes(app, dependencies);
  registerReportRoutes(app, dependencies);
  registerHumanDecisionRoutes(app, dependencies, idempotency, eventBus);
  registerEventRoutes(app, {
    bus: eventBus,
    repository: dependencies.events
  }, allowedOrigins);

  return app;
}
