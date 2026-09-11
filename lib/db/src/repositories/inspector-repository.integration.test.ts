import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { createDatabase, type Database } from "../client";
import { DecisionSessionRepository } from "./decision-session-repository";
import { InspectorRepository } from "./inspector-repository";
import {
  agentRoles,
  agentRuns,
  challenges,
  claims,
  conflicts,
  evidence,
  promptVersions
} from "../schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const database: Database = createDatabase(databaseUrl);
const repository = new InspectorRepository(database);
const sessions = new DecisionSessionRepository(database);

beforeEach(async () => {
  await database.execute(
    "TRUNCATE idempotency_keys, execution_events, projects, prompt_versions CASCADE"
  );
});

afterAll(async () => {
  await database.end();
});

describe("inspector repository", () => {
  it("returns null for a missing claim", async () => {
    const result = await repository.getInspector(newId(), newId());
    expect(result).toBeNull();
  });

  it("returns the stable DTO for a populated claim", async () => {
    const projectId = newId();
    const sessionId = newId();
    const promptVersionId = newId();
    const roleId = newId();
    const agentRunId = newId();
    const claimId = newId();
    const evidenceId = newId();
    const challengeId = newId();
    const conflictId = newId();
    const createdAt = new Date().toISOString();

    await sessions.createWithProject(
      {
        name: "Demo",
        summary: "A test project",
        targetUsers: "Students",
        businessModel: "Free",
        expectedData: "Survey data"
      },
      {
        id: sessionId,
        projectId,
        locale: "zh-CN",
        phase: "CREATED",
        operationalStatus: "ACTIVE",
        currentConclusion: null
      }
    );

    await database.insert(promptVersions).values({
      id: promptVersionId,
      name: "analyst",
      version: "1",
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
      statement: "The campus market is growing.",
      type: "fact",
      stance: "support",
      importance: 5,
      confidence: 0.9,
      evidenceIds: [evidenceId],
      status: "proposed",
      rootClaimId: claimId,
      revision: 1,
      relations: [],
      createdAt,
      updatedAt: createdAt
    });
    await database.insert(evidence).values({
      id: evidenceId,
      sessionId,
      claimId,
      kind: "project_input",
      title: "Survey",
      content: "Demand increased.",
      description: "Student survey result",
      direction: "supports",
      reliability: 0.8,
      verificationStatus: "verified",
      retrievedAt: createdAt,
      createdBy: "system"
    });
    await database.insert(challenges).values({
      id: challengeId,
      sessionId,
      targetClaimId: claimId,
      challengerRunId: agentRunId,
      challengerRoleId: roleId,
      type: "evidence_gap",
      question: "Is the survey representative?",
      context: {
        triggerClaimIds: [claimId],
        explanation: "The sample size is not shown."
      },
      requiredEvidence: ["Sample size"],
      severity: 4,
      resolutionStrategy: "provide_evidence",
      status: "open",
      correlationId: newId(),
      createdAt,
      updatedAt: createdAt
    });
    await database.insert(conflicts).values({
      id: conflictId,
      sessionId,
      claimIds: [claimId],
      challengeIds: [challengeId],
      type: "evidence",
      summary: "Evidence remains incomplete.",
      severity: 4,
      status: "human_review",
      humanDecisionRequired: true,
      resolutionSuggestion: "Request more evidence.",
      impactScope: {
        analysisAreas: ["market"],
        stakeholders: ["Students"]
      },
      createdAt,
      updatedAt: createdAt
    });

    const result = await repository.getInspector(sessionId, claimId);
    if (!result) {
      throw new Error("Expected an inspector result");
    }

    expect(result).toMatchObject({
      claim: {
        id: claimId,
        sessionId,
        evidenceIds: [evidenceId]
      },
      evidence: [{ id: evidenceId }],
      challenges: [{ id: challengeId }],
      conflicts: [{ id: conflictId }],
      provenance: {
        agentRun: { id: agentRunId },
        promptVersion: { id: promptVersionId }
      },
      decisionRationale: {
        outcome: "needs_human",
        evidenceIds: [evidenceId]
      }
    });
  });
});
