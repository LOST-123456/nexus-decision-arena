import { and, asc, desc, eq } from "drizzle-orm";
import {
  type ExecutionEvent,
  newId,
  type TranslationRecord,
  type TranslationReview
} from "@nexus/shared";
import type { Database } from "../client";
import { translations, translationReviews } from "../schema";
import {
  appendEvent,
  type AppendEventInput,
  type ReadExecutor
} from "./append-event";
import {
  parseTranslationReviews,
  parseTranslations
} from "./domain-mapper";

/** A translation a caller wants persisted (server fills nothing extra). */
export type CreateTranslationInput = {
  translationId: string;
  sessionId: string;
  sourceSnapshotId: string;
  sourceLanguage: string;
  targetLanguage: string;
  textHash: string;
  translatedText: string;
  segmentMappings: readonly unknown[];
  provider: string;
  model: string;
  status: string;
  failureReason?: string | null;
  failureCode?: string | null;
  createdBy: string;
  /** Appended in the same transaction as the insert when provided. */
  event?: AppendEventInput;
};

/** The cache/dedup key: identical input reuses the same translation row. */
export type TranslationDedupKey = {
  sourceSnapshotId: string;
  sourceLanguage: string;
  targetLanguage: string;
  textHash: string;
  provider: string;
  model: string;
};

export type RecordTranslationReviewInput = {
  sessionId: string;
  translationId: string;
  reviewedBy: string;
  action: string;
  reviewStatus: string;
  correctionText?: string | null | undefined;
  note?: string | null | undefined;
  event: AppendEventInput;
};

/**
 * Translations and their human reviews.
 *
 * Two rules this repository keeps:
 *   1. A translation is auxiliary and tied to one snapshot version. It is never
 *      edited in place; a re-translation is a distinct row keyed by a different
 *      text hash / provider / model, so an old translation can never be
 *      mistaken for the current version's.
 *   2. Nothing here writes `evidence`, `evidence.verification_status`, a
 *      `claim_review` or a `claim_verdict`. A review records what a person
 *      decided about a translation; it cannot promote or demote any evidence.
 *
 * Cross-session isolation is structural: every read filters on `session_id`, so
 * a translation belonging to another session simply is not found.
 */
export class TranslationRepository {
  constructor(private readonly database: Database) {}

  async findCached(
    key: TranslationDedupKey,
    executor: ReadExecutor = this.database
  ): Promise<TranslationRecord | null> {
    const [row] = await executor
      .select()
      .from(translations)
      .where(
        and(
          eq(translations.sourceSnapshotId, key.sourceSnapshotId),
          eq(translations.sourceLanguage, key.sourceLanguage),
          eq(translations.targetLanguage, key.targetLanguage),
          eq(translations.textHash, key.textHash),
          eq(translations.provider, key.provider),
          eq(translations.model, key.model)
        )
      )
      .limit(1);
    return row ? parseTranslations([row])[0]! : null;
  }

  async createTranslation(
    input: CreateTranslationInput
  ): Promise<{ translation: TranslationRecord; event?: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      await transaction.insert(translations).values({
        id: input.translationId,
        sessionId: input.sessionId,
        sourceSnapshotId: input.sourceSnapshotId,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        textHash: input.textHash,
        translatedText: input.translatedText,
        segmentMappings: input.segmentMappings as unknown,
        provider: input.provider,
        model: input.model,
        status: input.status,
        failureReason: input.failureReason ?? null,
        failureCode: input.failureCode ?? null,
        createdBy: input.createdBy,
        createdAt: new Date().toISOString()
      });
      const [row] = await transaction
        .select()
        .from(translations)
        .where(eq(translations.id, input.translationId));
      const event = input.event
        ? await appendEvent(transaction, input.sessionId, input.event)
        : undefined;
      return {
        translation: parseTranslations([row!])[0]!,
        // Spread rather than assign: with exactOptionalPropertyTypes an
        // explicit `event: undefined` is not the same as an absent key.
        ...(event ? { event } : {})
      };
    });
  }

  async getTranslation(
    sessionId: string,
    translationId: string,
    executor: ReadExecutor = this.database
  ): Promise<TranslationRecord | null> {
    const [row] = await executor
      .select()
      .from(translations)
      .where(
        and(eq(translations.sessionId, sessionId), eq(translations.id, translationId))
      )
      .limit(1);
    return row ? parseTranslations([row])[0]! : null;
  }

  async listTranslationsForSnapshot(
    sessionId: string,
    sourceSnapshotId: string,
    executor: ReadExecutor = this.database
  ): Promise<TranslationRecord[]> {
    const rows = await executor
      .select()
      .from(translations)
      .where(
        and(
          eq(translations.sessionId, sessionId),
          eq(translations.sourceSnapshotId, sourceSnapshotId)
        )
      )
      .orderBy(asc(translations.createdAt));
    return parseTranslations(rows);
  }

  /** Every stored translation in a session, newest first. */
  async listSessionTranslations(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<TranslationRecord[]> {
    const rows = await executor
      .select()
      .from(translations)
      .where(eq(translations.sessionId, sessionId))
      .orderBy(desc(translations.createdAt));
    return parseTranslations(rows);
  }

  async recordReview(
    input: RecordTranslationReviewInput
  ): Promise<{ review: TranslationReview; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const reviewId = newId();
      await transaction.insert(translationReviews).values({
        id: reviewId,
        sessionId: input.sessionId,
        translationId: input.translationId,
        reviewedBy: input.reviewedBy,
        action: input.action,
        reviewStatus: input.reviewStatus,
        correctionText: input.correctionText ?? null,
        note: input.note ?? null,
        createdAt: new Date().toISOString()
      });
      const [row] = await transaction
        .select()
        .from(translationReviews)
        .where(eq(translationReviews.id, reviewId));
      const event = await appendEvent(transaction, input.sessionId, input.event);
      return { review: parseTranslationReviews([row!])[0]!, event };
    });
  }

  async listReviews(
    sessionId: string,
    translationId: string,
    executor: ReadExecutor = this.database
  ): Promise<TranslationReview[]> {
    const rows = await executor
      .select()
      .from(translationReviews)
      .where(
        and(
          eq(translationReviews.sessionId, sessionId),
          eq(translationReviews.translationId, translationId)
        )
      )
      .orderBy(asc(translationReviews.createdAt));
    return parseTranslationReviews(rows);
  }

  /**
   * Every review in a session, oldest first.
   *
   * One query rather than one per translation, so a report summary never does
   * an N+1 walk over the session's translations.
   */
  async listSessionReviews(
    sessionId: string,
    executor: ReadExecutor = this.database
  ): Promise<TranslationReview[]> {
    const rows = await executor
      .select()
      .from(translationReviews)
      .where(eq(translationReviews.sessionId, sessionId))
      .orderBy(asc(translationReviews.createdAt));
    return parseTranslationReviews(rows);
  }
}
