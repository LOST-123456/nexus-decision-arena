import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "@nexus/shared";
import { createDatabase, type Database } from "../client";
import {
  agentRoles,
  agentRuns,
  challenges,
  claims,
  conflicts,
  executionEvents,
  evidence,
  humanDecisions,
  promptVersions
} from "../schema";
import { DecisionSessionRepository } from "./decision-session-repository";
import { FinalReportRepository } from "./final-report-repository";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for integration tests");
}

const database: Database = createDatabase(databaseUrl);
const sessions = new DecisionSessionRepository(database);
const reports = new FinalReportRepository(database);

beforeEach(async () => {
  await database.execute(
    "TRUNCATE idempotency_keys, execution_events, projects, prompt_versions CASCADE"
  );
});

afterAll(async () => {
  await database.end();
});

describe("FinalReportRepository", () => {
  it("persists a report derived from the decision, conflict, challenge, and evidence", async () => {
    const projectId = newId();
    const sessionId = newId();
    const promptVersionId = newId();
    const roleId = newId();
    const agentRunId = newId();
    const claimId = newId();
    const evidenceId = newId();
    const challengeId = newId();
    const conflictId = newId();
    const decisionId = newId();
    const timestamp = new Date().toISOString();

    await sessions.createWithProject(
      {
        name: "Live report project",
        summary: "Summary",
        targetUsers: "Teams",
        businessModel: "Subscription",
        expectedData: "Evidence"
      },
      {
        id: sessionId,
        projectId,
        locale: "zh-CN",
        phase: "HUMAN_REVIEW",
        operationalStatus: "PAUSED",
        currentConclusion: "暂缓规模化扩张"
      }
    );
    await database.insert(promptVersions).values({
      id: promptVersionId,
      name: "analyst",
      version: "1",
      content: "Analyze"
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
      statement: "Procurement evidence is missing",
      type: "assumption",
      stance: "oppose",
      importance: 5,
      confidence: 0.2,
      evidenceIds: [evidenceId],
      status: "contested",
      rootClaimId: claimId,
      revision: 1,
      relations: [],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await database.insert(evidence).values({
      id: evidenceId,
      sessionId,
      claimId,
      kind: "project_input",
      title: "Procurement evidence",
      content: "Pipeline is missing",
      description: "No signed pipeline",
      direction: "opposes",
      reliability: 0.7,
      verificationStatus: "verified",
      retrievedAt: timestamp,
      createdBy: "system"
    });
    await database.insert(challenges).values({
      id: challengeId,
      sessionId,
      targetClaimId: claimId,
      challengerRunId: agentRunId,
      challengerRoleId: roleId,
      type: "evidence_gap",
      question: "Where is the procurement pipeline?",
      context: {
        triggerClaimIds: [claimId],
        explanation: "The expansion depends on it."
      },
      requiredEvidence: ["Signed procurement pipeline"],
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
      summary: "Expansion conflicts with missing evidence",
      severity: 5,
      status: "human_review",
      humanDecisionRequired: true,
      resolutionSuggestion: "Run a limited pilot",
      impactScope: {
        analysisAreas: ["market"],
        stakeholders: ["Project team"]
      },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await database.insert(humanDecisions).values({
      id: decisionId,
      sessionId,
      conflictId,
      action: "accept_challenge",
      rationale: "Adopt the evidence challenge",
      affectedClaimIds: [claimId],
      affectedAgentRoleIds: [roleId],
      previousConclusion: "暂缓规模化扩张",
      newConclusion: "有限立项",
      operatorId: "operator-1",
      createdAt: timestamp
    });
    await database.insert(executionEvents).values({
      id: newId(),
      sessionId,
      sequence: 1,
      correlationId: newId(),
      type: "SESSION_STATE_CHANGED",
      payload: { currentConclusion: "建议立项" },
      occurredAt: timestamp
    });
    await database.execute(
      `UPDATE decision_sessions SET current_conclusion = '有限立项', phase = 'DECIDED', operational_status = 'COMPLETED', next_event_sequence = 2 WHERE id = '${sessionId}'`
    );

    const report = await reports.generateAndPersist(sessionId);

    expect(report).toMatchObject({
      sessionId,
      projectName: "Live report project",
      initialConclusion: "建议立项",
      postChallengeConclusion: "暂缓规模化扩张",
      finalConclusion: "有限立项",
      humanDecisionId: decisionId,
      decisiveChallengeIds: [challengeId],
      evidenceIds: [evidenceId],
      requiredNextActions: ["Signed procurement pipeline"]
    });
    await expect(reports.getBySessionId(sessionId)).resolves.toEqual(report);
  });
});
