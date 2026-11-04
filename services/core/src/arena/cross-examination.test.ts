import { describe, expect, it } from "vitest";
import {
  AgentRoleSchema,
  newId,
  type AgentRole,
  type Challenge,
  type Claim
} from "@nexus/shared";
import { CrossExaminationService } from "./cross-examination";

const role = (key: AgentRole["key"], id = newId()): AgentRole =>
  AgentRoleSchema.parse({
    id,
    key,
    name: key,
    goal: "Review",
    perspective: "Evidence",
    evaluationCriteria: ["evidence"],
    evidenceRequired: ["source"],
    conflictPreference: ["evidence_gap"],
    lenses: [key],
    promptVersionId: newId()
  });

const sessionId = newId();

const claim = (roleId: string, importance = 5): Claim => {
  const id = newId();
  return {
    id,
    sessionId,
    agentRunId: newId(),
    roleId,
    lens: "test",
    statement: "Unsupported target",
    type: "assumption",
    stance: "support",
    importance: importance as Claim["importance"],
    confidence: 0.4,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: id,
    revision: 1,
    relations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
};

const challengeDraft = (target: Claim) => ({
  type: "evidence_gap" as const,
  question: "Where is the procurement evidence?",
  context: {
    triggerClaimIds: [target.id],
    explanation: "The revenue target depends on procurement."
  },
  requiredEvidence: ["Signed procurement pipeline"],
  severity: 5,
  resolutionStrategy: "provide_evidence" as const
});

describe("cross examination service", () => {
  it("creates, answers, resolves, and converts a challenge to conflict", async () => {
    const market = role("market_analyst");
    const finance = role("finance_analyst");
    const target = claim(market.id);
    const emitted: string[] = [];

    const service = new CrossExaminationService({
      generateChallenge: async () => challengeDraft(target),
      respondToChallenge: async (challenge: Challenge) => ({
        ...target,
        id: newId(),
        revision: 2,
        revisionOfClaimId: target.id,
        respondsToChallengeId: challenge.id,
        disposition: "insufficient_evidence",
        updatedAt: new Date().toISOString()
      }),
      evaluateResponse: async () => "unresolved"
    });

    const result = await service.run({
      sessionId,
      claims: [target],
      roles: [market, finance],
      emit: (event) => {
        emitted.push(event.type as string);
      }
    });

    expect(result.challenges[0]?.status).toBe("unresolved");
    expect(result.conflicts).toHaveLength(1);
    expect(emitted).toContain("CHALLENGE_CREATED");
    expect(emitted).toContain("CONFLICT_DETECTED");
  });

  /**
   * 候选来源要落成事件，而不是只活在提示词里。
   *
   * 理由是可追溯：审计包必须能回答"这条质询当时看了哪几条来源"。同时它也
   * 不能混进 Challenge 本体——候选不是质询的一部分，混进去之后"质询长什么样"
   * 就会取决于有没有配置检索服务。
   */
  it("把检索到的候选来源单独落一条事件", async () => {
    const market = role("market_analyst");
    const finance = role("finance_analyst");
    const target = claim(market.id);
    const emitted: { type: string; payload: unknown }[] = [];

    const service = new CrossExaminationService({
      generateChallenge: async () => ({
        ...challengeDraft(target),
        webQuery: "采购管道",
        webSources: [
          {
            title: "某高校采购公告",
            url: "https://example.edu/p/1",
            snippet: "预算 120 万元"
          }
        ]
      }),
      respondToChallenge: async (challenge: Challenge) => ({
        ...target,
        id: newId(),
        revision: 2,
        revisionOfClaimId: target.id,
        respondsToChallengeId: challenge.id,
        disposition: "insufficient_evidence",
        updatedAt: new Date().toISOString()
      }),
      evaluateResponse: async () => "unresolved"
    });

    const result = await service.run({
      sessionId,
      claims: [target],
      roles: [market, finance],
      emit: (event) => {
        emitted.push({ type: event.type as string, payload: event.payload });
      }
    });

    const event = emitted.find((item) => item.type === "WEB_SOURCES_FOUND");
    expect(event).toBeTruthy();
    const payload = event!.payload as {
      challengeId: string;
      query: string;
      sources: { url: string }[];
    };
    expect(payload.challengeId).toBe(result.challenges[0]?.id);
    expect(payload.sources[0]?.url).toBe("https://example.edu/p/1");
    // 候选来源不进 Challenge 本体。
    expect(
      (result.challenges[0] as unknown as Record<string, unknown>).webSources
    ).toBeUndefined();
  });

  it("isolates a failed challenge and protects the original claim from mutation", async () => {
    const market = role("market_analyst");
    const finance = role("finance_analyst");
    const risk = role("risk_auditor");
    const target = claim(market.id);
    const original = structuredClone(target);
    const emitted: string[] = [];

    const service = new CrossExaminationService({
      generateChallenge: async (challenger, challengedClaim) => {
        if (challenger.id === finance.id) {
          throw new Error("challenge generation failed");
        }
        challengedClaim.statement = "mutated by dependency";
        return challengeDraft(target);
      },
      respondToChallenge: async (challenge: Challenge, challengedClaim) => ({
        ...challengedClaim,
        id: newId(),
        revision: target.revision + 1,
        revisionOfClaimId: target.id,
        respondsToChallengeId: challenge.id,
        disposition: "insufficient_evidence",
        updatedAt: new Date().toISOString()
      }),
      evaluateResponse: async () => "resolved"
    });

    const result = await service.run({
      sessionId,
      claims: [target],
      roles: [market, finance, risk],
      emit: (event) => {
        emitted.push(event.type as string);
      }
    });

    expect(target).toEqual(original);
    expect(result.challenges).toHaveLength(1);
    expect(result.challenges[0]?.challengerRoleId).toBe(risk.id);
    expect(result.responseClaims).toHaveLength(1);
    expect(result.responseClaims[0]).toMatchObject({
      id: expect.any(String),
      revision: target.revision + 1,
      revisionOfClaimId: target.id,
      respondsToChallengeId: result.challenges[0]?.id
    });
    expect(emitted.filter((type) => type === "CHALLENGE_FAILED")).toHaveLength(
      1
    );
  });

  it("rejects a response that reuses the original claim revision", async () => {
    const market = role("market_analyst");
    const finance = role("finance_analyst");
    const target = claim(market.id);
    const emitted: string[] = [];

    const service = new CrossExaminationService({
      generateChallenge: async () => challengeDraft(target),
      respondToChallenge: async () => target,
      evaluateResponse: async () => "resolved"
    });

    const result = await service.run({
      sessionId,
      claims: [target],
      roles: [market, finance],
      emit: (event) => {
        emitted.push(event.type as string);
      }
    });

    expect(result.responseClaims).toHaveLength(0);
    expect(result.challenges[0]?.status).toBe("open");
    expect(emitted).toContain("CHALLENGE_FAILED");
  });

  it("keeps the created challenge event payload stable after evaluation", async () => {
    const market = role("market_analyst");
    const finance = role("finance_analyst");
    const target = claim(market.id);
    let createdPayload: Challenge | undefined;

    const service = new CrossExaminationService({
      generateChallenge: async () => challengeDraft(target),
      respondToChallenge: async (challenge: Challenge) => ({
        ...target,
        id: newId(),
        revision: target.revision + 1,
        revisionOfClaimId: target.id,
        respondsToChallengeId: challenge.id,
        disposition: "insufficient_evidence",
        updatedAt: new Date().toISOString()
      }),
      evaluateResponse: async () => "unresolved"
    });

    const result = await service.run({
      sessionId,
      claims: [target],
      roles: [market, finance],
      emit: (event) => {
        if (event.type === "CHALLENGE_CREATED") {
          createdPayload = event.payload as Challenge;
        }
      }
    });

    expect(result.challenges[0]?.status).toBe("unresolved");
    expect(createdPayload?.status).toBe("open");
    expect(createdPayload?.updatedAt).toBe(createdPayload?.createdAt);
  });

  /**
   * 质询是整轮里唯一按条数线性增长的环节。
   *
   * 每条质询要三次模型调用，十条串行就是三十次串行请求——实测整轮 33 秒里
   * 全花在这里。各条质询彼此独立，所以必须并发；但结果顺序要按输入排，
   * "谁先跑完谁排前面"会让报告每次读到的质询顺序都不一样。
   */
  it("runs the challenges concurrently but keeps their order", async () => {
    const market = role("market_analyst");
    const finance = role("finance_analyst");
    const technical = role("technical_expert");
    const targets = [claim(market.id, 9), claim(market.id, 8), claim(market.id, 7)];
    let active = 0;
    let peak = 0;
    const emitted: { type: string; payload: unknown }[] = [];

    const service = new CrossExaminationService({
      generateChallenge: async (_challenger, target) => {
        active += 1;
        peak = Math.max(peak, active);
        // 故意让每条耗时一样长：串行时 peak 只会是 1。
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return challengeDraft(target);
      },
      respondToChallenge: async (challenge: Challenge, target) => ({
        ...target,
        id: newId(),
        revision: target.revision + 1,
        revisionOfClaimId: target.id,
        respondsToChallengeId: challenge.id,
        disposition: "insufficient_evidence",
        updatedAt: new Date().toISOString()
      }),
      evaluateResponse: async () => "unresolved"
    });

    const result = await service.run({
      sessionId,
      claims: targets,
      roles: [market, finance, technical],
      emit: (event) => {
        emitted.push({ type: event.type, payload: event.payload });
      }
    });

    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
    // 三条主张，每条两个质询者（不能派回自己的角色）。
    expect(result.challenges).toHaveLength(6);
    expect(result.challenges.map((item) => item.targetClaimId)).toEqual([
      targets[0]!.id,
      targets[0]!.id,
      targets[1]!.id,
      targets[1]!.id,
      targets[2]!.id,
      targets[2]!.id
    ]);

    // 本轮总数要先说出去，页面才知道进度是几分之几。
    const batch = emitted.find((event) => event.type === "CHALLENGE_BATCH_STARTED");
    expect(batch?.payload).toEqual({ total: 6 });
  });
});
