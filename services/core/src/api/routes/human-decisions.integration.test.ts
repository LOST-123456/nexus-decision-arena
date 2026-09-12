import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  DecisionSessionRepository,
  decisionSessions,
  executionEvents,
  humanDecisions,
  projects,
  conflicts,
  type Database
} from "@nexus/db";
import { newId } from "@nexus/shared";
import { createApp } from "../../app";
import { EventBus } from "../../execution/event-bus";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const database: Database = createDatabase(databaseUrl);
const sessions = new DecisionSessionRepository(database);

beforeEach(async () => {
  await database.execute(
    "TRUNCATE idempotency_keys, execution_events, projects, prompt_versions CASCADE"
  );
});

afterAll(async () => {
  await database.end();
});

async function seedCheckpoint() {
  const projectId = newId();
  const sessionId = newId();
  const conflictId = newId();
  const timestamp = new Date().toISOString();

  await database.insert(projects).values({
    id: projectId,
    name: "Demo",
    input: {}
  });
  await sessions.create({
    id: sessionId,
    projectId,
    locale: "zh-CN",
    phase: "HUMAN_REVIEW",
    operationalStatus: "PAUSED",
    currentConclusion: "Hold scale-up"
  });
  await database.insert(conflicts).values({
    id: conflictId,
    sessionId,
    claimIds: [],
    challengeIds: [],
    type: "evidence",
    summary: "Procurement evidence is missing.",
    severity: 5,
    status: "human_review",
    humanDecisionRequired: true,
    resolutionSuggestion: "Adopt the challenge.",
    impactScope: {
      analysisAreas: ["market"],
      stakeholders: ["Project team"]
    },
    createdAt: timestamp,
    updatedAt: timestamp
  });

  return { sessionId, conflictId };
}

function createTestApp(eventBus: EventBus) {
  return createApp(
    {
      sessions,
      inspector: {} as never,
      events: {} as never,
      runSession: {} as never
    },
    undefined,
    { eventBus }
  );
}

describe("human decision route integration", () => {
  it("publishes only after the transaction is committed", async () => {
    const { sessionId, conflictId } = await seedCheckpoint();
    const eventBus = new EventBus();
    const observed = new Promise<void>((resolve, reject) => {
      eventBus.subscribe(sessionId, () => {
        void database
          .select()
          .from(decisionSessions)
          .where(eq(decisionSessions.id, sessionId))
          .then(([session]) => {
            expect(session).toMatchObject({
              phase: "DECIDED",
              currentConclusion: "Limited pilot"
            });
            resolve();
          })
          .catch(reject);
      });
    });
    const app = createTestApp(eventBus);

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "publish-after-commit" },
      payload: {
        conflictId,
        action: "accept_challenge",
        rationale: "Challenge evidence is sufficient",
        affectedClaimIds: [],
        affectedAgentRoleIds: [],
        newConclusion: "Limited pilot",
        operatorId: "operator-1"
      }
    });

    expect(response.statusCode).toBe(201);
    await observed;
  });

  it("keeps persisted state when event publication fails", async () => {
    const { sessionId, conflictId } = await seedCheckpoint();
    const eventBus = new EventBus();
    eventBus.subscribe(sessionId, () => {
      throw new Error("subscriber failed");
    });
    const app = createTestApp(eventBus);

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/human-decisions`,
      headers: { "idempotency-key": "publish-failure" },
      payload: {
        conflictId,
        action: "accept_challenge",
        rationale: "Challenge evidence is sufficient",
        affectedClaimIds: [],
        affectedAgentRoleIds: [],
        newConclusion: "Limited pilot",
        operatorId: "operator-1"
      }
    });

    expect(response.statusCode).toBe(201);
    const [session] = await database
      .select()
      .from(decisionSessions)
      .where(eq(decisionSessions.id, sessionId));
    expect(session).toMatchObject({
      phase: "DECIDED",
      operationalStatus: "COMPLETED",
      currentConclusion: "Limited pilot",
      nextEventSequence: 2
    });
    await expect(
      database
        .select()
        .from(humanDecisions)
        .where(eq(humanDecisions.sessionId, sessionId))
    ).resolves.toHaveLength(1);
    await expect(
      database
        .select()
        .from(executionEvents)
        .where(eq(executionEvents.sessionId, sessionId))
    ).resolves.toHaveLength(1);
  });
});
