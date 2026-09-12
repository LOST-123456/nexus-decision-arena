import type {
  DecisionSessionRepository,
  EventRepository,
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
    "createWithProject" | "getById" | "recordHumanDecision"
  >;
  inspector: Pick<InspectorRepository, "getInspector">;
  events: Pick<EventRepository, "append" | "listAfter">;
  runSession: {
    start(sessionId: string): Promise<void>;
  };
};

export type AppOptions = {
  eventBus?: EventBus;
};

export function createApp(
  dependencies: AppDependencies,
  idempotency: IdempotencyStore = new InMemoryIdempotencyStore(),
  options: AppOptions = {}
): FastifyInstance {
  const app = Fastify();
  const eventBus = options.eventBus ?? new EventBus();

  app.get("/health", async () => ({ status: "ok" }));

  registerSessionRoutes(app, dependencies, idempotency);
  registerInspectorRoutes(app, dependencies);
  registerHumanDecisionRoutes(app, dependencies, idempotency, eventBus);
  registerEventRoutes(app, {
    bus: eventBus,
    repository: dependencies.events
  });

  return app;
}
