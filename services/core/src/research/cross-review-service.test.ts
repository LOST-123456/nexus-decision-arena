import { describe, expect, it, vi } from "vitest";
import {
  ClaimSchema,
  ChallengeSchema,
  newId,
  type AgentRole,
  type Challenge,
  type Claim,
  type Conflict,
  type Evidence,
  type ExecutionEvent
} from "@nexus/shared";
import { DEFAULT_AGENT_ROLES } from "../arena/default-roles";
import {
  CrossExaminationService,
  type CrossExaminationResult
} from "../arena/cross-examination";
import { EventBus } from "../execution/event-bus";
import {
  CrossReviewClaimNotFoundError,
  CrossReviewInProgressError,
  CrossReviewNoChallengerError,
  CrossReviewService
} from "./cross-review-service";

const SESSION_ID = newId();
const CLAIM_ID = newId();

function claimFixture(overrides: Partial<Claim> = {}): Claim {
  const now = new Date().toISOString();
  return ClaimSchema.parse({
    id: CLAIM_ID,
    sessionId: SESSION_ID,
    lens: "research",
    statement: "Shipments grew 12% last quarter.",
    type: "fact",
    stance: "support",
    importance: 4,
    confidence: 0.5,
    evidenceIds: [],
    status: "proposed",
    rootClaimId: CLAIM_ID,
    revision: 1,
    relations: [],
    createdAt: now,
    updatedAt: now,
    ...overrides
  });
}

type Harness = ReturnType<typeof harness>;

function harness(options: {
  claims?: Claim[];
  roles?: readonly AgentRole[];
  generateChallenge?: (...args: never[]) => Promise<unknown>;
  evaluateStatus?: "resolved" | "unresolved";
  runningRun?: { id: string } | null;
  crossExaminationOverride?: {
    run: (input: unknown) => Promise<CrossExaminationResult>;
  };
} = {}) {
  const startedRuns: Array<Record<string, unknown>> = [];
  const runStatus = new Map<string, string>();
  const completedRuns: Array<{ runId: string; output: unknown }> = [];
  const failedRuns: Array<{ runId: string; error: string }> = [];
  const savedChallenges: Challenge[] = [];
  const savedClaims: Claim[] = [];
  const savedConflicts: Conflict[] = [];
  const events: Array<{ type: string; payload: unknown }> = [];

  let claims = options.claims ?? [claimFixture()];
  const roles = options.roles ?? DEFAULT_AGENT_ROLES;

  const defaultDraft = async () => ({
    type: "evidence_gap" as const,
    question: "Where is the procurement record?",
    context: {
      triggerClaimIds: [CLAIM_ID],
      explanation: "The claim drives the conclusion."
    },
    requiredEvidence: ["采购记录"],
    severity: 5,
    resolutionStrategy: "provide_evidence" as const
  });

  const crossExamination =
    options.crossExaminationOverride ??
    new CrossExaminationService({
      generateChallenge: (options.generateChallenge ?? defaultDraft) as never,
      respondToChallenge: async (challenge, target) => {
        const now = new Date().toISOString();
        return ClaimSchema.parse({
          ...target,
          id: newId(),
          revision: target.revision + 1,
          revisionOfClaimId: target.id,
          respondsToChallengeId: challenge.id,
          disposition: "insufficient_evidence",
          status: "contested",
          evidenceIds: [],
          createdAt: now,
          updatedAt: now
        });
      },
      evaluateResponse: async () => options.evaluateStatus ?? "unresolved"
    });

  const appendEvent = async (input: {
    sessionId: string;
    correlationId: string;
    type: ExecutionEvent["type"];
    payload: unknown;
  }): Promise<ExecutionEvent> => {
    events.push({ type: input.type, payload: input.payload });
    return {
      id: newId(),
      sessionId: input.sessionId,
      sequence: events.length,
      correlationId: input.correlationId,
      type: input.type,
      payload: input.payload,
      occurredAt: new Date().toISOString()
    };
  };

  const service = new CrossReviewService({
    readArtifacts: async () => ({
      claims,
      evidence: [] as Evidence[],
      challenges: savedChallenges,
      conflicts: savedConflicts
    }),
    readRoles: async () => [...roles],
    runs: {
      findRunningCrossReview: async () =>
        options.runningRun
          ? {
              id: options.runningRun.id,
              sessionId: SESSION_ID,
              roleId: newId(),
              promptVersionId: newId(),
              status: "running" as const,
              purpose: "cross_review" as const,
              targetClaimId: CLAIM_ID,
              startedAt: new Date().toISOString()
            }
          : null,
      startCrossReviewRun: async (input) => {
        startedRuns.push({ ...input });
        runStatus.set(input.id, "running");
        return {
          id: input.id,
          sessionId: input.sessionId,
          roleId: input.roleId,
          promptVersionId: input.promptVersionId,
          status: "running" as const,
          purpose: "cross_review" as const,
          targetClaimId: input.targetClaimId,
          startedAt: new Date().toISOString()
        };
      },
      completeCrossReviewRun: async (input) => {
        runStatus.set(input.runId, "completed");
        completedRuns.push(input);
      },
      failCrossReviewRun: async (input) => {
        runStatus.set(input.runId, "failed");
        failedRuns.push(input);
      }
    },
    arena: {
      saveChallenge: async (challenge) => {
        savedChallenges.push(challenge);
        await Promise.resolve();
      },
      updateChallenge: async (challenge) => {
        const index = savedChallenges.findIndex((item) => item.id === challenge.id);
        if (index >= 0) savedChallenges[index] = challenge;
      },
      saveClaim: async (claim) => {
        savedClaims.push(claim);
        claims = [...claims, claim];
      },
      saveConflict: async (conflict) => {
        savedConflicts.push(conflict);
      }
    },
    getClaimValidationContext: async (claimId) => {
      const claim = claims.find((item) => item.id === claimId);
      return claim ? { claim, evidence: [], challenges: savedChallenges } : null;
    },
    crossExamination: () => crossExamination,
    appendEvent,
    eventBus: new EventBus()
  });

  return {
    service,
    startedRuns,
    runStatus,
    completedRuns,
    failedRuns,
    savedChallenges,
    savedClaims,
    savedConflicts,
    events
  };
}

describe("CrossReviewService · real work, real records", () => {
  it("creates an agent run before any challenge exists", async () => {
    const h = harness();
    const result = await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });

    expect(h.startedRuns.length).toBeGreaterThan(0);
    expect(h.startedRuns[0]?.targetClaimId).toBe(CLAIM_ID);
    expect(h.startedRuns[0]?.requestedBy).toBe("Owner (owner)");

    // The start event is emitted before the challenge it produces.
    const types = h.events.map((event) => event.type);
    expect(types.indexOf("AGENT_RUN_STARTED")).toBeLessThan(
      types.indexOf("CHALLENGE_CREATED")
    );
    expect(result.runs.every((entry) => entry.status === "completed")).toBe(true);
  });

  it("does not let a claim be challenged by its own author role", async () => {
    const author = DEFAULT_AGENT_ROLES[0]!;
    const h = harness({ claims: [claimFixture({ roleId: author.id })] });
    await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });

    const usedRoles = h.startedRuns.map((run) => run.roleId);
    expect(usedRoles).not.toContain(author.id);
  });

  it("records the challenge and closes the run with its output", async () => {
    const h = harness();
    const result = await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });

    expect(result.status).toBe("completed");
    expect(h.savedChallenges).toHaveLength(h.startedRuns.length);
    expect(h.failedRuns).toHaveLength(0);
    expect(h.completedRuns).toHaveLength(h.startedRuns.length);

    const output = h.completedRuns[0]?.output as {
      challenges: Array<{ question: string; severity: number }>;
    };
    expect(output.challenges[0]?.question).toBe(
      "Where is the procurement record?"
    );
    expect(output.challenges[0]?.severity).toBe(5);

    // The challenge status after evaluation is what lands in the run output.
    expect(h.savedChallenges[0]?.status).toBe("unresolved");
  });

  it("marks the run failed with the challenger's own reason", async () => {
    const h = harness({
      generateChallenge: async () => {
        throw new Error("Provider returned malformed JSON");
      }
    });
    const result = await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });

    expect(result.status).toBe("failed");
    expect(result.failures).toHaveLength(h.startedRuns.length);
    expect(result.failures[0]?.reason).toContain("Provider returned malformed JSON");
    expect(h.failedRuns[0]?.error).toContain("Provider returned malformed JSON");
    expect(h.completedRuns).toHaveLength(0);
    expect(h.events.some((event) => event.type === "AGENT_RUN_FAILED")).toBe(true);
    // A failed examination never returns challenges it did not produce.
    expect(result.challenges).toHaveLength(0);
  });

  it("is never a success when the runner silently produces nothing", async () => {
    const silent = {
      run: vi.fn().mockResolvedValue({
        challenges: [],
        responseClaims: [],
        conflicts: []
      })
    };
    const h = harness({ crossExaminationOverride: silent });
    const result = await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });

    expect(result.status).toBe("failed");
    expect(h.completedRuns).toHaveLength(0);
    expect(h.failedRuns).toHaveLength(h.startedRuns.length);
    expect(result.failures[0]?.reason).toContain("without producing a challenge");
  });

  it("produces a partial result when only some challengers come back", async () => {
    let attempt = 0;
    const h = harness({
      generateChallenge: (async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("Transient provider error");
        }
        return {
          type: "evidence_gap",
          question: "Second attempt challenge",
          context: {
            triggerClaimIds: [CLAIM_ID],
            explanation: "Retry succeeded."
          },
          requiredEvidence: ["采购记录"],
          severity: 4,
          resolutionStrategy: "provide_evidence"
        };
      }) as never
    });

    const first = await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });

    // One challenger failed, one succeeded: that is a partial result, and it
    // says so instead of reporting success.
    expect(first.runs.length).toBeGreaterThan(1);
    expect(first.status).toBe("partial");
    expect(first.failures).toHaveLength(1);
    expect(first.failures[0]?.reason).toContain("Transient provider error");
    expect(first.challenges).toHaveLength(1);
  });

  it("can be re-run after a failure and then fully succeeds", async () => {
    let attempt = 0;
    const h = harness({
      generateChallenge: (async () => {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("Transient provider error");
        }
        return {
          type: "evidence_gap",
          question: `Challenge attempt ${attempt}`,
          context: {
            triggerClaimIds: [CLAIM_ID],
            explanation: "Retry succeeded."
          },
          requiredEvidence: ["采购记录"],
          severity: 4,
          resolutionStrategy: "provide_evidence"
        };
      }) as never
    });

    const first = await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });
    const runsAfterFirst = h.startedRuns.length;

    const second = await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });

    expect(first.status).toBe("partial");
    expect(second.status).toBe("completed");
    expect(second.failures).toHaveLength(0);
    // The retry is a fresh set of runs, not a reuse of the failed ones.
    expect(h.startedRuns.length).toBe(runsAfterFirst + second.runs.length);
  });

  it("refuses a second examination while one is still running", async () => {
    const h = harness({ runningRun: { id: newId() } });
    await expect(
      h.service.runForClaim({
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        actor: "Owner (owner)"
      })
    ).rejects.toBeInstanceOf(CrossReviewInProgressError);
    expect(h.startedRuns).toHaveLength(0);
  });

  it("refuses when no role can act as challenger", async () => {
    const author = DEFAULT_AGENT_ROLES[0]!;
    const h = harness({
      claims: [claimFixture({ roleId: author.id })],
      roles: [author]
    });
    await expect(
      h.service.runForClaim({
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        actor: "Owner (owner)"
      })
    ).rejects.toBeInstanceOf(CrossReviewNoChallengerError);
  });

  it("refuses a claim that is not in the session", async () => {
    const h = harness({ claims: [claimFixture({ id: newId() })] });
    await expect(
      h.service.runForClaim({
        sessionId: SESSION_ID,
        claimId: CLAIM_ID,
        actor: "Owner (owner)"
      })
    ).rejects.toBeInstanceOf(CrossReviewClaimNotFoundError);
  });

  it("persists the response claim it caused, not unrelated claims", async () => {
    const h = harness();
    const result = await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });

    expect(h.savedClaims.length).toBeGreaterThan(0);
    expect(result.responseClaims.length).toBe(h.savedClaims.length);
    expect(
      result.responseClaims.every((claim) => claim.revisionOfClaimId === CLAIM_ID)
    ).toBe(true);
  });

  it("keeps challenges tied to the examined claim", async () => {
    const h = harness();
    const result = await h.service.runForClaim({
      sessionId: SESSION_ID,
      claimId: CLAIM_ID,
      actor: "Owner (owner)"
    });

    expect(result.challenges.every((item) => item.targetClaimId === CLAIM_ID)).toBe(
      true
    );
    expect(
      result.runs.every((entry) =>
        entry.challenges.every((item) => item.challengerRunId === entry.run.id)
      )
    ).toBe(true);
  });
});
