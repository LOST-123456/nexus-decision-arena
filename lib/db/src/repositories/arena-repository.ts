import { and, eq, inArray, sql } from "drizzle-orm";
import {
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
import { appendEvent, type AppendEventInput, type ReadExecutor } from "./append-event";
import {
  parseAgentRoles,
  parseChallenges,
  parseClaims,
  parseConflicts,
  parseEvidence
} from "./domain-mapper";
import { evidenceCoversClaim } from "./evidence-link";

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

/** The transaction handle this repository's database hands to a callback. */
type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

function claimValues(claim: Claim): typeof claims.$inferInsert {
  return {
    id: claim.id,
    sessionId: claim.sessionId,
    agentRunId: claim.agentRunId ?? null,
    roleId: claim.roleId ?? null,
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
    claimIds: item.claimIds,
    kind: item.kind,
    title: item.title,
    content: item.content,
    description: item.description,
    ...(item.sourceId ? { sourceId: item.sourceId } : {}),
    ...(item.sourceRef ? { sourceRef: item.sourceRef } : {}),
    ...(item.locator ? { locator: item.locator } : {}),
    direction: item.direction,
    reliability: item.reliability,
    verificationStatus: item.verificationStatus,
    ...(item.verifiedBy ? { verifiedBy: item.verifiedBy } : {}),
    ...(item.verifiedAt ? { verifiedAt: item.verifiedAt } : {}),
    ...(item.verificationNote
      ? { verificationNote: item.verificationNote }
      : {}),
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
      roles: parseAgentRoles(
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

  /**
   * Records a claim a researcher entered themselves, with no agent run behind
   * it, together with its `CLAIM_CREATED` event.
   */
  async createResearchClaim(input: {
    claim: Claim;
    event: AppendEventInput;
  }): Promise<{ claim: Claim; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const [session] = await transaction
        .select({ id: decisionSessions.id })
        .from(decisionSessions)
        .where(eq(decisionSessions.id, input.claim.sessionId))
        .limit(1);
      if (!session) {
        throw new Error(`Session not found: ${input.claim.sessionId}`);
      }

      const [created] = await transaction
        .insert(claims)
        .values(claimValues(input.claim))
        .returning();

      const event = await appendEvent(
        transaction,
        input.claim.sessionId,
        input.event
      );

      return { claim: parseClaims([created!])[0]!, event };
    });
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

  /**
   * Writes one agent run's artifact only while that run is still `running`.
   *
   * A guard made of two statements — read the status, then insert — is not a
   * guard: a cancel can land between them and the artifact is written anyway,
   * which is precisely how a `cancelled` run ends up owning fresh challenges.
   * This takes a shared row lock on the run (`SELECT … FOR SHARE`) inside the
   * same transaction as the write, so `cancelAgentRun`'s `UPDATE`, which needs
   * an exclusive lock on that same row, has exactly two possible orders:
   *
   *  - cancel commits first → the locked read sees `cancelled`, nothing is
   *    written, and the caller learns the write was refused;
   *  - the write commits first → cancel waits, and the artifact is written
   *    while the run genuinely was running, which is honest history.
   *
   * Returns whether the artifact was written. `false` is not an error: it is
   * the answer "this run may no longer produce results".
   */
  private async writeWhileRunActive(
    runId: string,
    write: (tx: DatabaseTransaction) => Promise<void>
  ): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .for("share");
      if (!row || row.status !== "running") {
        return false;
      }
      await write(tx);
      return true;
    });
  }

  /** A challenge produced by a run, refused once that run is no longer running. */
  async saveChallengeWhileRunActive(
    runId: string,
    challenge: Challenge
  ): Promise<boolean> {
    return this.writeWhileRunActive(runId, async (tx) => {
      await tx.insert(challenges).values(challengeValues(challenge));
    });
  }

  /** A response claim produced by a run, under the same guard. */
  async saveClaimWhileRunActive(
    runId: string,
    claim: Claim
  ): Promise<boolean> {
    return this.writeWhileRunActive(runId, async (tx) => {
      await tx.insert(claims).values(claimValues(claim));
    });
  }

  /** A detected conflict, under the same guard. */
  async saveConflictWhileRunActive(
    runId: string,
    conflict: Conflict
  ): Promise<boolean> {
    return this.writeWhileRunActive(runId, async (tx) => {
      await tx.insert(conflicts).values(conflict);
    });
  }

  /** A challenge status update, under the same guard. */
  async updateChallengeWhileRunActive(
    runId: string,
    challenge: Challenge
  ): Promise<boolean> {
    return this.writeWhileRunActive(runId, async (tx) => {
      const values = challengeValues(challenge);
      await tx
        .update(challenges)
        .set({
          status: values.status,
          responseClaimId: values.responseClaimId,
          updatedAt: values.updatedAt
        })
        .where(eq(challenges.id, challenge.id));
    });
  }

  /**
   * Marks every conflict that still awaits a human ruling as `human_review`
   * once the session is paused at the human checkpoint, so the persisted
   * lifecycle (detected -> human_review -> resolved) reflects reality instead
   * of leaving `human_review` unreachable outside of fixtures.
   */
  async markConflictsInReview(sessionId: string): Promise<number> {
    const updated = await this.database
      .update(conflicts)
      .set({ status: "human_review", updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(conflicts.sessionId, sessionId),
          eq(conflicts.humanDecisionRequired, true),
          eq(conflicts.status, "detected")
        )
      )
      .returning({ id: conflicts.id });
    return updated.length;
  }

  async withSupplementLock<T>(
    sessionId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`
      );
      return operation();
    });
  }

  async getSessionArtifacts(
    sessionId: string,
    executor: ReadExecutor = this.database
  ) {
    const [
      sessionClaims,
      sessionEvidence,
      sessionChallenges,
      sessionConflicts
    ] = await Promise.all([
      executor.select().from(claims).where(eq(claims.sessionId, sessionId)),
      executor
        .select()
        .from(evidence)
        .where(eq(evidence.sessionId, sessionId)),
      executor
        .select()
        .from(challenges)
        .where(eq(challenges.sessionId, sessionId)),
      executor
        .select()
        .from(conflicts)
        .where(eq(conflicts.sessionId, sessionId))
    ]);
    return {
      claims: parseClaims(sessionClaims),
      evidence: parseEvidence(sessionEvidence),
      challenges: parseChallenges(sessionChallenges),
      conflicts: parseConflicts(sessionConflicts)
    };
  }

  /**
   * Challenges opened by one run. Scoped to the session and resolved by
   * `(session_id, challenger_run_id)`, so a single run's challenges are a small
   * index seek instead of a scan of the whole session's challenges. This is the
   * query that lets "open one agent run" stay cheap in a large session — the
   * alternative, loading every challenge of the session and filtering in the
   * app, grows linearly with session size.
   */
  async listChallengesByRun(
    sessionId: string,
    runId: string,
    executor: ReadExecutor = this.database
  ): Promise<Challenge[]> {
    const rows = await executor
      .select()
      .from(challenges)
      .where(
        and(
          eq(challenges.sessionId, sessionId),
          eq(challenges.challengerRunId, runId)
        )
      );
    return parseChallenges(rows);
  }

  /**
   * The response claims a run produced; claims carry the producing run's id and
   * are resolved by `(session_id, agent_run_id)`.
   */
  async listResponseClaimsByRun(
    sessionId: string,
    runId: string,
    executor: ReadExecutor = this.database
  ): Promise<Claim[]> {
    const rows = await executor
      .select()
      .from(claims)
      .where(
        and(eq(claims.sessionId, sessionId), eq(claims.agentRunId, runId))
      );
    return parseClaims(rows);
  }

  /**
   * Conflicts that name any of the given challenge ids. Conflicts store their
   * challenge ids as a jsonb array; the overlap is asked of Postgres rather than
   * by pulling the whole session's conflicts into the app to filter there.
   * An empty id list is an immediate empty result — no query needed.
   *
   * The overlap is expressed as an OR of single-element `@>` containment tests
   * (the same shape `evidenceCoversAnyClaim` uses), NOT as a raw
   * `challenge_ids ?| ${ids}::text[]`: passing a JS array as a raw `sql`
   * parameter makes the Postgres driver send it as one scalar string, which
   * fails at runtime with `malformed array literal` (22P02). Each id is passed
   * as a one-element jsonb value via `JSON.stringify`, which the driver
   * serializes safely.
   */
  async listConflictsByChallengeIds(
    sessionId: string,
    challengeIds: string[],
    executor: ReadExecutor = this.database
  ): Promise<Conflict[]> {
    if (challengeIds.length === 0) return [];
    const overlap = sql`(${sql.join(
      challengeIds.map(
        (challengeId) =>
          sql`${conflicts.challengeIds} @> ${JSON.stringify([challengeId])}::jsonb`
      ),
      sql` OR `
    )})`;
    const rows = await executor
      .select()
      .from(conflicts)
      .where(and(eq(conflicts.sessionId, sessionId), overlap));
    return parseConflicts(rows);
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
        .where(evidenceCoversClaim(evidence.claimIds, claimId)),
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
