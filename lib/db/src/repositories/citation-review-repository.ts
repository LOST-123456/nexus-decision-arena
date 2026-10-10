import { and, asc, desc, eq } from "drizzle-orm";
import type {
  CitationIntegrityCheck,
  ClaimSupportAssessment,
  ExecutionEvent
} from "@nexus/shared";
import type { Database } from "../client";
import {
  citationIntegrityChecks,
  claimSupportAssessments
} from "../schema";
import { appendEvent, type AppendEventInput } from "./append-event";
import {
  parseCitationIntegrityChecks,
  parseClaimSupportAssessments
} from "./domain-mapper";

export class CitationCheckNotFoundError extends Error {
  constructor(checkId: string) {
    super(`Citation integrity check not found: ${checkId}`);
    this.name = "CitationCheckNotFoundError";
  }
}

export class SupportAssessmentNotFoundError extends Error {
  constructor(assessmentId: string) {
    super(`Support assessment not found: ${assessmentId}`);
    this.name = "SupportAssessmentNotFoundError";
  }
}

/** An integrity check about to be stored, before the server fills in the rest. */
export type NewCitationIntegrityCheck = Pick<
  CitationIntegrityCheck,
  "id" | "evidenceId" | "status" | "reason" | "origin" | "actor"
> &
  Pick<
    Partial<CitationIntegrityCheck>,
    | "sourceId"
    | "snapshotId"
    | "matchKind"
    | "anchorText"
    | "expectedContentHash"
    | "snapshotContentHash"
    | "matchedText"
    | "contextText"
  >;

/** A support assessment about to be stored. */
export type NewClaimSupportAssessment = Pick<
  ClaimSupportAssessment,
  | "id"
  | "claimId"
  | "evidenceId"
  | "status"
  | "rationale"
  | "matchedExcerptLocated"
  | "promptVersion"
  | "origin"
  | "actor"
> &
  Pick<
    Partial<ClaimSupportAssessment>,
    | "confidence"
    | "matchedExcerpt"
    | "signals"
    | "provider"
    | "model"
  >;

export type RecordIntegrityChecksInput = {
  sessionId: string;
  checks: NewCitationIntegrityCheck[];
  event: AppendEventInput;
};

export type RecordAssessmentsInput = {
  sessionId: string;
  assessments: NewClaimSupportAssessment[];
  event: AppendEventInput;
};

export type CorrectCitationInput = {
  sessionId: string;
  /** The record being corrected. It stays exactly as it was. */
  targetId: string;
  newId: string;
  status: string;
  rationale: string;
  actor: string;
  event: AppendEventInput;
};

/**
 * Citation integrity checks (A) and claim-evidence support assessments (B).
 *
 * The rule both tables share: **a conclusion is never edited**. When a new
 * result arrives — from a re-check or from a human correction — the previous
 * row keeps its status, rationale, author and timestamp, and only its
 * `is_current` pointer is cleared. The replacement points back at it through
 * `supersedes_id`, so "what did we think before, and who changed it" is
 * answerable from the tables alone.
 *
 * What is deliberately absent: nothing here writes `evidence`, `claims`, or
 * `evidence.verification_status`. This repository can describe a citation but
 * it cannot promote one.
 */
export class CitationReviewRepository {
  constructor(private readonly database: Database) {}

  /* ---------------- A. integrity ---------------- */

  /**
   * Stores one check per excerpt, replacing the current conclusion for each.
   *
   * Clearing the old pointer and inserting the new row happen in one
   * transaction, so a reader can never see an excerpt with two current answers
   * (the partial unique index would reject it anyway).
   */
  async recordIntegrityChecks(
    input: RecordIntegrityChecksInput
  ): Promise<{ checks: CitationIntegrityCheck[]; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const createdAt = new Date().toISOString();
      const created: CitationIntegrityCheck[] = [];

      for (const check of input.checks) {
        const [previous] = await transaction
          .select()
          .from(citationIntegrityChecks)
          .where(
            and(
              eq(citationIntegrityChecks.evidenceId, check.evidenceId),
              eq(citationIntegrityChecks.isCurrent, true)
            )
          );
        if (previous) {
          await transaction
            .update(citationIntegrityChecks)
            .set({ isCurrent: false })
            .where(eq(citationIntegrityChecks.id, previous.id));
        }

        await transaction.insert(citationIntegrityChecks).values({
          id: check.id,
          sessionId: input.sessionId,
          evidenceId: check.evidenceId,
          ...(check.sourceId ? { sourceId: check.sourceId } : {}),
          ...(check.snapshotId ? { snapshotId: check.snapshotId } : {}),
          status: check.status,
          ...(check.matchKind ? { matchKind: check.matchKind } : {}),
          ...(check.anchorText ? { anchorText: check.anchorText } : {}),
          ...(check.expectedContentHash
            ? { expectedContentHash: check.expectedContentHash }
            : {}),
          ...(check.snapshotContentHash
            ? { snapshotContentHash: check.snapshotContentHash }
            : {}),
          ...(check.matchedText ? { matchedText: check.matchedText } : {}),
          ...(check.contextText ? { contextText: check.contextText } : {}),
          reason: check.reason,
          origin: check.origin,
          actor: check.actor,
          ...(previous ? { supersedesId: previous.id } : {}),
          isCurrent: true,
          createdAt
        });

        const [row] = await transaction
          .select()
          .from(citationIntegrityChecks)
          .where(eq(citationIntegrityChecks.id, check.id));
        if (row) {
          created.push(parseCitationIntegrityChecks([row])[0]!);
        }
      }

      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { checks: created, event };
    });
  }

  /** The current conclusion for every excerpt in a session. */
  async listCurrentIntegrity(
    sessionId: string
  ): Promise<CitationIntegrityCheck[]> {
    const rows = await this.database
      .select()
      .from(citationIntegrityChecks)
      .where(
        and(
          eq(citationIntegrityChecks.sessionId, sessionId),
          eq(citationIntegrityChecks.isCurrent, true)
        )
      )
      .orderBy(asc(citationIntegrityChecks.createdAt));
    return parseCitationIntegrityChecks(rows);
  }

  /** Full history for one excerpt, oldest first, including superseded results. */
  async listIntegrityHistory(
    sessionId: string,
    evidenceId: string
  ): Promise<CitationIntegrityCheck[]> {
    const rows = await this.database
      .select()
      .from(citationIntegrityChecks)
      .where(
        and(
          eq(citationIntegrityChecks.sessionId, sessionId),
          eq(citationIntegrityChecks.evidenceId, evidenceId)
        )
      )
      .orderBy(asc(citationIntegrityChecks.createdAt));
    return parseCitationIntegrityChecks(rows);
  }

  /** Reads one check, scoped to the session so ids cannot be guessed across. */
  async getIntegrityCheck(
    sessionId: string,
    checkId: string
  ): Promise<CitationIntegrityCheck | null> {
    const [row] = await this.database
      .select()
      .from(citationIntegrityChecks)
      .where(
        and(
          eq(citationIntegrityChecks.sessionId, sessionId),
          eq(citationIntegrityChecks.id, checkId)
        )
      );
    return row ? (parseCitationIntegrityChecks([row])[0] ?? null) : null;
  }

  async correctIntegrity(
    input: CorrectCitationInput
  ): Promise<{ check: CitationIntegrityCheck; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const [previous] = await transaction
        .select()
        .from(citationIntegrityChecks)
        .where(
          and(
            eq(citationIntegrityChecks.sessionId, input.sessionId),
            eq(citationIntegrityChecks.id, input.targetId)
          )
        );
      if (!previous) {
        throw new CitationCheckNotFoundError(input.targetId);
      }
      // Only the pointer moves. The superseded row keeps its conclusion.
      await transaction
        .update(citationIntegrityChecks)
        .set({ isCurrent: false })
        .where(eq(citationIntegrityChecks.id, previous.id));

      await transaction.insert(citationIntegrityChecks).values({
        id: input.newId,
        sessionId: input.sessionId,
        evidenceId: previous.evidenceId,
        sourceId: previous.sourceId,
        snapshotId: previous.snapshotId,
        status: input.status,
        matchKind: previous.matchKind,
        anchorText: previous.anchorText,
        expectedContentHash: previous.expectedContentHash,
        snapshotContentHash: previous.snapshotContentHash,
        matchedText: previous.matchedText,
        contextText: previous.contextText,
        reason: input.rationale,
        origin: "human",
        actor: input.actor,
        supersedesId: previous.id,
        isCurrent: true,
        createdAt: new Date().toISOString()
      });

      const [row] = await transaction
        .select()
        .from(citationIntegrityChecks)
        .where(eq(citationIntegrityChecks.id, input.newId));
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { check: parseCitationIntegrityChecks([row!])[0]!, event };
    });
  }

  /* ---------------- B. support ---------------- */

  async recordAssessments(
    input: RecordAssessmentsInput
  ): Promise<{
    assessments: ClaimSupportAssessment[];
    event: ExecutionEvent;
  }> {
    return this.database.transaction(async (transaction) => {
      const createdAt = new Date().toISOString();
      const created: ClaimSupportAssessment[] = [];

      for (const assessment of input.assessments) {
        const [previous] = await transaction
          .select()
          .from(claimSupportAssessments)
          .where(
            and(
              eq(claimSupportAssessments.claimId, assessment.claimId),
              eq(claimSupportAssessments.evidenceId, assessment.evidenceId),
              eq(claimSupportAssessments.isCurrent, true)
            )
          );
        if (previous) {
          await transaction
            .update(claimSupportAssessments)
            .set({ isCurrent: false })
            .where(eq(claimSupportAssessments.id, previous.id));
        }

        await transaction.insert(claimSupportAssessments).values({
          id: assessment.id,
          sessionId: input.sessionId,
          claimId: assessment.claimId,
          evidenceId: assessment.evidenceId,
          status: assessment.status,
          ...(assessment.confidence === null ||
          assessment.confidence === undefined
            ? {}
            : { confidence: String(assessment.confidence) }),
          rationale: assessment.rationale,
          ...(assessment.matchedExcerpt
            ? { matchedExcerpt: assessment.matchedExcerpt }
            : {}),
          matchedExcerptLocated: assessment.matchedExcerptLocated,
          signals: assessment.signals ?? [],
          ...(assessment.provider ? { provider: assessment.provider } : {}),
          ...(assessment.model ? { model: assessment.model } : {}),
          promptVersion: assessment.promptVersion,
          origin: assessment.origin,
          actor: assessment.actor,
          ...(previous ? { supersedesId: previous.id } : {}),
          isCurrent: true,
          createdAt
        });

        const [row] = await transaction
          .select()
          .from(claimSupportAssessments)
          .where(eq(claimSupportAssessments.id, assessment.id));
        if (row) {
          created.push(parseClaimSupportAssessments([row])[0]!);
        }
      }

      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { assessments: created, event };
    });
  }

  /** Current assessment per (claim, excerpt) for a whole session. */
  async listCurrentAssessments(
    sessionId: string
  ): Promise<ClaimSupportAssessment[]> {
    const rows = await this.database
      .select()
      .from(claimSupportAssessments)
      .where(
        and(
          eq(claimSupportAssessments.sessionId, sessionId),
          eq(claimSupportAssessments.isCurrent, true)
        )
      )
      .orderBy(asc(claimSupportAssessments.createdAt));
    return parseClaimSupportAssessments(rows);
  }

  /** Current assessments for one claim, newest first. */
  async listAssessmentsForClaim(
    sessionId: string,
    claimId: string
  ): Promise<ClaimSupportAssessment[]> {
    const rows = await this.database
      .select()
      .from(claimSupportAssessments)
      .where(
        and(
          eq(claimSupportAssessments.sessionId, sessionId),
          eq(claimSupportAssessments.claimId, claimId),
          eq(claimSupportAssessments.isCurrent, true)
        )
      )
      .orderBy(desc(claimSupportAssessments.createdAt));
    return parseClaimSupportAssessments(rows);
  }

  /** Everything ever concluded about one (claim, excerpt) pair, oldest first. */
  async listAssessmentHistory(
    sessionId: string,
    claimId: string,
    evidenceId: string
  ): Promise<ClaimSupportAssessment[]> {
    const rows = await this.database
      .select()
      .from(claimSupportAssessments)
      .where(
        and(
          eq(claimSupportAssessments.sessionId, sessionId),
          eq(claimSupportAssessments.claimId, claimId),
          eq(claimSupportAssessments.evidenceId, evidenceId)
        )
      )
      .orderBy(asc(claimSupportAssessments.createdAt));
    return parseClaimSupportAssessments(rows);
  }

  async getAssessment(
    sessionId: string,
    assessmentId: string
  ): Promise<ClaimSupportAssessment | null> {
    const [row] = await this.database
      .select()
      .from(claimSupportAssessments)
      .where(
        and(
          eq(claimSupportAssessments.sessionId, sessionId),
          eq(claimSupportAssessments.id, assessmentId)
        )
      );
    return row ? (parseClaimSupportAssessments([row])[0] ?? null) : null;
  }

  async correctAssessment(
    input: CorrectCitationInput
  ): Promise<{
    assessment: ClaimSupportAssessment;
    event: ExecutionEvent;
  }> {
    return this.database.transaction(async (transaction) => {
      const [previous] = await transaction
        .select()
        .from(claimSupportAssessments)
        .where(
          and(
            eq(claimSupportAssessments.sessionId, input.sessionId),
            eq(claimSupportAssessments.id, input.targetId)
          )
        );
      if (!previous) {
        throw new SupportAssessmentNotFoundError(input.targetId);
      }
      await transaction
        .update(claimSupportAssessments)
        .set({ isCurrent: false })
        .where(eq(claimSupportAssessments.id, previous.id));

      await transaction.insert(claimSupportAssessments).values({
        id: input.newId,
        sessionId: input.sessionId,
        claimId: previous.claimId,
        evidenceId: previous.evidenceId,
        status: input.status,
        confidence: previous.confidence,
        rationale: input.rationale,
        matchedExcerpt: previous.matchedExcerpt,
        matchedExcerptLocated: previous.matchedExcerptLocated,
        signals: previous.signals,
        provider: previous.provider,
        model: previous.model,
        promptVersion: previous.promptVersion,
        origin: "human",
        actor: input.actor,
        supersedesId: previous.id,
        isCurrent: true,
        createdAt: new Date().toISOString()
      });

      const [row] = await transaction
        .select()
        .from(claimSupportAssessments)
        .where(eq(claimSupportAssessments.id, input.newId));
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { assessment: parseClaimSupportAssessments([row!])[0]!, event };
    });
  }
}
