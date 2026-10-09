import { and, desc, eq, inArray } from "drizzle-orm";
import {
  type Claim,
  type Conflict,
  type Evidence,
  type ExecutionEvent,
  type Source,
  type EvidenceVerificationPatch
} from "@nexus/shared";
import type { Database } from "../client";
import { claims, conflicts, evidence, sources } from "../schema";
import { appendEvent, type AppendEventInput, type DbExecutor } from "./append-event";
import {
  parseClaims,
  parseConflicts,
  parseEvidence,
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

  async createSource(source: Source): Promise<Source> {
    const [existing] = await this.database
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

    const [created] = await this.database
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
        createdBy: source.createdBy,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt
      })
      .returning();
    return parseSources([created!])[0]!;
  }

  async listSources(sessionId: string): Promise<Source[]> {
    const rows = await this.database
      .select()
      .from(sources)
      .where(eq(sources.sessionId, sessionId));
    return parseSources(rows);
  }

  async getSource(sessionId: string, sourceId: string): Promise<Source | null> {
    const [row] = await this.database
      .select()
      .from(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.sessionId, sessionId)))
      .limit(1);
    return row ? (parseSources([row])[0] ?? null) : null;
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
   * from, the claims it bears on, and the conflicts those claims are part of.
   */
  async getEvidenceContext(
    sessionId: string,
    evidenceId: string
  ): Promise<{
    evidence: Evidence;
    source: Source | null;
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
    return {
      evidence: item,
      source,
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
