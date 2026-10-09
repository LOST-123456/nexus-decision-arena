import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newId, type HumanDecision } from "@nexus/shared";
import type { Database } from "../client";
import { createTestDatabase } from "../testing/test-database";
import {
  agentRoles,
  agentRuns,
  challenges,
  claims,
  conflicts,
  decisionSessions,
  evidence,
  executionEvents,
  humanDecisions,
  projects,
  promptVersions
} from "../schema";
import {
  DecisionSessionRepository,
  HumanDecisionConflictNotEligibleError,
  SessionNotInHumanReviewError,
  SupplementRoundLimitError
} from "./decision-session-repository";

// fail-closed：未配置 TEST_DATABASE_URL 时在建连之前抛错；目标必须是专用测试库。
const database: Database = createTestDatabase();
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
  conflictStatus?: string;
  claimImportance?: number;
  claimStatus?: string;
  verificationStatus?: "verified" | "unverified" | "rejected";
} = {}) {
  const projectId = newId();
  const sessionId = newId();
  let promptVersionId = newId();
  let roleId = newId();
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
  const [existingRole] = await database
    .select()
    .from(agentRoles)
    .where(eq(agentRoles.key, "market_analyst"))
    .limit(1);
  if (existingRole) {
    roleId = existingRole.id;
    promptVersionId = existingRole.promptVersionId;
  } else {
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
  }
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
    importance: options.claimImportance ?? 5,
    confidence: 0.2,
    evidenceIds: [],
    status: options.claimStatus ?? "contested",
    rootClaimId: claimId,
    revision: 1,
    relations: [],
    createdAt: timestamp,
    updatedAt: timestamp
  });
  if (options.verificationStatus) {
    await database.insert(evidence).values({
      id: newId(),
      sessionId,
      claimId,
      kind: "calculation",
      title: "Procurement pipeline",
      content: "Derived from the signed pipeline.",
      description: "Calculated from the project input.",
      direction: "supports",
      reliability: 0.8,
      verificationStatus: options.verificationStatus,
      retrievedAt: timestamp,
      createdBy: "system"
    });
  }
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
    status: options.conflictStatus ?? "human_review",
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
  newConclusion = "Limited pilot",
  action: HumanDecision["action"] = "accept_challenge"
): HumanDecision {
  return {
    id: newId(),
    sessionId,
    conflictId,
    action,
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

  it("allows only one supplement round per session", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint();
    const requestDecision: HumanDecision = {
      ...decision(sessionId, conflictId, [claimId], "Supplement requested"),
      action: "request_more_analysis",
      rationale: "Provide the missing evidence once"
    };

    const first = await repository.recordHumanDecision({
      decision: requestDecision,
      transition: {
        phase: "REASSESSING",
        operationalStatus: "ACTIVE",
        conclusion: requestDecision.newConclusion
      },
      event: {
        correlationId: requestDecision.id,
        type: "SESSION_STATE_CHANGED",
        payload: {
          phase: "REASSESSING",
          operationalStatus: "ACTIVE",
          currentConclusion: requestDecision.newConclusion,
          humanDecision: requestDecision
        }
      }
    });

    expect(first.session.supplementRound).toBe(1);

    await database
      .update(decisionSessions)
      .set({ phase: "HUMAN_REVIEW", operationalStatus: "PAUSED" })
      .where(eq(decisionSessions.id, sessionId));
    const secondDecision: HumanDecision = {
      ...decision(sessionId, conflictId, [claimId], "Supplement again"),
      action: "request_more_analysis",
      rationale: "Request a second round"
    };

    await expect(
      record(sessionId, secondDecision)
    ).rejects.toBeInstanceOf(SupplementRoundLimitError);
  });
});

describe("DecisionSessionRepository.recordHumanDecision write-back", () => {
  async function statuses(conflictId: string, claimId: string) {
    const [conflict] = await database
      .select()
      .from(conflicts)
      .where(eq(conflicts.id, conflictId));
    const [claim] = await database
      .select()
      .from(claims)
      .where(eq(claims.id, claimId));
    return {
      conflict: conflict?.status,
      humanDecisionRequired: conflict?.humanDecisionRequired,
      claim: claim?.status
    };
  }

  it("resolves the conflict and rejects the contested claim when the challenge is adopted", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint();

    const result = await record(
      sessionId,
      decision(sessionId, conflictId, [claimId])
    );

    await expect(statuses(conflictId, claimId)).resolves.toEqual({
      conflict: "resolved",
      humanDecisionRequired: true,
      claim: "rejected"
    });

    const payload = result.event.payload as {
      writeback: { conflictId: string; conflictStatus: string; claimUpdates: unknown[] };
    };
    expect(payload.writeback.conflictId).toBe(conflictId);
    expect(payload.writeback.conflictStatus).toBe("resolved");
    expect(payload.writeback.claimUpdates).toEqual([
      { claimId, status: "rejected", reason: "challenge_accepted" }
    ]);
  });

  it("records an upheld important claim without verified evidence as supported", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint({
      claimImportance: 5
    });

    await record(
      sessionId,
      decision(sessionId, conflictId, [claimId], "Keep the claim", "uphold_claim")
    );

    await expect(statuses(conflictId, claimId)).resolves.toMatchObject({
      conflict: "resolved",
      claim: "supported"
    });
  });

  it("accepts an upheld claim once its evidence is verified", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint({
      claimImportance: 5,
      verificationStatus: "verified"
    });

    await record(
      sessionId,
      decision(sessionId, conflictId, [claimId], "Keep the claim", "uphold_claim")
    );

    await expect(statuses(conflictId, claimId)).resolves.toMatchObject({
      conflict: "resolved",
      claim: "accepted"
    });
  });

  it("accepts an upheld low-importance claim without verified evidence", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint({
      claimImportance: 2
    });

    await record(
      sessionId,
      decision(sessionId, conflictId, [claimId], "Keep the claim", "uphold_claim")
    );

    await expect(statuses(conflictId, claimId)).resolves.toMatchObject({
      conflict: "resolved",
      claim: "accepted"
    });
  });

  it("re-opens the conflict and disputes the claim when a supplement is requested", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint();
    const requestDecision = decision(
      sessionId,
      conflictId,
      [claimId],
      "Supplement requested",
      "request_more_analysis"
    );

    await repository.recordHumanDecision({
      decision: requestDecision,
      transition: {
        phase: "REASSESSING",
        operationalStatus: "ACTIVE",
        conclusion: requestDecision.newConclusion
      },
      event: {
        correlationId: requestDecision.id,
        type: "SESSION_STATE_CHANGED",
        payload: {
          phase: "REASSESSING",
          operationalStatus: "ACTIVE",
          currentConclusion: requestDecision.newConclusion
        }
      }
    });

    await expect(statuses(conflictId, claimId)).resolves.toMatchObject({
      conflict: "detected",
      claim: "contested"
    });
  });

  it("refuses a second ruling on an already resolved conflict", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint();

    await record(sessionId, decision(sessionId, conflictId, [claimId]));
    await database
      .update(decisionSessions)
      .set({ phase: "HUMAN_REVIEW", operationalStatus: "PAUSED" })
      .where(eq(decisionSessions.id, sessionId));

    await expect(
      record(
        sessionId,
        decision(sessionId, conflictId, [claimId], "Second ruling")
      )
    ).rejects.toBeInstanceOf(HumanDecisionConflictNotEligibleError);

    await expect(
      database
        .select()
        .from(humanDecisions)
        .where(eq(humanDecisions.sessionId, sessionId))
    ).resolves.toHaveLength(1);
  });

  it("leaves an unrelated claim untouched", async () => {
    const { sessionId, conflictId, claimId } = await seedCheckpoint();
    const untouched = await seedCheckpoint();

    await record(sessionId, decision(sessionId, conflictId, [claimId]));

    await expect(
      database
        .select()
        .from(claims)
        .where(eq(claims.id, untouched.claimId))
    ).resolves.toMatchObject([{ status: "contested" }]);
  });
});
