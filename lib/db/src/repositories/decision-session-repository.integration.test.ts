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
      claimIds: [claimId],
      kind: "calculation",
      title: "Procurement pipeline",
      content: "Derived from the signed pipeline.",
      description: "Calculated from the project input.",
      direction: "supports",
      reliability: 0.8,
      verificationStatus: options.verificationStatus,
      verifiedBy: "evidence-test-operator",
      verifiedAt: timestamp,
      verificationNote: "Seeded by the verification integration test.",
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
    // Which guard the loser hits depends on when it reads the session relative
    // to the winner's commit: the phase may already have moved on, or the
    // conflict may already be resolved. Either way the second decision must be
    // refused for a domain reason rather than silently recorded twice.
    expect(
      rejected.reason instanceof SessionNotInHumanReviewError ||
        rejected.reason instanceof HumanDecisionConflictNotEligibleError
    ).toBe(true);

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

  it("keeps letting the project iterate until the configured round cap", async () => {
    /**
     * 上限从 1 提到可配置，是因为一个项目很少一次评审就能定论：第一轮质询
     * 说"拿不出证据"，补上证据之后理应再被问一遍。这里把上限压到 2，验证
     * 的是"第二轮回得去、第三轮明确拒绝"，而不是只钉住一个数字。
     */
    const previousLimit = process.env.MAX_SUPPLEMENT_ROUNDS;
    process.env.MAX_SUPPLEMENT_ROUNDS = "2";
    try {
      const { sessionId, conflictId, claimId } = await seedCheckpoint();

      const supplement = async (label: string, index: number) => {
        const requestDecision: HumanDecision = {
          ...decision(sessionId, conflictId, [claimId], label),
          action: "request_more_analysis",
          rationale: label
        };
        const result = await repository.recordHumanDecision({
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
        expect(result.session.supplementRound).toBe(index);
        // 一轮跑完回到人工复核，才有下一次裁决可点。
        await database
          .update(decisionSessions)
          .set({ phase: "HUMAN_REVIEW", operationalStatus: "PAUSED" })
          .where(eq(decisionSessions.id, sessionId));
      };

      await supplement("Supplement requested", 1);
      await supplement("Supplement again", 2);

      const thirdDecision: HumanDecision = {
        ...decision(sessionId, conflictId, [claimId], "Supplement once more"),
        action: "request_more_analysis",
        rationale: "Request a third round"
      };

      await expect(
        repository.recordHumanDecision({
          decision: thirdDecision,
          transition: {
            phase: "REASSESSING",
            operationalStatus: "ACTIVE",
            conclusion: thirdDecision.newConclusion
          },
          event: {
            correlationId: thirdDecision.id,
            type: "SESSION_STATE_CHANGED",
            payload: {
              phase: "REASSESSING",
              operationalStatus: "ACTIVE",
              currentConclusion: thirdDecision.newConclusion,
              humanDecision: thirdDecision
            }
          }
        })
      ).rejects.toBeInstanceOf(SupplementRoundLimitError);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.MAX_SUPPLEMENT_ROUNDS;
      } else {
        process.env.MAX_SUPPLEMENT_ROUNDS = previousLimit;
      }
    }
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

describe("DecisionSessionRepository.getView · shared role roster", () => {
  // `agent_roles` is a global template table that every session reads in full,
  // so any writer can add a key outside `AgentRoleKeySchema`. Strict array
  // parsing turned that into a 500 on `GET /api/sessions/:id` for *every*
  // session; the roster has to survive one row it does not understand.
  it("keeps the roles it understands when the roster holds an unknown key", async () => {
    const projectId = newId();
    const sessionId = newId();
    const promptVersionId = newId();
    await database.insert(projects).values({
      id: projectId,
      name: "Demo",
      input: {}
    });
    await repository.create({
      id: sessionId,
      projectId,
      locale: "zh-CN",
      phase: "ANALYSIS",
      operationalStatus: "RUNNING",
      currentConclusion: null
    });
    await database.insert(promptVersions).values({
      id: promptVersionId,
      name: "risk",
      version: `v-${promptVersionId}`,
      content: "prompt"
    });
    await database.insert(agentRoles).values([
      {
        id: newId(),
        key: "risk_auditor",
        name: "Risk auditor",
        goal: "Challenge the assumptions",
        perspective: "Skeptical",
        evaluationCriteria: ["evidence"],
        evidenceRequired: ["source"],
        conflictPreference: ["evidence_gap"],
        lenses: ["risk"],
        promptVersionId
      },
      {
        id: newId(),
        key: `challenger-${newId()}`,
        name: "Leaked fixture",
        goal: "Fixture written by another writer",
        perspective: "None",
        evaluationCriteria: ["evidence"],
        evidenceRequired: ["source"],
        conflictPreference: ["evidence_gap"],
        lenses: ["risk"],
        promptVersionId
      }
    ]);

    const view = await repository.getView(sessionId);

    expect(view?.agents.map((role) => role.key)).toEqual(["risk_auditor"]);
  });
});

describe("DecisionSessionRepository.setResearchQuestion", () => {
  it("rewrites the question and leaves everything else alone", async () => {
    const { sessionId } = await seedCheckpoint();
    const before = await repository.getById(sessionId);

    const updated = await repository.setResearchQuestion(
      sessionId,
      "第四季度出货量是否真实增长？"
    );

    expect(updated).toEqual({
      sessionId,
      researchQuestion: "第四季度出货量是否真实增长？"
    });
    const after = await repository.getById(sessionId);
    // The phase, the status and the conclusion are not this method's business:
    // editing what a research asks must never read as editing what it found.
    expect(after?.phase).toBe(before?.phase);
    expect(after?.operationalStatus).toBe(before?.operationalStatus);
    expect(after?.currentConclusion).toBe(before?.currentConclusion);
  });

  it("returns null for a session that does not exist", async () => {
    await expect(
      repository.setResearchQuestion(newId(), "不存在的研究")
    ).resolves.toBeNull();
  });
});
