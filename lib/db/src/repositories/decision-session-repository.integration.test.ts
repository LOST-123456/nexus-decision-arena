import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId, type HumanDecision } from "@nexus/shared";
import { createDatabase, type Database } from "../client";
import {
  agentRoles,
  agentRuns,
  challenges,
  claims,
  conflicts,
  decisionSessions,
  executionEvents,
  humanDecisions,
  projects,
  promptVersions
} from "../schema";
import {
  DecisionSessionRepository,
  HumanDecisionConflictNotEligibleError,
  SessionNotInHumanReviewError
} from "./decision-session-repository";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const database: Database = createDatabase(databaseUrl);
const repository = new DecisionSessionRepository(database);

beforeEach(async () => {
  await database.execute(
    "TRUNCATE idempotency_keys, execution_events, projects, prompt_versions CASCADE"
  );
});

afterAll(async () => {
  await database.end();
});

async function seedCheckpoint(options: {
  phase?: string;
  humanDecisionRequired?: boolean;
} = {}) {
  const projectId = newId();
  const sessionId = newId();
  const promptVersionId = newId();
  const roleId = newId();
  const agentRunId = newId();
  const claimId = newId();
  const challengeId = newId();
  const conflictId = newId();
  const timestamp = new Date().toISOString();

  await database.insert(projects).values({
    id: projectId,
    name: "Demo",
    input: {}
  });
  await repository.create({
    id: sessionId,
    projectId,
    locale: "zh-CN",
    phase: options.phase ?? "HUMAN_REVIEW",
    operationalStatus: "PAUSED",
    currentConclusion: "Hold scale-up"
  });
  await database.insert(promptVersions).values({
    id: promptVersionId,
    name: "analyst",
    version: projectId,
    content: "Analyze the project."
  });
  await database.insert(agentRoles).values({
    id: roleId,
    key: "market_analyst",
    name: "Market Analyst",
    goal: "Analyze",
    perspective: "Evidence",
    evaluationCriteria: ["evidence"],
    evidenceRequired: ["source"],
    conflictPreference: ["evidence_gap"],
    lenses: ["market"],
    promptVersionId
  });
  await database.insert(agentRuns).values({
    id: agentRunId,
    sessionId,
    roleId,
    promptVersionId,
    status: "completed"
  });
  await database.insert(claims).values({
    id: claimId,
    sessionId,
    agentRunId,
    roleId,
    lens: "market",
    statement: "The growth target lacks evidence.",
    type: "assumption",
    stance: "oppose",
    importance: 5,
    confidence: 0.2,
    evidenceIds: [],
    status: "contested",
    rootClaimId: claimId,
    revision: 1,
    relations: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await database.insert(challenges).values({
    id: challengeId,
    sessionId,
    targetClaimId: claimId,
    challengerRunId: agentRunId,
    challengerRoleId: roleId,
    type: "evidence_gap",
    question: "Where is the procurement evidence?",
    context: {
      triggerClaimIds: [claimId],
      explanation: "The growth target lacks evidence."
    },
    requiredEvidence: ["Procurement pipeline"],
    severity: 5,
    resolutionStrategy: "provide_evidence",
    status: "unresolved",
    correlationId: newId(),
    createdAt: timestamp,
    updatedAt: timestamp
  });
  await database.insert(conflicts).values({
    id: conflictId,
    sessionId,
    claimIds: [claimId],
    challengeIds: [challengeId],
    type: "evidence",
    summary: "Procurement evidence is missing.",
    severity: 5,
    status: "human_review",
    humanDecisionRequired: options.humanDecisionRequired ?? true,
    resolutionSuggestion: "Adopt the challenge.",
    impactScope: {
      analysisAreas: ["market", "finance"],
      stakeholders: ["Project team"]
    },
    createdAt: timestamp,
    updatedAt: timestamp
  });

  return { sessionId, conflictId, claimId };
}

function decision(
  sessionId: string,
  conflictId: string,
  affectedClaimIds: string[],
  newConclusion = "Limited pilot"
): HumanDecision {
  return {
    id: newId(),
    sessionId,
    conflictId,
    action: "accept_challenge",
    rationale: "Challenge evidence is sufficient",
    affectedClaimIds,
    affectedAgentRoleIds: [],
    previousConclusion: "Forged client value",
    newConclusion,
    operatorId: "operator-1",
    createdAt: new Date().toISOString()
  };
}

async function record(
  sessionId: string,
  record: HumanDecision
) {
  return repository.recordHumanDecision({
    decision: record,
    transition: {
      phase: "DECIDED",
      operationalStatus: "COMPLETED",
      conclusion: record.newConclusion
    },
    event: {
      correlationId: record.id,
      type: "SESSION_STATE_CHANGED",
      payload: {
        phase: "DECIDED",
        operationalStatus: "COMPLETED",
        currentConclusion: record.newConclusion,
        humanDecision: record
      }
    }
  });
}

describe("DecisionSessionRepository.recordHumanDecision", () => {
  it("commits the decision, transition, and event with persisted history", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint();
    const recordInput = decision(sessionId, conflictId, [claimId]);

    const result = await record(sessionId, recordInput);

    expect(result.event.sequence).toBe(1);
    expect(result.decision.previousConclusion).toBe("Hold scale-up");
    expect(
      (result.event.payload as { humanDecision: HumanDecision }).humanDecision
        .previousConclusion
    ).toBe("Hold scale-up");
    expect(result.session).toMatchObject({
      id: sessionId,
      phase: "DECIDED",
      operationalStatus: "COMPLETED",
      currentConclusion: "Limited pilot",
      nextEventSequence: 2
    });
    const [storedDecision] = await database
      .select()
      .from(humanDecisions)
      .where(eq(humanDecisions.id, recordInput.id));
    expect(storedDecision?.previousConclusion).toBe("Hold scale-up");
    await expect(
      database
        .select()
        .from(executionEvents)
        .where(eq(executionEvents.id, result.event.id))
    ).resolves.toHaveLength(1);
  });

  it("rejects a session that is not awaiting human review", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint({
      phase: "ANALYZING"
    });
    const recordInput = decision(sessionId, conflictId, [claimId]);

    await expect(record(sessionId, recordInput)).rejects.toBeInstanceOf(
      SessionNotInHumanReviewError
    );

    const [session] = await database
      .select()
      .from(decisionSessions)
      .where(eq(decisionSessions.id, sessionId));
    expect(session).toMatchObject({
      phase: "ANALYZING",
      currentConclusion: "Hold scale-up",
      nextEventSequence: 1
    });
  });

  it("rejects a conflict that is not eligible for human review", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint({
      humanDecisionRequired: false
    });
    const recordInput = decision(sessionId, conflictId, [claimId]);

    await expect(record(sessionId, recordInput)).rejects.toBeInstanceOf(
      HumanDecisionConflictNotEligibleError
    );

    await expect(
      database
        .select()
        .from(humanDecisions)
        .where(eq(humanDecisions.id, recordInput.id))
    ).resolves.toHaveLength(0);
  });

  it("allows only one concurrent decision to win", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint();
    const first = decision(sessionId, conflictId, [claimId], "Limited pilot");
    const second = decision(sessionId, conflictId, [claimId], "Reject proposal");

    const results = await Promise.allSettled([
      record(sessionId, first),
      record(sessionId, second)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected" });
    if (!rejected || rejected.status !== "rejected") {
      throw new Error("Expected one rejected decision");
    }
    expect(rejected.reason).toBeInstanceOf(SessionNotInHumanReviewError);

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
    const [session] = await database
      .select()
      .from(decisionSessions)
      .where(eq(decisionSessions.id, sessionId));
    expect(session).toMatchObject({
      phase: "DECIDED",
      nextEventSequence: 2
    });
  });
  it("rejects a conflict that belongs to another session", async () => {
    const target = await seedCheckpoint();
    const other = await seedCheckpoint();
    const recordInput = decision(target.sessionId, other.conflictId, []);

    await expect(record(target.sessionId, recordInput)).rejects.toBeInstanceOf(
      HumanDecisionConflictNotEligibleError
    );

    await expect(
      database
        .select()
        .from(humanDecisions)
        .where(eq(humanDecisions.id, recordInput.id))
    ).resolves.toHaveLength(0);
  });
});