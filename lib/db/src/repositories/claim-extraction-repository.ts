import { and, desc, eq } from "drizzle-orm";
import {
  type CandidateDecision,
  type ClaimCandidate,
  type ClaimExtractionRun,
  type EvidenceCandidate,
  type ExecutionEvent
} from "@nexus/shared";
import type { Database } from "../client";
import {
  claimCandidates,
  claimExtractionRuns,
  evidenceCandidates
} from "../schema";
import { appendEvent, type AppendEventInput, type DbExecutor } from "./append-event";
import {
  parseClaimCandidates,
  parseClaimExtractionRuns,
  parseEvidenceCandidates
} from "./domain-mapper";

export class ExtractionRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Claim extraction run not found: ${runId}`);
    this.name = "ExtractionRunNotFoundError";
  }
}

export class CandidateNotFoundError extends Error {
  constructor(candidateId: string) {
    super(`Candidate not found: ${candidateId}`);
    this.name = "CandidateNotFoundError";
  }
}

export type RecordExtractionRunInput = {
  run: ClaimExtractionRun;
  event: AppendEventInput;
};

/** A candidate claim about to be stored; everything but its own bookkeeping. */
export type NewClaimCandidate = Pick<
  ClaimCandidate,
  | "id"
  | "segmentIndex"
  | "statement"
  | "type"
  | "qualifiers"
  | "uncertainty"
  | "rationale"
  | "suggestedImportance"
  | "status"
> &
  Pick<Partial<ClaimCandidate>, "context">;

/** A candidate excerpt about to be stored, already located by the server. */
export type NewEvidenceCandidate = Pick<
  EvidenceCandidate,
  | "id"
  | "claimCandidateId"
  | "segmentIndex"
  | "excerpt"
  | "title"
  | "direction"
  | "locatorKind"
  | "locatorStatus"
  | "suggestedReliability"
  | "rationale"
  | "uncertainty"
  | "status"
> &
  Pick<
    Partial<EvidenceCandidate>,
    "locator" | "anchorText" | "sourceContentHash"
  >;

export type ReplaceCandidatesInput = {
  runId: string;
  sessionId: string;
  sourceId: string;
  snapshotId: string;
  claims: NewClaimCandidate[];
  evidence: NewEvidenceCandidate[];
  event: AppendEventInput;
};

/**
 * Model-proposed claims and excerpts.
 *
 * The guiding rule is that nothing here is material yet. Candidates are read
 * only by the candidate review surface, never by anything that derives a
 * verdict, so keeping a suggestion cannot inflate what the research says is
 * known. Acceptance does not write a claim or an excerpt here — it records *the
 * id of the row* the existing domain API already created.
 */
export class ClaimExtractionRepository {
  constructor(private readonly database: Database) {}

  /**
   * Creates one analysis task. The (session, source, snapshot, inputHash)
   * quadruple is unique, so asking the same question twice is prevented by the
   * database rather than by hope.
   */
  async createRun(
    input: RecordExtractionRunInput
  ): Promise<{ run: ClaimExtractionRun; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const now = input.run.createdAt;
      const [created] = await transaction
        .insert(claimExtractionRuns)
        .values({
          id: input.run.id,
          sessionId: input.run.sessionId,
          sourceId: input.run.sourceId,
          snapshotId: input.run.snapshotId,
          status: input.run.status,
          ...(input.run.failureCode
            ? { failureCode: input.run.failureCode }
            : {}),
          ...(input.run.failureMessage
            ? { failureMessage: input.run.failureMessage }
            : {}),
          provider: input.run.provider,
          model: input.run.model,
          inputHash: input.run.inputHash,
          promptVersion: input.run.promptVersion,
          segmentationVersion: input.run.segmentationVersion,
          charCount: input.run.charCount,
          segmentCount: input.run.segmentCount,
          candidateClaimCount: input.run.candidateClaimCount,
          candidateEvidenceCount: input.run.candidateEvidenceCount,
          anchorMatched: input.run.anchorMatched,
          anchorMissing: input.run.anchorMissing,
          attempt: input.run.attempt,
          correlationId: input.run.correlationId,
          createdBy: input.run.createdBy,
          startedAt: input.run.startedAt,
          ...(input.run.completedAt
            ? { completedAt: input.run.completedAt }
            : {}),
          createdAt: now,
          updatedAt: now
        })
        .returning();
      const event = await appendEvent(
        transaction,
        input.run.sessionId,
        input.event
      );
      return {
        run: parseClaimExtractionRuns([created])[0]!,
        event
      };
    });
  }

  /** The answer to an identical question, if one already exists. */
  async findReusableRun(input: {
    sessionId: string;
    sourceId: string;
    snapshotId: string;
    inputHash: string;
  }): Promise<ClaimExtractionRun | null> {
    const [row] = await this.database
      .select()
      .from(claimExtractionRuns)
      .where(
        and(
          eq(claimExtractionRuns.sessionId, input.sessionId),
          eq(claimExtractionRuns.sourceId, input.sourceId),
          eq(claimExtractionRuns.snapshotId, input.snapshotId),
          eq(claimExtractionRuns.inputHash, input.inputHash)
        )
      )
      .orderBy(desc(claimExtractionRuns.createdAt))
      .limit(1);
    if (!row) return null;
    return parseClaimExtractionRuns([row])[0] ?? null;
  }

  async listRuns(
    sessionId: string,
    filter: { sourceId?: string } = {}
  ): Promise<ClaimExtractionRun[]> {
    const rows = await this.database
      .select()
      .from(claimExtractionRuns)
      .where(
        filter.sourceId
          ? and(
              eq(claimExtractionRuns.sessionId, sessionId),
              eq(claimExtractionRuns.sourceId, filter.sourceId)
            )
          : eq(claimExtractionRuns.sessionId, sessionId)
      )
      .orderBy(desc(claimExtractionRuns.createdAt));
    return parseClaimExtractionRuns(rows);
  }

  /**
   * Reopens a previous run for another attempt.
   *
   * Retries reuse the same row rather than adding one, because the question is
   * identical — the unique input index would refuse a second row anyway. The
   * previous failure is cleared at the same time: keeping a stale reason on a
   * run that is about to succeed again would leave two answers to "did this
   * work?" where only one can be right.
   */
  async markAttemptStarted(input: {
    sessionId: string;
    runId: string;
    attempt: number;
  }): Promise<void> {
    await this.database
      .update(claimExtractionRuns)
      .set({
        status: "running",
        attempt: input.attempt,
        failureCode: null,
        failureMessage: null,
        completedAt: null,
        updatedAt: new Date().toISOString()
      })
      .where(
        and(
          eq(claimExtractionRuns.sessionId, input.sessionId),
          eq(claimExtractionRuns.id, input.runId)
        )
      );
  }

  async getRun(
    sessionId: string,
    runId: string
  ): Promise<ClaimExtractionRun | null> {
    const [row] = await this.database
      .select()
      .from(claimExtractionRuns)
      .where(
        and(
          eq(claimExtractionRuns.sessionId, sessionId),
          eq(claimExtractionRuns.id, runId)
        )
      )
      .limit(1);
    if (!row) return null;
    return parseClaimExtractionRuns([row])[0] ?? null;
  }

  async listCandidatesByRun(
    sessionId: string,
    runId: string
  ): Promise<{ claims: ClaimCandidate[]; evidence: EvidenceCandidate[] }> {
    const [claimRows, evidenceRows] = await Promise.all([
      this.database
        .select()
        .from(claimCandidates)
        .where(
          and(
            eq(claimCandidates.sessionId, sessionId),
            eq(claimCandidates.runId, runId)
          )
        )
        .orderBy(claimCandidates.segmentIndex, claimCandidates.createdAt),
      this.database
        .select()
        .from(evidenceCandidates)
        .where(
          and(
            eq(evidenceCandidates.sessionId, sessionId),
            eq(evidenceCandidates.runId, runId)
          )
        )
        .orderBy(evidenceCandidates.segmentIndex, evidenceCandidates.createdAt)
    ]);
    return {
      claims: parseClaimCandidates(claimRows),
      evidence: parseEvidenceCandidates(evidenceRows)
    };
  }

  /**
   * Stores the candidates one run produced, replacing whatever the run had.
   *
   * Delete-then-insert inside one transaction: a re-analysis is the current
   * answer, and keeping superseded suggestions around would leave two sets that
   * look identical but are not. Usage indexing makes the delete cheap.
   */
  async replaceCandidates(
    input: ReplaceCandidatesInput
  ): Promise<{ claims: ClaimCandidate[]; evidence: EvidenceCandidate[] }> {
    return this.database.transaction(async (transaction) => {
      const now = new Date().toISOString();

      await transaction
        .delete(evidenceCandidates)
        .where(eq(evidenceCandidates.runId, input.runId));
      await transaction
        .delete(claimCandidates)
        .where(eq(claimCandidates.runId, input.runId));

      if (input.claims.length > 0) {
        await transaction.insert(claimCandidates).values(
          input.claims.map((candidate) => ({
            id: candidate.id,
            sessionId: input.sessionId,
            runId: input.runId,
            sourceId: input.sourceId,
            snapshotId: input.snapshotId,
            segmentIndex: candidate.segmentIndex,
            statement: candidate.statement,
            type: candidate.type,
            ...(candidate.context ? { context: candidate.context } : {}),
            qualifiers: candidate.qualifiers,
            uncertainty: candidate.uncertainty,
            rationale: candidate.rationale,
            suggestedImportance: candidate.suggestedImportance,
            status: candidate.status,
            createdAt: now,
            updatedAt: now
          }))
        );
      }

      if (input.evidence.length > 0) {
        await transaction.insert(evidenceCandidates).values(
          input.evidence.map((candidate) => ({
            id: candidate.id,
            sessionId: input.sessionId,
            runId: input.runId,
            sourceId: input.sourceId,
            snapshotId: input.snapshotId,
            segmentIndex: candidate.segmentIndex,
            claimCandidateId: candidate.claimCandidateId,
            excerpt: candidate.excerpt,
            title: candidate.title,
            direction: candidate.direction,
            locatorKind: candidate.locatorKind,
            locatorStatus: candidate.locatorStatus,
            ...(candidate.locator ? { locator: candidate.locator } : {}),
            ...(candidate.anchorText
              ? { anchorText: candidate.anchorText }
              : {}),
            ...(candidate.sourceContentHash
              ? { sourceContentHash: candidate.sourceContentHash }
              : {}),
            suggestedReliability: candidate.suggestedReliability,
            rationale: candidate.rationale,
            uncertainty: candidate.uncertainty,
            status: candidate.status,
            createdAt: now,
            updatedAt: now
          }))
        );
      }

      await this.finalizeRunIn(transaction, {
        runId: input.runId,
        status: "succeeded",
        candidateClaimCount: input.claims.length,
        candidateEvidenceCount: input.evidence.length,
        anchorMatched: input.evidence.filter(
          (item) => item.locatorStatus === "anchored"
        ).length,
        anchorMissing: input.evidence.filter(
          (item) => item.locatorStatus === "missing"
        ).length,
        completedAt: now
      });

      await appendEvent(transaction, input.sessionId, input.event);

      const [claimRows, evidenceRows] = await Promise.all([
        transaction
          .select()
          .from(claimCandidates)
          .where(eq(claimCandidates.runId, input.runId))
          .orderBy(claimCandidates.segmentIndex, claimCandidates.createdAt),
        transaction
          .select()
          .from(evidenceCandidates)
          .where(eq(evidenceCandidates.runId, input.runId))
          .orderBy(evidenceCandidates.segmentIndex, evidenceCandidates.createdAt)
      ]);

      return {
        claims: parseClaimCandidates(claimRows),
        evidence: parseEvidenceCandidates(evidenceRows)
      };
    });
  }

  /**
   * Marks a run as failed with a code the UI can turn into a sentence.
   *
   * A failed analysis is a real outcome worth recording: "the model did not
   * answer" is not the same as "there were no claims in this page", and the
   * workspace has to be able to tell them apart.
   */
  async failRun(input: {
    sessionId: string;
    runId: string;
    failureCode: ClaimExtractionRun["failureCode"];
    failureMessage: string;
    event: AppendEventInput;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await this.finalizeRunIn(transaction, {
        runId: input.runId,
        status: "failed",
        failureCode: input.failureCode,
        failureMessage: input.failureMessage,
        completedAt: new Date().toISOString()
      });
      await appendEvent(transaction, input.sessionId, input.event);
    });
  }

  /**
   * Records a researcher's ruling on candidates.
   *
   * This deliberately does not create claims or evidence. Those rows already
   * exist by the time this runs — the review surface put them there through the
   * ordinary domain endpoints — so what is recorded here is only the link and
   * the decision.
   */
  async recordDecisions(input: {
    sessionId: string;
    runId: string;
    decisions: CandidateDecision[];
    decidedBy: string;
    event: AppendEventInput;
  }): Promise<{
    claims: ClaimCandidate[];
    evidence: EvidenceCandidate[];
    event: ExecutionEvent;
  }> {
    return this.database.transaction(async (transaction) => {
      const now = new Date().toISOString();
      const claimDecisions = input.decisions.filter(
        (decision) => decision.kind === "claim"
      );
      const evidenceDecisions = input.decisions.filter(
        (decision) => decision.kind === "evidence"
      );

      for (const decision of claimDecisions) {
        const updated = await transaction
          .update(claimCandidates)
          .set({
            status: decision.status === "accepted" ? "accepted" : "rejected",
            ...(decision.createdClaimId
              ? { createdClaimId: decision.createdClaimId }
              : {}),
            ...(decision.rejectReason
              ? { rejectReason: decision.rejectReason }
              : {}),
            decidedBy: input.decidedBy,
            decidedAt: now,
            updatedAt: now
          })
          .where(
            and(
              eq(claimCandidates.id, decision.candidateId),
              eq(claimCandidates.sessionId, input.sessionId),
              eq(claimCandidates.runId, input.runId)
            )
          )
          .returning({ id: claimCandidates.id });
        if (updated.length === 0) {
          throw new CandidateNotFoundError(decision.candidateId);
        }
      }

      for (const decision of evidenceDecisions) {
        const updated = await transaction
          .update(evidenceCandidates)
          .set({
            status: decision.status === "accepted" ? "accepted" : "rejected",
            ...(decision.createdEvidenceId
              ? { createdEvidenceId: decision.createdEvidenceId }
              : {}),
            ...(decision.rejectReason
              ? { rejectReason: decision.rejectReason }
              : {}),
            decidedBy: input.decidedBy,
            decidedAt: now,
            updatedAt: now
          })
          .where(
            and(
              eq(evidenceCandidates.id, decision.candidateId),
              eq(evidenceCandidates.sessionId, input.sessionId),
              eq(evidenceCandidates.runId, input.runId)
            )
          )
          .returning({ id: evidenceCandidates.id });
        if (updated.length === 0) {
          throw new CandidateNotFoundError(decision.candidateId);
        }
      }

      const event = await appendEvent(
        transaction,
        input.sessionId,
        input.event
      );

      const [claimRows, evidenceRows] = await Promise.all([
        transaction
          .select()
          .from(claimCandidates)
          .where(eq(claimCandidates.runId, input.runId))
          .orderBy(claimCandidates.segmentIndex, claimCandidates.createdAt),
        transaction
          .select()
          .from(evidenceCandidates)
          .where(eq(evidenceCandidates.runId, input.runId))
          .orderBy(evidenceCandidates.segmentIndex, evidenceCandidates.createdAt)
      ]);

      return {
        claims: parseClaimCandidates(claimRows),
        evidence: parseEvidenceCandidates(evidenceRows),
        event
      };
    });
  }

  private async finalizeRunIn(
    transaction: DbExecutor,
    input: {
      runId: string;
      status: Extract<ClaimExtractionRun["status"], "succeeded" | "failed">;
      failureCode?: ClaimExtractionRun["failureCode"] | undefined;
      failureMessage?: string | undefined;
      candidateClaimCount?: number | undefined;
      candidateEvidenceCount?: number | undefined;
      anchorMatched?: number | undefined;
      anchorMissing?: number | undefined;
      completedAt: string;
    }
  ): Promise<void> {
    const updated = await transaction
      .update(claimExtractionRuns)
      .set({
        status: input.status,
        ...(input.failureCode !== undefined
          ? { failureCode: input.failureCode }
          : {}),
        ...(input.failureMessage !== undefined
          ? { failureMessage: input.failureMessage }
          : {}),
        ...(input.candidateClaimCount !== undefined
          ? { candidateClaimCount: input.candidateClaimCount }
          : {}),
        ...(input.candidateEvidenceCount !== undefined
          ? { candidateEvidenceCount: input.candidateEvidenceCount }
          : {}),
        ...(input.anchorMatched !== undefined
          ? { anchorMatched: input.anchorMatched }
          : {}),
        ...(input.anchorMissing !== undefined
          ? { anchorMissing: input.anchorMissing }
          : {}),
        completedAt: input.completedAt,
        updatedAt: input.completedAt
      })
      .where(eq(claimExtractionRuns.id, input.runId))
      .returning({ id: claimExtractionRuns.id });
    if (updated.length === 0) {
      throw new ExtractionRunNotFoundError(input.runId);
    }
  }
}
