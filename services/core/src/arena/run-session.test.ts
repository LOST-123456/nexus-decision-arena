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

    store.beginSupplementRound();
    await Promise.all([service.start(sessionId), service.start(sessionId)]);

    expect(store.claims).toHaveLength(firstRoundClaimCount);
    expect(store.events.filter((event) => event.type === "HUMAN_REVIEW_REQUIRED"))
      .toHaveLength(2);
    await expect(store.getRunContext(sessionId)).resolves.toMatchObject({
      session: { phase: "HUMAN_REVIEW", supplementRound: 1 }
    });
  });
});
