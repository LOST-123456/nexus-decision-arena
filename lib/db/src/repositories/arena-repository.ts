import { eq, inArray } from "drizzle-orm";
import {
  AgentRoleSchema,
  type AgentRole,
  type Challenge,
  type Claim,
  type Conflict,
  type Evidence,
  type ExecutionEvent
} from "@nexus/shared";
import type { Database } from "../client";
import {
  agentRoles,
  agentRuns,
  challenges,
  claims,
  conflicts,
  decisionSessions,
  evidence,
  projects,
  promptVersions
} from "../schema";
import {
  parseChallenges,
  parseClaims,
  parseEvidence
} from "./domain-mapper";

type SessionStateInput = {
  sessionId: string;
  phase: string;
  operationalStatus: string;
  currentConclusion: string | null;
};

type AgentRunInput = {
  id: string;
  sessionId: string;
  roleId: string;
  promptVersionId: string;
  status: string;
  correlationId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
};

function claimValues(claim: Claim): typeof claims.$inferInsert {
  return {
    id: claim.id,
    sessionId: claim.sessionId,
    agentRunId: claim.agentRunId,
    roleId: claim.roleId,
    lens: claim.lens,
    statement: claim.statement,
    type: claim.type,
    stance: claim.stance,
    importance: claim.importance,
    confidence: claim.confidence,
    evidenceIds: claim.evidenceIds,
    status: claim.status,
    rootClaimId: claim.rootClaimId,
    ...(claim.revisionOfClaimId
      ? { revisionOfClaimId: claim.revisionOfClaimId }
      : {}),
    revision: claim.revision,
    relations: claim.relations,
    ...(claim.respondsToChallengeId
      ? { respondsToChallengeId: claim.respondsToChallengeId }
      : {}),
    ...(claim.disposition ? { disposition: claim.disposition } : {}),
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt
  };
}

function challengeValues(
  challenge: Challenge
): typeof challenges.$inferInsert {
  return {
    id: challenge.id,
    sessionId: challenge.sessionId,
    targetClaimId: challenge.targetClaimId,
    challengerRunId: challenge.challengerRunId,
    challengerRoleId: challenge.challengerRoleId,
    type: challenge.type,
    question: challenge.question,
    context: challenge.context,
    requiredEvidence: challenge.requiredEvidence,
    severity: challenge.severity,
    resolutionStrategy: challenge.resolutionStrategy,
    status: challenge.status,
    ...(challenge.responseClaimId
      ? { responseClaimId: challenge.responseClaimId }
      : {}),
    correlationId: challenge.correlationId,
    createdAt: challenge.createdAt,
    updatedAt: challenge.updatedAt
  };
}

function evidenceValues(
  item: Evidence
): typeof evidence.$inferInsert {
  return {
    id: item.id,
    sessionId: item.sessionId,
    claimId: item.claimId,
    kind: item.kind,
    title: item.title,
    content: item.content,
    description: item.description,
    ...(item.sourceRef ? { sourceRef: item.sourceRef } : {}),
    direction: item.direction,
    reliability: item.reliability,
    verificationStatus: item.verificationStatus,
    ...(item.validityPeriod ? { validityPeriod: item.validityPeriod } : {}),
    retrievedAt: item.retrievedAt,
    createdBy: item.createdBy,
    ...(item.agentRunId ? { agentRunId: item.agentRunId } : {})
  };
}

export class ArenaRepository {
  constructor(private readonly database: Database) {}

  async getRunContext(sessionId: string) {
    const [session] = await this.database
      .select()
      .from(decisionSessions)
      .where(eq(decisionSessions.id, sessionId))
      .limit(1);
    if (!session) {
      return null;
    }

    const [project] = await this.database
      .select()
      .from(projects)
      .where(eq(projects.id, session.projectId))
      .limit(1);
    return {
      session: {
        id: session.id,
        phase: session.phase,
        operationalStatus: session.operationalStatus,
        currentConclusion: session.currentConclusion,
        supplementRound: session.supplementRound
      },
      projectInput: project?.input ?? {},
      roles: AgentRoleSchema.array().parse(
        await this.database.select().from(agentRoles)
      )
    };
  }

  async ensureAgentRoles(roles: readonly AgentRole[]): Promise<AgentRole[]> {
    if (roles.length === 0) {
      return [];
    }

    await this.database.transaction(async (transaction) => {
      await transaction
        .insert(promptVersions)
        .values(
          roles.map((role) => ({
            id: role.promptVersionId,
            name: role.key,
            version: "fixture-v1",
            content: JSON.stringify({
              goal: role.goal,
              perspective: role.perspective,
              evaluationCriteria: role.evaluationCriteria
            })
          }))
        )
        .onConflictDoNothing();
      await transaction
        .insert(agentRoles)
        .values([...roles])
        .onConflictDoNothing({ target: agentRoles.key });
    });

    const persisted = await this.database
      .select()
      .from(agentRoles)
      .where(inArray(agentRoles.key, roles.map((role) => role.key)));
    const byKey = new Map(persisted.map((role) => [role.key, role]));
    return roles
      .map((role) => byKey.get(role.key))
      .filter((role): role is AgentRole => Boolean(role));
  }

  async setSessionState(input: SessionStateInput): Promise<void> {
    await this.database
      .update(decisionSessions)
      .set({
        phase: input.phase,
        operationalStatus: input.operationalStatus,
        currentConclusion: input.currentConclusion,
        updatedAt: new Date().toISOString()
      })
      .where(eq(decisionSessions.id, input.sessionId));
  }

  async startAgentRun(input: AgentRunInput): Promise<void> {
    await this.database.insert(agentRuns).values({
      id: input.id,
      sessionId: input.sessionId,
      roleId: input.roleId,
      promptVersionId: input.promptVersionId,
      status: input.status,
      ...(input.correlationId
        ? { correlationId: input.correlationId }
        : {}),
      ...(input.input === undefined ? {} : { input: input.input }),
      ...(input.startedAt ? { startedAt: input.startedAt } : {})
    });
  }

  async saveClaimsAndEvidence(input: {
    runId: string;
    output: unknown;
    claims: Claim[];
    evidence: Evidence[];
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      if (input.claims.length > 0) {
        await transaction.insert(claims).values(input.claims.map(claimValues));
      }
      if (input.evidence.length > 0) {
        await transaction
          .insert(evidence)
          .values(input.evidence.map(evidenceValues));
      }
      await transaction
        .update(agentRuns)
        .set({
          status: "completed",
          output: input.output,
          completedAt: new Date().toISOString()
        })
        .where(eq(agentRuns.id, input.runId));
    });
  }

  async failAgentRun(input: {
    runId: string;
    error: string;
  }): Promise<void> {
    await this.database
      .update(agentRuns)
      .set({
        status: "failed",
        error: input.error,
        completedAt: new Date().toISOString()
      })
      .where(eq(agentRuns.id, input.runId));
  }

  async saveChallenge(challenge: Challenge): Promise<void> {
    await this.database.insert(challenges).values(challengeValues(challenge));
  }

  async saveClaim(claim: Claim): Promise<void> {
    await this.database.insert(claims).values(claimValues(claim));
  }

  async updateChallenge(challenge: Challenge): Promise<void> {
    const values = challengeValues(challenge);
    await this.database
      .update(challenges)
      .set({
        status: values.status,
        responseClaimId: values.responseClaimId,
        updatedAt: values.updatedAt
      })
      .where(eq(challenges.id, challenge.id));
  }

  async saveConflict(conflict: Conflict): Promise<void> {
    await this.database.insert(conflicts).values(conflict);
  }

  async getClaimValidationContext(claimId: string): Promise<{
    claim: Claim;
    evidence: Evidence[];
    challenges: Challenge[];
  } | null> {
    const [claim] = await this.database
      .select()
      .from(claims)
      .where(eq(claims.id, claimId))
      .limit(1);
    if (!claim) {
      return null;
    }
    const [claimEvidence, claimChallenges] = await Promise.all([
      this.database
        .select()
        .from(evidence)
        .where(eq(evidence.claimId, claimId)),
      this.database
        .select()
        .from(challenges)
        .where(eq(challenges.targetClaimId, claimId))
    ]);
    return {
      claim: parseClaims([claim])[0]!,
      evidence: parseEvidence(claimEvidence),
      challenges: parseChallenges(claimChallenges)
    };
  }
}
