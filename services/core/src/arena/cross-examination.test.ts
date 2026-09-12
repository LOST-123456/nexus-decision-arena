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
});
