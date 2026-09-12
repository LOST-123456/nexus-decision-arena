import {
  newId,
  type AgentRole,
  type Challenge,
  type Claim,
  type Conflict,
  type Evidence,
  type ExecutionEvent
} from "@nexus/shared";
import type { RunSessionStore } from "./run-session";

export class MemoryRunSessionStore implements RunSessionStore {
  readonly events: ExecutionEvent[] = [];
  readonly claims: Claim[] = [];
  readonly evidence: Evidence[] = [];
  readonly challenges: Challenge[] = [];
  readonly conflicts: Conflict[] = [];
  readonly agentRuns = new Map<string, Record<string, unknown>>();
  private supplementLock: Promise<void> = Promise.resolve();

  constructor(
    protected readonly session: {
      id: string;
      phase: string;
      operationalStatus: string;
      currentConclusion: string | null;
      supplementRound: number;
    },
    private readonly projectInput: unknown,
    private readonly roles: AgentRole[]
  ) {}

  async getRunContext(sessionId: string) {
    return sessionId === this.session.id
      ? {
          session: { ...this.session },
          projectInput: this.projectInput,
          roles: this.roles
        }
      : null;
  }

  async ensureAgentRoles(roles: readonly AgentRole[]): Promise<AgentRole[]> {
    return [...roles];
  }

  async setSessionState(input: {
    sessionId: string;
    phase: string;
    operationalStatus: string;
    currentConclusion: string | null;
  }): Promise<void> {
    if (input.sessionId === this.session.id) {
      this.session.phase = input.phase;
      this.session.operationalStatus = input.operationalStatus;
      this.session.currentConclusion = input.currentConclusion;
    }
  }

  async startAgentRun(input: {
    id: string;
    sessionId: string;
    roleId: string;
    promptVersionId: string;
    status: string;
    correlationId?: string;
    input?: unknown;
    startedAt?: string;
  }): Promise<void> {
    this.agentRuns.set(input.id, { ...input });
  }

  async saveClaimsAndEvidence(input: {
    runId: string;
    output: unknown;
    claims: Claim[];
    evidence: Evidence[];
  }): Promise<void> {
    this.claims.push(...structuredClone(input.claims));
    this.evidence.push(...structuredClone(input.evidence));
    const run = this.agentRuns.get(input.runId);
    if (run) {
      run.status = "completed";
      run.output = input.output;
      run.completedAt = new Date().toISOString();
    }
  }

  async failAgentRun(input: {
    runId: string;
    error: string;
  }): Promise<void> {
    const run = this.agentRuns.get(input.runId);
    if (run) {
      run.status = "failed";
      run.error = input.error;
      run.completedAt = new Date().toISOString();
    }
  }

  async saveClaim(claim: Claim): Promise<void> {
    this.claims.push(structuredClone(claim));
  }

  async saveChallenge(challenge: Challenge): Promise<void> {
    this.challenges.push(structuredClone(challenge));
  }

  async updateChallenge(challenge: Challenge): Promise<void> {
    const index = this.challenges.findIndex(
      (item) => item.id === challenge.id
    );
    if (index >= 0) {
      this.challenges[index] = structuredClone(challenge);
    } else {
      this.challenges.push(structuredClone(challenge));
    }
  }

  async saveConflict(conflict: Conflict): Promise<void> {
    this.conflicts.push(structuredClone(conflict));
  }

  async withSupplementLock<T>(
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    if (sessionId !== this.session.id) {
      return operation();
    }
    const previous = this.supplementLock;
    let release!: () => void;
    this.supplementLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async getSessionArtifacts(sessionId: string) {
    if (sessionId !== this.session.id) {
      return null;
    }
    return {
      claims: structuredClone(this.claims),
      evidence: structuredClone(this.evidence),
      challenges: structuredClone(this.challenges),
      conflicts: structuredClone(this.conflicts)
    };
  }

  async getClaimValidationContext(claimId: string) {
    const claim = this.claims.find((item) => item.id === claimId);
    if (!claim) {
      return null;
    }
    return {
      claim,
      evidence: this.evidence.filter((item) => item.claimId === claimId),
      challenges: this.challenges.filter(
        (item) => item.targetClaimId === claimId
      )
    };
  }

  async appendEvent(input: {
    sessionId: string;
    correlationId: string;
    type: ExecutionEvent["type"];
    payload: unknown;
    traceId?: string;
    promptVersionId?: string;
  }): Promise<ExecutionEvent> {
    const event: ExecutionEvent = {
      id: newId(),
      sessionId: input.sessionId,
      sequence: this.events.length + 1,
      correlationId: input.correlationId,
      ...(input.traceId ? { traceId: input.traceId } : {}),
      type: input.type,
      payload: structuredClone(input.payload),
      occurredAt: new Date().toISOString(),
      ...(input.promptVersionId
        ? { promptVersionId: input.promptVersionId }
        : {})
    };
    this.events.push(event);
    return event;
  }
}
