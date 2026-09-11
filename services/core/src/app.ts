import type { ExecutionEvent } from "@nexus/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { InMemoryIdempotencyStore } from "./api/plugins/idempotency";
import { registerHumanDecisionRoutes } from "./api/routes/human-decisions";
import { registerInspectorRoutes } from "./api/routes/inspector";
import { registerSessionRoutes } from "./api/routes/sessions";

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

export type SessionRecord = {
  id: string;
};

type EventAppendInput = Pick<
  ExecutionEvent,
  "sessionId" | "correlationId" | "type" | "payload"
> &
  Partial<Pick<ExecutionEvent, "traceId" | "promptVersionId">>;

export type AppDependencies = {
  sessions: {
    createWithProject(
      project: ProjectInput,
      session: SessionInput
    ): Promise<SessionRecord | null>;
    getById(id: string): Promise<SessionRecord | null>;
  };
  inspector: {
    getInspector(sessionId: string, claimId: string): Promise<unknown | null>;
  };
  events: {
    append(input: EventAppendInput): Promise<ExecutionEvent>;
    listAfter(sessionId: string, sequence: number): Promise<unknown[]>;
  };
  runSession: {
    start(sessionId: string): Promise<void>;
  };
};

export function createApp(
  dependencies: AppDependencies,
  idempotency = new InMemoryIdempotencyStore()
): FastifyInstance {
  const app = Fastify();

  registerSessionRoutes(app, dependencies, idempotency);
  registerInspectorRoutes(app, dependencies);
  registerHumanDecisionRoutes(app);

  return app;
}
