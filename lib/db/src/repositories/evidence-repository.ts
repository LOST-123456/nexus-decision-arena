import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type Claim,
  type Conflict,
  type Evidence,
  type ExecutionEvent,
  type Source,
  type SourceSnapshot,
  type EvidenceVerificationPatch
} from "@nexus/shared";
import type { Database } from "../client";
import { claims, conflicts, evidence, sourceSnapshots, sources } from "../schema";
import { appendEvent, type AppendEventInput, type DbExecutor } from "./append-event";
import {
  parseClaims,
  parseConflicts,
  parseEvidence,
  parseSourceSnapshots,
  parseSources
} from "./domain-mapper";
import { evidenceCoversAnyClaim, evidenceCoversClaim } from "./evidence-link";

export class SourceNotFoundError extends Error {
  constructor(sourceId: string) {
    super(`Source not found: ${sourceId}`);
    this.name = "SourceNotFoundError";
  }
}

export class EvidenceNotFoundError extends Error {
  constructor(evidenceId: string) {
    super(`Evidence not found: ${evidenceId}`);
    this.name = "EvidenceNotFoundError";
  }
}

export class ClaimLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimLinkError";
  }
}

export class SourceTitleConflictError extends Error {
  constructor(title: string) {
    super(`A source named "${title}" already exists in this research.`);
    this.name = "SourceTitleConflictError";
  }
}

type EventInput = AppendEventInput;

/**
 * Sources and evidence for the research workflow.
 *
 * `evidence.claim_ids` is a jsonb array, so it carries no foreign key. Every
 * write path therefore checks membership against the session's own claims
 * before persisting, otherwise an excerpt could end up pointing at a claim
 * from another research task (or at nothing at all).
 */
export class EvidenceRepository {
  constructor(private readonly database: Database) {}

  /**
   * Registers a source.
   *
   * When an `event` is supplied it is written in the same transaction as the
   * row, so a registration can never exist without its audit trail.
   */
  async createSource(
    source: Source,
    event?: EventInput
  ): Promise<{ source: Source; event: ExecutionEvent | null }> {
    return this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.sessionId, source.sessionId),
            eq(sources.title, source.title)
          )
        )
        .limit(1);
      if (existing) {
        throw new SourceTitleConflictError(source.title);
      }

      const [created] = await transaction
        .insert(sources)
        .values({
        id: source.id,
        sessionId: source.sessionId,
        title: source.title,
        kind: source.kind,
        ...(source.url ? { url: source.url } : {}),
        ...(source.publisher ? { publisher: source.publisher } : {}),
        ...(source.author ? { author: source.author } : {}),
        ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
        ...(source.note ? { note: source.note } : {}),
        ...(source.canonicalUrl ? { canonicalUrl: source.canonicalUrl } : {}),
        ...(source.retrievalStatus
          ? { retrievalStatus: source.retrievalStatus }
          : {}),
        ...(source.retrievalAttempts !== undefined
          ? { retrievalAttempts: source.retrievalAttempts }
          : {}),
        ...(source.retrievedAt ? { retrievedAt: source.retrievedAt } : {}),
        ...(source.retrievalError
          ? { retrievalError: source.retrievalError }
          : {}),
        ...(source.contentType ? { contentType: source.contentType } : {}),
        ...(source.contentHash ? { contentHash: source.contentHash } : {}),
        ...(source.contentBytes !== undefined
          ? { contentBytes: source.contentBytes }
          : {}),
        createdBy: source.createdBy,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt
      })
        .returning();

      const appended = event
        ? await appendEvent(transaction, source.sessionId, event)
        : null;

      return {
        source: parseSources([created!])[0]!,
        event: appended
      };
    });
  }

  async listSources(sessionId: string): Promise<Source[]> {
    const rows = await this.database
      .select()
      .from(sources)
      .where(eq(sources.sessionId, sessionId));
    return parseSources(rows);
  }

  /**
   * Looks a source up by its normalized url.
   *
   * This is what makes a repeated import a no-op: the same page imported twice
   * resolves to the row that already exists rather than a near-duplicate.
   */
  async findSourceByCanonicalUrl(
    sessionId: string,
    canonicalUrl: string
  ): Promise<Source | null> {
    const [row] = await this.database
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.sessionId, sessionId),
          eq(sources.canonicalUrl, canonicalUrl)
        )
      )
      .limit(1);
    return row ? (parseSources([row])[0] ?? null) : null;
  }

  async getSource(sessionId: string, sourceId: string): Promise<Source | null> {
    const [row] = await this.database
      .select()
      .from(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.sessionId, sessionId)))
      .limit(1);
    return row ? (parseSources([row])[0] ?? null) : null;
  }

  /**
   * Records a retrieval that produced readable text.
   *
   * The snapshot is appended and the source is pointed at it in one
   * transaction: a page that changed gains a version, and the older row is kept
   * so an excerpt confirmed against the previous text can still be re-checked.
   * Re-capturing the *same* text is not a new version, but it still counts as
   * an attempt and refreshes the retrieval facts.
   */
  async recordRetrievalSuccess(input: {
    snapshot: SourceSnapshot;
    /** Facts copied onto the source so a list view needs no join. */
    source: {
      title?: string | undefined;
      author?: string | undefined;
      publisher?: string | undefined;
      publishedAt?: string | undefined;
    };
    event: EventInput;
  }): Promise<{
    source: Source;
    snapshot: SourceSnapshot;
    /** False when this capture repeated text that was already stored. */
    created: boolean;
    event: ExecutionEvent;
  }> {
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.id, input.snapshot.sourceId),
            eq(sources.sessionId, input.snapshot.sessionId)
          )
        )
        .limit(1);
      if (!current) {
        throw new SourceNotFoundError(input.snapshot.sourceId);
      }

      const inserted = await transaction
        .insert(sourceSnapshots)
        .values({
          id: input.snapshot.id,
          sessionId: input.snapshot.sessionId,
          sourceId: input.snapshot.sourceId,
          canonicalUrl: input.snapshot.canonicalUrl,
          contentHash: input.snapshot.contentHash,
          ...(input.snapshot.title ? { title: input.snapshot.title } : {}),
          ...(input.snapshot.author ? { author: input.snapshot.author } : {}),
          ...(input.snapshot.publisher
            ? { publisher: input.snapshot.publisher }
            : {}),
          ...(input.snapshot.publishedAt
            ? { publishedAt: input.snapshot.publishedAt }
            : {}),
          contentType: input.snapshot.contentType,
          content: input.snapshot.content,
          contentBytes: input.snapshot.contentBytes,
          charCount: input.snapshot.charCount,
          retrievedAt: input.snapshot.retrievedAt,
          createdAt: input.snapshot.createdAt
        })
        .onConflictDoNothing({
          target: [sourceSnapshots.sourceId, sourceSnapshots.contentHash]
        })
        .returning();

      const [updated] = await transaction
        .update(sources)
        .set({
          retrievalStatus: "fetched",
          retrievalAttempts: (current.retrievalAttempts ?? 0) + 1,
          retrievedAt: input.snapshot.retrievedAt,
          retrievalError: null,
          contentType: input.snapshot.contentType,
          contentHash: input.snapshot.contentHash,
          contentBytes: input.snapshot.contentBytes,
          // Metadata read off the page fills blanks but never overwrites what a
          // researcher typed, so an import cannot silently rewrite a citation.
          ...(current.title.trim() === "" && input.snapshot.title
            ? { title: input.snapshot.title }
            : {}),
          ...(!current.author && input.source.author
            ? { author: input.source.author }
            : {}),
          ...(!current.publisher && input.source.publisher
            ? { publisher: input.source.publisher }
            : {}),
          ...(!current.publishedAt && input.source.publishedAt
            ? { publishedAt: input.source.publishedAt }
            : {}),
          updatedAt: input.snapshot.createdAt
        })
        .where(eq(sources.id, input.snapshot.sourceId))
        .returning();

      const event = await appendEvent(
        transaction,
        input.snapshot.sessionId,
        input.event
      );

      return {
        source: parseSources([updated!])[0]!,
        snapshot: parseSourceSnapshots([inserted[0] ?? input.snapshot])[0]!,
        created: inserted.length > 0,
        event
      };
    });
  }

  /**
   * Records a retrieval that failed.
   *
   * The failure is persisted rather than reported and forgotten, so the
   * workspace can show why an import did not produce text and a researcher can
   * decide whether to retry.
   */
  async recordRetrievalFailure(input: {
    sessionId: string;
    sourceId: string;
    error: string;
    attemptedAt: string;
    event: EventInput;
  }): Promise<{ source: Source; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.id, input.sourceId),
            eq(sources.sessionId, input.sessionId)
          )
        )
        .limit(1);
      if (!current) {
        throw new SourceNotFoundError(input.sourceId);
      }

      const [updated] = await transaction
        .update(sources)
        .set({
          retrievalStatus: "failed",
          retrievalAttempts: (current.retrievalAttempts ?? 0) + 1,
          retrievalError: input.error,
          updatedAt: input.attemptedAt
        })
        .where(eq(sources.id, input.sourceId))
        .returning();

      const event = await appendEvent(transaction, input.sessionId, input.event);

      return { source: parseSources([updated!])[0]!, event };
    });
  }

  /** Snapshots for one source, newest first. */
  async listSnapshots(
    sessionId: string,
    sourceId: string
  ): Promise<SourceSnapshot[]> {
    const rows = await this.database
      .select()
      .from(sourceSnapshots)
      .where(
        and(
          eq(sourceSnapshots.sessionId, sessionId),
          eq(sourceSnapshots.sourceId, sourceId)
        )
      )
      .orderBy(desc(sourceSnapshots.retrievedAt));
    return parseSourceSnapshots(rows);
  }

  /** The capture the source currently points at, located by content hash. */
  async getCurrentSnapshot(
    sessionId: string,
    sourceId: string
  ): Promise<SourceSnapshot | null> {
    const [row] = await this.database
      .select()
      .from(sourceSnapshots)
      .where(
        and(
          eq(sourceSnapshots.sessionId, sessionId),
          eq(sourceSnapshots.sourceId, sourceId)
        )
      )
      .orderBy(desc(sourceSnapshots.retrievedAt))
      .limit(1);
    return row ? (parseSourceSnapshots([row])[0] ?? null) : null;
  }

  /** Excerpts drawn from one source, so drift can be reported per citation. */
  async listEvidenceForSource(
    sessionId: string,
    sourceId: string
  ): Promise<Evidence[]> {
    const rows = await this.database
      .select()
      .from(evidence)
      .where(
        and(
          eq(evidence.sessionId, sessionId),
          eq(evidence.sourceId, sourceId)
        )
      )
      .orderBy(desc(evidence.retrievedAt));
    return parseEvidence(rows);
  }

  async listEvidence(
    sessionId: string,
    filter: {
      claimId?: string;
      verificationStatus?: string;
      direction?: string;
    } = {}
  ): Promise<Evidence[]> {
    const conditions = [eq(evidence.sessionId, sessionId)];
    if (filter.claimId) {
      conditions.push(evidenceCoversClaim(evidence.claimIds, filter.claimId));
    }
    if (filter.verificationStatus) {
      conditions.push(eq(evidence.verificationStatus, filter.verificationStatus));
    }
    if (filter.direction) {
      conditions.push(eq(evidence.direction, filter.direction));
    }
    const rows = await this.database
      .select()
      .from(evidence)
      .where(and(...conditions))
      .orderBy(desc(evidence.retrievedAt));
    return parseEvidence(rows);
  }

  async getEvidence(
    sessionId: string,
    evidenceId: string
  ): Promise<Evidence | null> {
    const [row] = await this.database
      .select()
      .from(evidence)
      .where(and(eq(evidence.id, evidenceId), eq(evidence.sessionId, sessionId)))
      .limit(1);
    return row ? (parseEvidence([row])[0] ?? null) : null;
  }

  /** Conflicts that touch any claim this excerpt bears on. */
  async listConflictsForClaimIds(
    sessionId: string,
    claimIds: readonly string[]
  ): Promise<Conflict[]> {
    if (claimIds.length === 0) {
      return [];
    }
    const rows = await this.database
      .select()
      .from(conflicts)
      .where(
        and(
          eq(conflicts.sessionId, sessionId),
          evidenceCoversAnyClaim(conflicts.claimIds, claimIds)
        )
      );
    return parseConflicts(rows);
  }

  private async assertClaimsBelongToSession(
    transaction: DbExecutor,
    sessionId: string,
    claimIds: readonly string[]
  ): Promise<void> {
    if (claimIds.length === 0) {
      throw new ClaimLinkError("Evidence must be linked to at least one claim.");
    }
    const unique = [...new Set(claimIds)];
    const rows = await transaction
      .select({ id: claims.id })
      .from(claims)
      .where(and(eq(claims.sessionId, sessionId), inArray(claims.id, unique)));
    const found = new Set(rows.map((row) => row.id));
    const missing = unique.filter((claimId) => !found.has(claimId));
    if (missing.length > 0) {
      throw new ClaimLinkError(
        `Claim(s) not part of this research: ${missing.join(", ")}`
      );
    }
  }

  private async assertSourceBelongsToSession(
    transaction: DbExecutor,
    sessionId: string,
    sourceId: string
  ): Promise<void> {
    const [row] = await transaction
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.sessionId, sessionId)))
      .limit(1);
    if (!row) {
      throw new SourceNotFoundError(sourceId);
    }
  }

  async createEvidence(input: {
    evidence: Evidence;
    event: EventInput;
  }): Promise<{ evidence: Evidence; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      await this.assertClaimsBelongToSession(
        transaction,
        input.evidence.sessionId,
        input.evidence.claimIds
      );
      if (input.evidence.sourceId) {
        await this.assertSourceBelongsToSession(
          transaction,
          input.evidence.sessionId,
          input.evidence.sourceId
        );
      }

      const [created] = await transaction
        .insert(evidence)
        .values({
          id: input.evidence.id,
          sessionId: input.evidence.sessionId,
          claimIds: input.evidence.claimIds,
          kind: input.evidence.kind,
          title: input.evidence.title,
          content: input.evidence.content,
          description: input.evidence.description,
          ...(input.evidence.sourceId
            ? { sourceId: input.evidence.sourceId }
            : {}),
          ...(input.evidence.sourceRef
            ? { sourceRef: input.evidence.sourceRef }
            : {}),
          ...(input.evidence.locator ? { locator: input.evidence.locator } : {}),
          ...(input.evidence.locatorKind
            ? { locatorKind: input.evidence.locatorKind }
            : {}),
          ...(input.evidence.locatorStatus
            ? { locatorStatus: input.evidence.locatorStatus }
            : {}),
          ...(input.evidence.anchorText
            ? { anchorText: input.evidence.anchorText }
            : {}),
          ...(input.evidence.sourceContentHash
            ? { sourceContentHash: input.evidence.sourceContentHash }
            : {}),
          direction: input.evidence.direction,
          reliability: input.evidence.reliability,
          verificationStatus: input.evidence.verificationStatus,
          ...(input.evidence.verifiedBy
            ? { verifiedBy: input.evidence.verifiedBy }
            : {}),
          ...(input.evidence.verifiedAt
            ? { verifiedAt: input.evidence.verifiedAt }
            : {}),
          ...(input.evidence.verificationNote
            ? { verificationNote: input.evidence.verificationNote }
            : {}),
          ...(input.evidence.validityPeriod
            ? { validityPeriod: input.evidence.validityPeriod }
            : {}),
          retrievedAt: input.evidence.retrievedAt,
          createdBy: input.evidence.createdBy,
          ...(input.evidence.agentRunId
            ? { agentRunId: input.evidence.agentRunId }
            : {})
        })
        .returning();

      const event = await appendEvent(
        transaction,
        input.evidence.sessionId,
        input.event
      );

      return { evidence: parseEvidence([created!])[0]!, event };
    });
  }

  /** Edits the recorded excerpt, its metadata and its claim links. */
  async updateEvidence(input: {
    sessionId: string;
    evidenceId: string;
    /** Fields a researcher may revise. Every field is optional and `undefined`
     *  means "leave alone", so the signature accepts the parsed request as-is. */
    patch: {
      title?: string | undefined;
      content?: string | undefined;
      description?: string | undefined;
      locator?: string | undefined;
      locatorKind?: Evidence["locatorKind"] | undefined;
      locatorStatus?: Evidence["locatorStatus"] | undefined;
      anchorText?: string | undefined;
      sourceContentHash?: string | undefined;
      direction?: Evidence["direction"] | undefined;
      reliability?: number | undefined;
      sourceId?: string | undefined;
      sourceRef?: string | undefined;
      claimIds?: string[] | undefined;
      validityPeriod?: Evidence["validityPeriod"] | undefined;
    };
    event: EventInput;
  }): Promise<{ evidence: Evidence; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.id, input.evidenceId),
            eq(evidence.sessionId, input.sessionId)
          )
        )
        .limit(1);
      if (!current) {
        throw new EvidenceNotFoundError(input.evidenceId);
      }

      const nextClaimIds = input.patch.claimIds ?? (current.claimIds as string[]);
      await this.assertClaimsBelongToSession(
        transaction,
        input.sessionId,
        nextClaimIds
      );

      const nextSourceId =
        input.patch.sourceId === undefined
          ? current.sourceId
          : input.patch.sourceId;
      if (nextSourceId) {
        await this.assertSourceBelongsToSession(
          transaction,
          input.sessionId,
          nextSourceId
        );
      }

      const [updated] = await transaction
        .update(evidence)
        .set({
          ...(input.patch.title !== undefined
            ? { title: input.patch.title }
            : {}),
          ...(input.patch.content !== undefined
            ? { content: input.patch.content }
            : {}),
          ...(input.patch.description !== undefined
            ? { description: input.patch.description }
            : {}),
          ...(input.patch.locator !== undefined
            ? { locator: input.patch.locator }
            : {}),
          ...(input.patch.locatorKind !== undefined
            ? { locatorKind: input.patch.locatorKind }
            : {}),
          ...(input.patch.locatorStatus !== undefined
            ? { locatorStatus: input.patch.locatorStatus }
            : {}),
          ...(input.patch.anchorText !== undefined
            ? { anchorText: input.patch.anchorText }
            : {}),
          ...(input.patch.sourceContentHash !== undefined
            ? { sourceContentHash: input.patch.sourceContentHash }
            : {}),
          ...(input.patch.direction !== undefined
            ? { direction: input.patch.direction }
            : {}),
          ...(input.patch.reliability !== undefined
            ? { reliability: input.patch.reliability }
            : {}),
          ...(input.patch.sourceId !== undefined
            ? { sourceId: input.patch.sourceId }
            : {}),
          ...(input.patch.sourceRef !== undefined
            ? { sourceRef: input.patch.sourceRef }
            : {}),
          ...(input.patch.claimIds !== undefined
            ? { claimIds: input.patch.claimIds }
            : {}),
          ...(input.patch.validityPeriod !== undefined
            ? { validityPeriod: input.patch.validityPeriod }
            : {})
        })
        .where(eq(evidence.id, input.evidenceId))
        .returning();

      const event = await appendEvent(
        transaction,
        input.sessionId,
        input.event
      );

      return { evidence: parseEvidence([updated!])[0]!, event };
    });
  }

  /**
   * Applies a verification decision. The caller has already validated the
   * transition through `planEvidenceVerification`, so this only persists it
   * together with its audit event.
   */
  async setVerification(input: {
    sessionId: string;
    evidenceId: string;
    patch: EvidenceVerificationPatch;
    event: EventInput;
  }): Promise<{ evidence: Evidence; event: ExecutionEvent }> {
    return this.database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.id, input.evidenceId),
            eq(evidence.sessionId, input.sessionId)
          )
        )
        .limit(1);
      if (!current) {
        throw new EvidenceNotFoundError(input.evidenceId);
      }

      const [updated] = await transaction
        .update(evidence)
        .set({
          verificationStatus: input.patch.verificationStatus,
          verifiedBy: input.patch.verifiedBy,
          verifiedAt: input.patch.verifiedAt,
          verificationNote: input.patch.verificationNote
        })
        .where(eq(evidence.id, input.evidenceId))
        .returning();

      const event = await appendEvent(
        transaction,
        input.sessionId,
        input.event
      );

      return { evidence: parseEvidence([updated!])[0]!, event };
    });
  }

  /**
   * Everything the evidence detail panel needs: the excerpt, the source it came
   * from, the stored text it can be checked against, the claims it bears on, and
   * the conflicts those claims are part of.
   */
  async getEvidenceContext(
    sessionId: string,
    evidenceId: string
  ): Promise<{
    evidence: Evidence;
    source: Source | null;
    snapshot: SourceSnapshot | null;
    claims: Claim[];
    conflicts: Conflict[];
  } | null> {
    const item = await this.getEvidence(sessionId, evidenceId);
    if (!item) {
      return null;
    }
    const claimIds = item.claimIds;
    const [claimRows, conflictRows, source] = await Promise.all([
      claimIds.length > 0
        ? this.database
            .select()
            .from(claims)
            .where(
              and(eq(claims.sessionId, sessionId), inArray(claims.id, claimIds))
            )
        : Promise.resolve([]),
      this.listConflictsForClaimIds(sessionId, claimIds),
      item.sourceId ? this.getSource(sessionId, item.sourceId) : Promise.resolve(null)
    ]);
    const snapshot = item.sourceId
      ? await this.getCurrentSnapshot(sessionId, item.sourceId)
      : null;
    return {
      evidence: item,
      source,
      snapshot,
      claims: parseClaims(claimRows),
      conflicts: conflictRows
    };
  }

  async listEvidenceForClaim(
    sessionId: string,
    claimId: string
  ): Promise<Evidence[]> {
    const rows = await this.database
      .select()
      .from(evidence)
      .where(
        and(
          eq(evidence.sessionId, sessionId),
          evidenceCoversClaim(evidence.claimIds, claimId)
        )
      )
      .orderBy(desc(evidence.retrievedAt));
    return parseEvidence(rows);
  }
}
