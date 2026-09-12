import {
  assertClaimInvariants,
  newId,
  type AgentRole,
  type Challenge,
  type Claim,
  type Conflict,
  type Evidence,
  type ExecutionEvent
} from "@nexus/shared";
import type { AgentAnalysis, AgentRunner } from "./agent-runner";
import {
  CrossExaminationService,
  type CrossExaminationPlan
} from "./cross-examination";
import type { EventBus } from "../execution/event-bus";

export type RunSessionEmit = (
  event: Partial<ExecutionEvent> & { type: ExecutionEvent["type"] }
) => void;

export type SessionArtifacts = {
  claims: Claim[];
  evidence: Evidence[];
  challenges: Challenge[];
  conflicts: Conflict[];
};

export type RunAnalysisResult = {
  analyses: AgentAnalysis[];
  failures: Array<{ role: AgentRole; reason: unknown }>;
  completed: Array<{ role: AgentRole; analysis: AgentAnalysis }>;
};

export type RunSessionStore = {
  getRunContext(sessionId: string): Promise<{
    session: {
      id: string;
      phase: string;
      operationalStatus: string;
      currentConclusion: string | null;
      supplementRound: number;
    };
    projectInput: unknown;
    roles: AgentRole[];
  } | null>;
  ensureAgentRoles(roles: readonly AgentRole[]): Promise<AgentRole[]>;
  setSessionState(input: {
    sessionId: string;
    phase: string;
    operationalStatus: string;
    currentConclusion: string | null;
  }): Promise<void>;
  startAgentRun(input: {
    id: string;
    sessionId: string;
    roleId: string;
    promptVersionId: string;
    status: string;
    correlationId?: string;
    input?: unknown;
    startedAt?: string;
  }): Promise<void>;
  saveClaimsAndEvidence(input: {
    runId: string;
    output: unknown;
    claims: Claim[];
    evidence: Evidence[];
  }): Promise<void>;
  failAgentRun(input: { runId: string; error: string }): Promise<void>;
  saveClaim(claim: Claim): Promise<void>;
  saveChallenge(challenge: Challenge): Promise<void>;
  updateChallenge(challenge: Challenge): Promise<void>;
  saveConflict(conflict: Conflict): Promise<void>;
  getSessionArtifacts(sessionId: string): Promise<SessionArtifacts | null>;
  getClaimValidationContext(claimId: string): Promise<{
    claim: Claim;
    evidence: Evidence[];
    challenges: Challenge[];
  } | null>;
};

export type RunSessionRuntime = {
  store: RunSessionStore;
  roles: readonly AgentRole[];
  crossExamination:
    | CrossExaminationService
    | (() => CrossExaminationService);
  createChallengePlans?: (
    roles: AgentRole[],
    claims: Claim[],
    runIdByRoleId: ReadonlyMap<string, string>
  ) => CrossExaminationPlan[];
  appendEvent(input: {
    sessionId: string;
    correlationId: string;
    type: ExecutionEvent["type"];
    payload: unknown;
    traceId?: string;
    promptVersionId?: string;
  }): Promise<ExecutionEvent>;
  eventBus: EventBus;
  initialConclusion?: string;
  postChallengeConclusion?: string;
};

export class SessionAlreadyStartedError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} has already started`);
    this.name = "SessionAlreadyStartedError";
  }
}

export class RunSessionService {
  constructor(
    private readonly agentRunner: AgentRunner,
    private readonly runtime?: RunSessionRuntime
  ) {}

  async runAnalysis(
    roles: AgentRole[],
    projectInput: unknown,
    emit: RunSessionEmit
  ): Promise<RunAnalysisResult> {
    const settled = await Promise.allSettled(
      roles.map((role) => this.agentRunner.run(role, projectInput))
    );

    const analyses: AgentAnalysis[] = [];
    const failures: Array<{ role: AgentRole; reason: unknown }> = [];
    const completed: Array<{ role: AgentRole; analysis: AgentAnalysis }> = [];

    settled.forEach((result, index) => {
      const role = roles[index];
      if (!role) {
        return;
      }

      if (result.status === "fulfilled") {
        analyses.push(result.value);
        completed.push({ role, analysis: result.value });
        return;
      }

      failures.push({ role, reason: result.reason });
      emit({
        type: "AGENT_RUN_FAILED",
        payload: {
          roleId: role.id,
          message:
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown agent failure"
        },
        correlationId: newId()
      });
    });

    return { analyses, failures, completed };
  }

  async start(sessionId: string): Promise<void> {
    if (!this.runtime) {
      throw new Error(
        `RunSessionService.start(${sessionId}) requires a durable runtime`
      );
    }

    const context = await this.runtime.store.getRunContext(sessionId);
    if (!context) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const isSupplementRound =
      context.session.phase === "REASSESSING" &&
      context.session.supplementRound >= 1;
    if (context.session.phase !== "CREATED" && !isSupplementRound) {
      throw new SessionAlreadyStartedError(sessionId);
    }

    const roles = await this.runtime.store.ensureAgentRoles(
      this.runtime.roles.length > 0 ? this.runtime.roles : context.roles
    );
    if (roles.length === 0) {
      throw new Error("No agent roles are configured");
    }

    const initialConclusion =
      this.runtime.initialConclusion ?? "建议立项";
    const postChallengeConclusion =
      this.runtime.postChallengeConclusion ?? "暂缓规模化扩张";
    const emitEvent = async (input: {
      correlationId: string;
      type: ExecutionEvent["type"];
      payload: unknown;
      traceId?: string;
      promptVersionId?: string;
    }): Promise<ExecutionEvent> =>
      this.runtime!.eventBus.publishAfterCommit({
        append: () =>
          this.runtime!.appendEvent({
            sessionId,
            correlationId: input.correlationId,
            type: input.type,
            payload: input.payload,
            ...(input.traceId ? { traceId: input.traceId } : {}),
            ...(input.promptVersionId
              ? { promptVersionId: input.promptVersionId }
              : {})
          })
      });

    if (isSupplementRound) {
      const artifacts =
        await this.runtime.store.getSessionArtifacts(sessionId);
      if (!artifacts || artifacts.claims.length === 0) {
        throw new Error(
          `Supplement round for ${sessionId} has no existing Claims`
        );
      }

      await this.runtime.store.setSessionState({
        sessionId,
        phase: "CHALLENGING",
        operationalStatus: "ACTIVE",
        currentConclusion: context.session.currentConclusion
      });
      await emitEvent({
        correlationId: newId(),
        type: "SESSION_STATE_CHANGED",
        payload: {
          phase: "CHALLENGING",
          operationalStatus: "ACTIVE",
          currentConclusion: context.session.currentConclusion
        }
      });

      const crossExaminationService =
        typeof this.runtime.crossExamination === "function"
          ? this.runtime.crossExamination()
          : this.runtime.crossExamination;
      const runIdByRoleId = new Map(
        artifacts.claims.map((claim) => [claim.roleId, claim.agentRunId])
      );
      const plans = this.runtime.createChallengePlans?.(
        roles,
        artifacts.claims,
        runIdByRoleId
      );
      const supplement = await crossExaminationService.run({
        sessionId,
        claims: artifacts.claims,
        roles,
        ...(plans ? { plans } : {}),
        persistChallenge: async (challenge) => {
          await this.runtime!.store.saveChallenge(challenge);
        },
        persistResponseClaim: async (claim) => {
          await this.runtime!.store.saveClaim(claim);
        },
        persistChallengeUpdate: (challenge) =>
          this.runtime!.store.updateChallenge(challenge),
        persistConflict: (conflict) =>
          this.runtime!.store.saveConflict(conflict),
        emit: async (event) => {
          await emitEvent({
            correlationId: event.correlationId ?? newId(),
            type: event.type,
            payload: event.payload
          });
        }
      });

      const existingUnresolved = artifacts.conflicts.some(
        (conflict) =>
          conflict.humanDecisionRequired && conflict.status !== "resolved"
      );
      const humanReviewRequired =
        existingUnresolved ||
        supplement.conflicts.some(
          (conflict) => conflict.humanDecisionRequired
        );

      if (humanReviewRequired) {
        await this.runtime.store.setSessionState({
          sessionId,
          phase: "CONFLICT_DETECTED",
          operationalStatus: "ACTIVE",
          currentConclusion: context.session.currentConclusion
        });
        await emitEvent({
          correlationId: newId(),
          type: "SESSION_STATE_CHANGED",
          payload: {
            phase: "CONFLICT_DETECTED",
            operationalStatus: "ACTIVE",
            currentConclusion: context.session.currentConclusion
          }
        });
        await this.runtime.store.setSessionState({
          sessionId,
          phase: "HUMAN_REVIEW",
          operationalStatus: "PAUSED",
          currentConclusion: context.session.currentConclusion
        });
        await emitEvent({
          correlationId: newId(),
          type: "HUMAN_REVIEW_REQUIRED",
          payload: {
            reason: "Supplement round still requires human review",
            conflictIds: supplement.conflicts.map((conflict) => conflict.id)
          }
        });
        return;
      }

      await this.runtime.store.setSessionState({
        sessionId,
        phase: "DECIDED",
        operationalStatus: "COMPLETED",
        currentConclusion: context.session.currentConclusion
      });
      await emitEvent({
        correlationId: newId(),
        type: "SESSION_COMPLETED",
        payload: {
          phase: "DECIDED",
          operationalStatus: "COMPLETED",
          currentConclusion: context.session.currentConclusion
        }
      });
      return;
    }

    await this.runtime.store.setSessionState({
      sessionId,
      phase: "PLANNING",
      operationalStatus: "ACTIVE",
      currentConclusion: initialConclusion
    });
    await emitEvent({
      correlationId: newId(),
      type: "SESSION_STATE_CHANGED",
      payload: {
        phase: "PLANNING",
        operationalStatus: "ACTIVE",
        currentConclusion: initialConclusion
      }
    });

    await this.runtime.store.setSessionState({
      sessionId,
      phase: "ANALYZING",
      operationalStatus: "ACTIVE",
      currentConclusion: initialConclusion
    });
    await emitEvent({
      correlationId: newId(),
      type: "SESSION_STATE_CHANGED",
      payload: {
        phase: "ANALYZING",
        operationalStatus: "ACTIVE",
        currentConclusion: initialConclusion
      }
    });

    const prepared = roles.map((role) => ({
      role,
      runId: newId(),
      correlationId: newId()
    }));
    await Promise.all(
      prepared.map((entry) =>
        this.runtime!.store.startAgentRun({
          id: entry.runId,
          sessionId,
          roleId: entry.role.id,
          promptVersionId: entry.role.promptVersionId,
          status: "running",
          correlationId: entry.correlationId,
          input: context.projectInput,
          startedAt: new Date().toISOString()
        })
      )
    );
    await Promise.all(
      prepared.map((entry) =>
        emitEvent({
          correlationId: entry.correlationId,
          type: "AGENT_RUN_STARTED",
          payload: {
            roleId: entry.role.id,
            agentRunId: entry.runId
          },
          promptVersionId: entry.role.promptVersionId
        })
      )
    );

    const settled = await Promise.allSettled(
      prepared.map((entry) =>
        this.agentRunner.run(entry.role, {
          sessionId,
          agentRunId: entry.runId,
          projectInput: context.projectInput
        })
      )
    );

    const allClaims: Claim[] = [];
    const runIdByRoleId = new Map<string, string>();

    for (const [index, result] of settled.entries()) {
      const entry = prepared[index];
      if (!entry) {
        continue;
      }
      runIdByRoleId.set(entry.role.id, entry.runId);

      if (result.status === "rejected") {
        const message =
          result.reason instanceof Error
            ? result.reason.message
            : "Unknown agent failure";
        await this.runtime.store.failAgentRun({
          runId: entry.runId,
          error: message
        });
        await emitEvent({
          correlationId: entry.correlationId,
          type: "AGENT_RUN_FAILED",
          payload: {
            roleId: entry.role.id,
            agentRunId: entry.runId,
            message
          },
          promptVersionId: entry.role.promptVersionId
        });
        continue;
      }

      const analysis = result.value;
      for (const claim of analysis.claims) {
        assertClaimInvariants(
          claim,
          analysis.evidence.filter((item) => item.claimId === claim.id)
        );
      }
      await this.runtime.store.saveClaimsAndEvidence({
        runId: entry.runId,
        output: analysis,
        claims: analysis.claims,
        evidence: analysis.evidence
      });
      allClaims.push(...analysis.claims);

      for (const claim of analysis.claims) {
        await emitEvent({
          correlationId: newId(),
          type: "CLAIM_CREATED",
          payload: claim,
          promptVersionId: entry.role.promptVersionId
        });
      }
      await emitEvent({
        correlationId: entry.correlationId,
        type: "AGENT_RUN_COMPLETED",
        payload: {
          roleId: entry.role.id,
          agentRunId: entry.runId,
          claimCount: analysis.claims.length,
          evidenceCount: analysis.evidence.length
        },
        promptVersionId: entry.role.promptVersionId
      });
    }

    await this.runtime.store.setSessionState({
      sessionId,
      phase: "CHALLENGING",
      operationalStatus: "ACTIVE",
      currentConclusion: initialConclusion
    });
    await emitEvent({
      correlationId: newId(),
      type: "SESSION_STATE_CHANGED",
      payload: {
        phase: "CHALLENGING",
        operationalStatus: "ACTIVE",
        currentConclusion: initialConclusion
      }
    });

    const plans = this.runtime.createChallengePlans?.(
      roles,
      allClaims,
      runIdByRoleId
    );
    const crossExaminationService =
      typeof this.runtime.crossExamination === "function"
        ? this.runtime.crossExamination()
        : this.runtime.crossExamination;
    const crossExamination = await crossExaminationService.run({
      sessionId,
      claims: allClaims,
      roles,
      ...(plans ? { plans } : {}),
      persistChallenge: async (challenge) => {
        const target = await this.runtime!.store.getClaimValidationContext(
          challenge.targetClaimId
        );
        if (target) {
          assertClaimInvariants(target.claim, target.evidence, [
            ...target.challenges,
            challenge
          ]);
        }
        await this.runtime!.store.saveChallenge(challenge);
      },
      persistResponseClaim: async (claim) => {
        const contextForResponse =
          await this.runtime!.store.getClaimValidationContext(
            claim.revisionOfClaimId ?? claim.id
          );
        assertClaimInvariants(
          claim,
          contextForResponse?.evidence ?? []
        );
        await this.runtime!.store.saveClaim(claim);
      },
      persistChallengeUpdate: (challenge) =>
        this.runtime!.store.updateChallenge(challenge),
      persistConflict: (conflict) =>
        this.runtime!.store.saveConflict(conflict),
      emit: async (event) => {
        await emitEvent({
          correlationId: event.correlationId ?? newId(),
          type: event.type,
          payload: event.payload
        });
      }
    });

    const humanReviewRequired = crossExamination.conflicts.some(
      (conflict) => conflict.humanDecisionRequired
    );
    if (humanReviewRequired) {
      await this.runtime.store.setSessionState({
        sessionId,
        phase: "CONFLICT_DETECTED",
        operationalStatus: "ACTIVE",
        currentConclusion: postChallengeConclusion
      });
      await emitEvent({
        correlationId: newId(),
        type: "SESSION_STATE_CHANGED",
        payload: {
          phase: "CONFLICT_DETECTED",
          operationalStatus: "ACTIVE",
          currentConclusion: postChallengeConclusion
        }
      });
      await this.runtime.store.setSessionState({
        sessionId,
        phase: "HUMAN_REVIEW",
        operationalStatus: "PAUSED",
        currentConclusion: postChallengeConclusion
      });
      await emitEvent({
        correlationId: newId(),
        type: "HUMAN_REVIEW_REQUIRED",
        payload: {
          reason: "High-severity conflict requires a human decision",
          conflictIds: crossExamination.conflicts.map(
            (conflict) => conflict.id
          )
        }
      });
      return;
    }

    await this.runtime.store.setSessionState({
      sessionId,
      phase: "DECIDED",
      operationalStatus: "COMPLETED",
      currentConclusion: postChallengeConclusion
    });
    await emitEvent({
      correlationId: newId(),
      type: "SESSION_COMPLETED",
      payload: {
        phase: "DECIDED",
        operationalStatus: "COMPLETED",
        currentConclusion: postChallengeConclusion
      }
    });
  }
}
