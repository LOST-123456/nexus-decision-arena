import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { createDatabase, type Database } from "../client";
import { DecisionSessionRepository } from "./decision-session-repository";
import { EventRepository } from "./event-repository";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const database: Database = createDatabase(databaseUrl);
const sessions = new DecisionSessionRepository(database);
const events = new EventRepository(database);

beforeEach(async () => {
  await database.execute(
    "TRUNCATE idempotency_keys, execution_events, projects, prompt_versions CASCADE"
  );
});

afterAll(async () => {
  await database.end();
});

describe("event repository", () => {
  it("allocates an increasing sequence per session", async () => {
    const projectId = newId();
    const sessionId = newId();
    await database.execute(
      `INSERT INTO projects (id, name, input) VALUES ('${projectId}', 'Demo', '{}'::jsonb)`
    );
    await sessions.create({
      id: sessionId,
      projectId,
      locale: "zh-CN",
      phase: "CREATED",
      operationalStatus: "ACTIVE",
      currentConclusion: null
    });

    const first = await events.append({
      sessionId,
      correlationId: newId(),
      type: "SESSION_STATE_CHANGED",
      payload: { phase: "PLANNING" }
    });
    const second = await events.append({
      sessionId,
      correlationId: first.correlationId,
      type: "SESSION_STATE_CHANGED",
      payload: { phase: "ANALYZING" }
    });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
  });
});
