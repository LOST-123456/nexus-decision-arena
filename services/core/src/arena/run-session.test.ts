import { describe, expect, it } from "vitest";
import { AgentRoleSchema, newId, type AgentRole } from "@nexus/shared";
import type { AgentAnalysis } from "./agent-runner";
import { CrossExaminationService } from "./cross-examination";
import { DEFAULT_AGENT_ROLES } from "./default-roles";
import {
  DeterministicAgentRunner,
  loadDeterministicFixtures
} from "./deterministic-agent-runner";
import { MemoryRunSessionStore } from "./memory-run-session-store";
import { RunSessionService } from "./run-session";
import { EventBus } from "../execution/event-bus";

const role = (key: AgentRole["key"]): AgentRole =>
  AgentRoleSchema.parse({
    id: newId(),
    key,
    name: key,
    goal: "Analyze",
    perspective: "Evidence",
    evaluationCriteria: ["evidence"],
    evidenceRequired: ["source"],
    conflictPreference: ["evidence_gap"],
    lenses: [key],
    promptVersionId: newId()
  });

describe("run session service", () => {
  it("continues after failures and emits one AGENT_RUN_FAILED per rejection", async () => {
    const winner = role("market_analyst");
    const firstFailure = role("risk_auditor");
    const secondFailure = role("technical_expert");
    const emitted: string[] = [];

    const service = new RunSessionService({
      run: async (agent): Promise<AgentAnalysis> => {
        if (agent.key !== "market_analyst") {
          throw new Error(`failure:${agent.key}`);
        }
        return { claims: [], evidence: [] };
      }
    });

    const result = await service.runAnalysis(
      [winner, firstFailure, secondFailure],
      { project: "demo" },
      (event) => emitted.push(event.type as string)
    );

    expect(result.analyses).toHaveLength(1);
    expect(result.failures.map((item) => item.role.id)).toEqual([
      firstFailure.id,
      secondFailure.id
    ]);
    expect(emitted.filter((type) => type === "AGENT_RUN_FAILED")).toHaveLength(
      2
    );
  });

  it("runs the deterministic engine through conflict detection and human review", async () => {
    const fixtures = await loadDeterministicFixtures();
    const sessionId = newId();
    const store = new MemoryRunSessionStore(
      {
        id: sessionId,
        phase: "CREATED",
        operationalStatus: "ACTIVE",
        currentConclusion: null,
        supplementRound: 0
      },
      { name: "Fixture project" },
      DEFAULT_AGENT_ROLES
    );
    const runner = new DeterministicAgentRunner(fixtures);
    const eventBus = new EventBus();
    const service = new RunSessionService(runner, {
      store,
      roles: DEFAULT_AGENT_ROLES,
      crossExamination: new CrossExaminationService(
        runner.createChallengeDependencies()
      ),
      createChallengePlans: (roles, claims, runIdByRoleId) =>
        runner.createChallengePlans(roles, claims, runIdByRoleId),
      appendEvent: (input) => store.appendEvent(input),
      eventBus
    });

    await service.start(sessionId);

    expect(store.claims.filter((claim) => claim.stance === "oppose").length)
      .toBeGreaterThanOrEqual(3);
    expect(store.challenges).toHaveLength(5);
    expect(store.conflicts.length).toBeGreaterThanOrEqual(3);
    const reviewConflicts = store.conflicts.filter(
      (conflict) => conflict.humanDecisionRequired
    );
    expect(reviewConflicts.length).toBeGreaterThan(0);
    expect(
      reviewConflicts.every((conflict) => conflict.status === "human_review")
    ).toBe(true);
    expect(store.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "AGENT_RUN_STARTED",
        "AGENT_RUN_COMPLETED",
        "CLAIM_CREATED",
        "CHALLENGE_CREATED",
        "CONFLICT_DETECTED",
        "HUMAN_REVIEW_REQUIRED"
      ])
    );
    await expect(store.getRunContext(sessionId)).resolves.toMatchObject({
      session: { phase: "HUMAN_REVIEW", operationalStatus: "PAUSED" }
    });
  });
  it("executes the single allowed supplement round without re-running agent analysis", async () => {
    class SupplementStore extends MemoryRunSessionStore {
      beginSupplementRound(): void {
        this.session.phase = "REASSESSING";
        this.session.supplementRound = 1;
      }
    }

    const fixtures = await loadDeterministicFixtures();
    const sessionId = newId();
    const store = new SupplementStore(
      {
        id: sessionId,
        phase: "CREATED",
        operationalStatus: "ACTIVE",
        currentConclusion: null,
        supplementRound: 0
      },
      { name: "Fixture project" },
      DEFAULT_AGENT_ROLES
    );
    const runner = new DeterministicAgentRunner(fixtures);
    const service = new RunSessionService(runner, {
      store,
      roles: DEFAULT_AGENT_ROLES,
      crossExamination: new CrossExaminationService(
        runner.createChallengeDependencies()
      ),
      createChallengePlans: (roles, claims, runIdByRoleId) =>
        runner.createChallengePlans(roles, claims, runIdByRoleId),
      appendEvent: (input) => store.appendEvent(input),
      eventBus: new EventBus()
    });

    await service.start(sessionId);
    const firstRoundClaimCount = store.claims.length;
    const agentClaimsBefore = store.claims.filter(
      (claim) => !claim.respondsToChallengeId
    ).length;

    store.beginSupplementRound();
    await Promise.all([service.start(sessionId), service.start(sessionId)]);

    /**
     * "不重跑 agent 分析"说的是**没有新的 agent 产出**，不是"什么新主张都
     * 不该有"。
     *
     * 补充分析要重新交叉质询一遍，质询的应答就是原主张的新版本——那是质询
     * 的产物，理应落库并计入主张数。真正不能发生的是五个角色又跑了一遍。
     *
     * 顺带记一笔：这条断言原来写的是"主张总数不变"，那是因为固定样例的
     * 游标在首轮就用完了，补充轮的质询其实一条都没问出来（应答失败、主张
     * 自然不变）。断言把那个缺陷盖住了，缺陷本身也已经修掉——样例现在按
     * "谁问的、问的是哪条主张"定位，不再靠调用顺序往下取。
     */
    expect(
      store.claims.filter((claim) => !claim.respondsToChallengeId)
    ).toHaveLength(agentClaimsBefore);
    expect(store.claims.length).toBeGreaterThan(firstRoundClaimCount);
    // 补充轮确实重新质询了，而不是空跑一轮。
    expect(store.challenges.length).toBeGreaterThan(5);
    expect(store.events.filter((event) => event.type === "HUMAN_REVIEW_REQUIRED"))
      .toHaveLength(2);
    await expect(store.getRunContext(sessionId)).resolves.toMatchObject({
      session: { phase: "HUMAN_REVIEW", supplementRound: 1 }
    });
  });
});
