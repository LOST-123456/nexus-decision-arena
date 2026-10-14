import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  newId,
  type ExecutionEvent,
  type ShareGrant,
  type ShareGrantDraft,
  type ShareGrantScope,
  type Source,
  type SourceSnapshot
} from "@nexus/shared";
import type { Database } from "../client";
import {
  decisionSessions,
  sourceCopies,
  sourceShareGrants,
  sourceSnapshots,
  sources,
  translations
} from "../schema";
import {
  appendEvent,
  type AppendEventInput,
  type DbExecutor
} from "./append-event";
import { parseSourceSnapshots, parseSources } from "./domain-mapper";

/**
 * Cross-research library storage: grants, copy lineage, and the authorized
 * reads that back them.
 *
 * Every method here either stays inside one session (like the rest of the
 * repository layer) or takes an explicit list of session ids the caller is
 * authorized for. Nothing in this file widens access on its own — the
 * authorization decision lives in the service, and this layer's job is to
 * make the authorized read and the lineage write atomic and attributable.
 */

/** One copied source as stored; the live origin status is derived on read. */
export type SourceCopyRow = {
  id: string;
  sessionId: string;
  sourceId: string;
  /**
   * Where the material came from. Kept even after the origin is unreachable —
   * unshared, or removed entirely — because this is the target research's
   * record of its own provenance, not a live reference.
   */
  originSessionId: string;
  originSourceId: string;
  /** Null for a reference copy: metadata only, no captured text to point at. */
  originSnapshotId: string | null;
  originSnapshotHash: string | null;
  copiedBy: string;
  copiedAt: string;
  forkState: "synced" | "forked";
  forkedAt: string | null;
};

export type LibrarySessionMeta = {
  sessionId: string;
  ownerUserId: string | null;
  researchQuestion: string | null;
  updatedAt: string;
  /**
   * Present only on a session reached through a grant, and only then: the
   * grant is what makes it visible, and its scope decides whether the holder
   * may also copy material out of it.
   */
  grantId?: string;
  grantScope?: ShareGrantScope;
};

/** A source the caller may browse, joined with its snapshot aggregates. */
export type LibrarySourceRow = {
  source: Source;
  snapshotCount: number;
  latestSnapshotAt: string | null;
  latestContentHash: string | null;
  languages: string[];
};

export class GrantNotFoundError extends Error {
  constructor(grantId: string) {
    super(`Share grant not found: ${grantId}`);
    this.name = "GrantNotFoundError";
  }
}

export class GrantAlreadyExistsError extends Error {
  constructor() {
    super("An active grant for this subject and scope already exists.");
    this.name = "GrantAlreadyExistsError";
  }
}

export class GrantAlreadyRevokedError extends Error {
  constructor() {
    super("This grant is already revoked.");
    this.name = "GrantAlreadyRevokedError";
  }
}

/**
 * The target research already holds this material. Carries the existing row
 * so the caller can be pointed at it rather than told "duplicate" with no
 * way forward.
 */
export class LibraryDuplicateSourceError extends Error {
  constructor(
    readonly detail: {
      sourceId: string;
      title: string;
      canonicalUrl: string | null;
      reason: "canonical_url" | "title";
    }
  ) {
    super(
      detail.reason === "canonical_url"
        ? "This research already holds a source with the same canonical url."
        : `A source named "${detail.title}" already exists in this research.`
    );
    this.name = "LibraryDuplicateSourceError";
  }
}

function parseGrant(row: unknown): ShareGrant {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    sessionId: String(value.sessionId),
    subjectType: value.subjectType as ShareGrant["subjectType"],
    subjectId: String(value.subjectId),
    scope: value.scope as ShareGrantScope,
    grantedBy: String(value.grantedBy),
    grantedAt: new Date(String(value.grantedAt)).toISOString(),
    ...(value.revokedAt
      ? { revokedAt: new Date(String(value.revokedAt)).toISOString() }
      : {}),
    ...(value.revokedBy ? { revokedBy: String(value.revokedBy) } : {}),
    ...(value.revokeReason ? { revokeReason: String(value.revokeReason) } : {})
  };
}

function parseCopy(row: unknown): SourceCopyRow {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    sessionId: String(value.sessionId),
    sourceId: String(value.sourceId),
    originSessionId: String(value.originSessionId),
    originSourceId: String(value.originSourceId),
    originSnapshotId:
      value.originSnapshotId === null || value.originSnapshotId === undefined
        ? null
        : String(value.originSnapshotId),
    originSnapshotHash:
      value.originSnapshotHash === null ||
      value.originSnapshotHash === undefined
        ? null
        : String(value.originSnapshotHash),
    copiedBy: String(value.copiedBy),
    copiedAt: new Date(String(value.copiedAt)).toISOString(),
    forkState: value.forkState as SourceCopyRow["forkState"],
    forkedAt: value.forkedAt
      ? new Date(String(value.forkedAt)).toISOString()
      : null
  };
}

export class SourceLibraryRepository {
  constructor(private readonly database: Database) {}

  /**
   * Sessions the caller may browse: the ones they own plus the ones they hold
   * a live grant for (directly or through their role).
   */
  async listAuthorizedSessions(
    userId: string,
    role: string
  ): Promise<{ own: LibrarySessionMeta[]; granted: LibrarySessionMeta[] }> {
    const ownRows = await this.database
      .select({
        sessionId: decisionSessions.id,
        ownerUserId: decisionSessions.ownerUserId,
        researchQuestion: decisionSessions.researchQuestion,
        updatedAt: decisionSessions.updatedAt
      })
      .from(decisionSessions)
      .where(eq(decisionSessions.ownerUserId, userId));

    const grantedRows = await this.database
      .selectDistinct({
        sessionId: decisionSessions.id,
        ownerUserId: decisionSessions.ownerUserId,
        researchQuestion: decisionSessions.researchQuestion,
        updatedAt: decisionSessions.updatedAt,
        grantId: sourceShareGrants.id,
        grantScope: sourceShareGrants.scope
      })
      .from(sourceShareGrants)
      .innerJoin(
        decisionSessions,
        eq(decisionSessions.id, sourceShareGrants.sessionId)
      )
      .where(
        and(
          sql`${sourceShareGrants.revokedAt} IS NULL`,
          sql`(${sourceShareGrants.subjectType} = 'user' AND ${sourceShareGrants.subjectId} = ${userId})
              OR (${sourceShareGrants.subjectType} = 'role' AND ${sourceShareGrants.subjectId} = ${role})`
        )
      );

    const toMeta = (row: {
      sessionId: string;
      ownerUserId: string | null;
      researchQuestion: string | null;
      updatedAt: unknown;
      grantId?: string | null;
      grantScope?: string | null;
    }): LibrarySessionMeta => ({
      sessionId: row.sessionId,
      ownerUserId: row.ownerUserId,
      researchQuestion: row.researchQuestion,
      updatedAt: new Date(String(row.updatedAt)).toISOString(),
      ...(row.grantId ? { grantId: row.grantId } : {}),
      ...(row.grantScope ? { grantScope: row.grantScope as ShareGrantScope } : {})
    });

    const own = ownRows.map(toMeta);
    const ownIds = new Set(own.map((row) => row.sessionId));
    return {
      own,
      // A grant on a session the caller also owns is ownership, not a grant;
      // showing it twice would imply the grant is what makes it visible.
      granted: grantedRows
        .map(toMeta)
        .filter((row) => !ownIds.has(row.sessionId))
    };
  }

  async getSessionMeta(sessionId: string): Promise<LibrarySessionMeta | null> {
    const [row] = await this.database
      .select({
        sessionId: decisionSessions.id,
        ownerUserId: decisionSessions.ownerUserId,
        researchQuestion: decisionSessions.researchQuestion,
        updatedAt: decisionSessions.updatedAt
      })
      .from(decisionSessions)
      .where(eq(decisionSessions.id, sessionId))
      .limit(1);
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      ownerUserId: row.ownerUserId,
      researchQuestion: row.researchQuestion,
      updatedAt: new Date(String(row.updatedAt)).toISOString()
    };
  }

  /**
   * Every session, newest first.
   *
   * Only for a deployment running without an identity system: there are no
   * users to authorize against, so the workspace operator sees the
   * workspace. With auth configured this is never called.
   */
  async listAllSessionMetas(): Promise<LibrarySessionMeta[]> {
    const rows = await this.database
      .select({
        sessionId: decisionSessions.id,
        ownerUserId: decisionSessions.ownerUserId,
        researchQuestion: decisionSessions.researchQuestion,
        updatedAt: decisionSessions.updatedAt
      })
      .from(decisionSessions)
      .orderBy(desc(decisionSessions.updatedAt));
    return rows.map((row) => ({
      sessionId: row.sessionId,
      ownerUserId: row.ownerUserId,
      researchQuestion: row.researchQuestion,
      updatedAt: new Date(String(row.updatedAt)).toISOString()
    }));
  }

  async countSourcesBySession(
    sessionIds: readonly string[]
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (sessionIds.length === 0) return counts;
    const rows = await this.database
      .select({
        sessionId: sources.sessionId,
        count: sql<number>`count(*)::int`
      })
      .from(sources)
      .where(inArray(sources.sessionId, [...sessionIds]))
      .groupBy(sources.sessionId);
    for (const row of rows) {
      counts.set(row.sessionId, row.count);
    }
    return counts;
  }

  /**
   * Searches sources inside the authorized sessions only.
   *
   * The caller's authorization is expressed as the session id list; there is
   * no code path that searches "everywhere", so a new filter can never
   * quietly become a cross-tenant dump.
   */
  async searchLibrarySources(input: {
    sessionIds: readonly string[];
    query?: string | undefined;
    publisher?: string | undefined;
    author?: string | undefined;
    domain?: string | undefined;
    publishedFrom?: string | undefined;
    publishedTo?: string | undefined;
    language?: string | undefined;
    sessionId?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<{ rows: LibrarySourceRow[]; total: number }> {
    if (input.sessionIds.length === 0) {
      return { rows: [], total: 0 };
    }

    const conditions = [inArray(sources.sessionId, [...input.sessionIds])];
    if (input.sessionId) {
      conditions.push(eq(sources.sessionId, input.sessionId));
    }
    if (input.publisher) {
      conditions.push(
        sql`${sources.publisher} ILIKE ${`%${input.publisher}%`}`
      );
    }
    if (input.author) {
      conditions.push(sql`${sources.author} ILIKE ${`%${input.author}%`}`);
    }
    if (input.query) {
      const like = `%${input.query}%`;
      conditions.push(
        sql`(${sources.title} ILIKE ${like} OR ${sources.publisher} ILIKE ${like}
             OR ${sources.author} ILIKE ${like} OR ${sources.url} ILIKE ${like})`
      );
    }
    if (input.publishedFrom) {
      conditions.push(
        sql`${sources.publishedAt} >= ${input.publishedFrom}::timestamptz`
      );
    }
    if (input.publishedTo) {
      conditions.push(
        sql`${sources.publishedAt} <= ${input.publishedTo}::timestamptz`
      );
    }
    if (input.language) {
      // What the system *records* about a source's language, and nothing
      // inferred: a language registered for one of its captures, or the source
      // language of a translation of one of those captures. Detection is
      // deliberately never persisted (see 0017), so a filter that claimed to
      // read a detected language would be reading a value that does not exist.
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${sourceSnapshots} AS capture
          WHERE capture.source_id = ${sources.id}
            AND (
              capture.source_language = ${input.language}
              OR EXISTS (
                SELECT 1 FROM ${translations} AS translation
                WHERE translation.source_snapshot_id = capture.id
                  AND translation.source_language = ${input.language}
              )
            )
        )`
      );
    }
    if (input.domain) {
      // Host of the url the material came from, matched exactly or as a parent
      // domain so "stats.gov.cn" also finds "data.stats.gov.cn". The canonical
      // url is preferred but a source registered by hand has none yet —
      // canonicalization happens on retrieval — so the typed url is the
      // fallback. Reading only the canonical url would answer "no such domain"
      // about a page the research demonstrably holds.
      const domainSource = sql`coalesce(${sources.canonicalUrl}, ${sources.url})`;
      const host = sql`lower(substring(${domainSource} from '^https?://([^/]+)'))`;
      const wanted = input.domain.toLowerCase();
      conditions.push(
        sql`${domainSource} IS NOT NULL
            AND (${host} = ${wanted} OR ${host} LIKE ${`%.${wanted}`})`
      );
    }

    const where = and(...conditions);

    const [countRow] = await this.database
      .select({ count: sql<number>`count(*)::int` })
      .from(sources)
      .where(where);
    const total = countRow?.count ?? 0;

    const sourceRows = await this.database
      .select()
      .from(sources)
      .where(where)
      .orderBy(desc(sources.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    if (sourceRows.length === 0) {
      return { rows: [], total };
    }

    const ids = sourceRows.map((row) => row.id);
    const snapshotRows = await this.database
      .select({
        sourceId: sourceSnapshots.sourceId,
        contentHash: sourceSnapshots.contentHash,
        retrievedAt: sourceSnapshots.retrievedAt,
        sourceLanguage: sourceSnapshots.sourceLanguage
      })
      .from(sourceSnapshots)
      .where(inArray(sourceSnapshots.sourceId, ids))
      .orderBy(desc(sourceSnapshots.retrievedAt));

    const aggregates = new Map<
      string,
      {
        snapshotCount: number;
        latestSnapshotAt: string | null;
        latestContentHash: string | null;
        languages: Set<string>;
      }
    >();
    for (const row of snapshotRows) {
      const current =
        aggregates.get(row.sourceId) ??
        {
          snapshotCount: 0,
          latestSnapshotAt: null,
          latestContentHash: null,
          languages: new Set<string>()
        };
      current.snapshotCount += 1;
      // Rows arrive newest first, so the first one seen is the latest.
      if (current.latestSnapshotAt === null) {
        current.latestSnapshotAt = new Date(
          String(row.retrievedAt)
        ).toISOString();
        current.latestContentHash = row.contentHash;
      }
      if (row.sourceLanguage) {
        current.languages.add(row.sourceLanguage);
      }
      aggregates.set(row.sourceId, current);
    }

    return {
      rows: sourceRows.map((row) => {
        const source = parseSources([row])[0]!;
        const aggregate = aggregates.get(row.id);
        return {
          source,
          snapshotCount: aggregate?.snapshotCount ?? 0,
          latestSnapshotAt: aggregate?.latestSnapshotAt ?? null,
          latestContentHash: aggregate?.latestContentHash ?? null,
          languages: aggregate ? [...aggregate.languages] : []
        };
      }),
      total
    };
  }

  /** A source by id, with no session scoping: the service authorizes. */
  async getSourceById(sourceId: string): Promise<Source | null> {
    const [row] = await this.database
      .select()
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    return row ? (parseSources([row])[0] ?? null) : null;
  }

  /** Version history for a source, newest first. */
  async listVersions(sourceId: string): Promise<SourceSnapshot[]> {
    const rows = await this.database
      .select()
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.sourceId, sourceId))
      .orderBy(desc(sourceSnapshots.retrievedAt));
    return parseSourceSnapshots(rows);
  }

  /** One immutable capture by id; the service still authorizes the caller. */
  async getSnapshotById(snapshotId: string): Promise<SourceSnapshot | null> {
    const [row] = await this.database
      .select()
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.id, snapshotId))
      .limit(1);
    return row ? (parseSourceSnapshots([row])[0] ?? null) : null;
  }

  /** The origin's latest capture, used to derive drift on read. */
  async getLatestSnapshotForSource(
    sourceId: string
  ): Promise<SourceSnapshot | null> {
    const [row] = await this.database
      .select()
      .from(sourceSnapshots)
      .where(eq(sourceSnapshots.sourceId, sourceId))
      .orderBy(desc(sourceSnapshots.retrievedAt))
      .limit(1);
    return row ? (parseSourceSnapshots([row])[0] ?? null) : null;
  }

  async findDuplicateInSession(
    sessionId: string,
    candidate: { canonicalUrl: string | null; title: string }
  ): Promise<{ sourceId: string; title: string; canonicalUrl: string | null; reason: "canonical_url" | "title" } | null> {
    if (candidate.canonicalUrl) {
      const [row] = await this.database
        .select({
          sourceId: sources.id,
          title: sources.title,
          canonicalUrl: sources.canonicalUrl
        })
        .from(sources)
        .where(
          and(
            eq(sources.sessionId, sessionId),
            eq(sources.canonicalUrl, candidate.canonicalUrl)
          )
        )
        .limit(1);
      if (row) {
        return {
          sourceId: row.sourceId,
          title: row.title,
          canonicalUrl: row.canonicalUrl,
          reason: "canonical_url"
        };
      }
      return null;
    }
    const [row] = await this.database
      .select({
        sourceId: sources.id,
        title: sources.title,
        canonicalUrl: sources.canonicalUrl
      })
      .from(sources)
      .where(
        and(eq(sources.sessionId, sessionId), eq(sources.title, candidate.title))
      )
      .limit(1);
    if (row) {
      return {
        sourceId: row.sourceId,
        title: row.title,
        canonicalUrl: row.canonicalUrl,
        reason: "title"
      };
    }
    return null;
  }

  /**
   * Writes the copy atomically: the new source, its self-contained snapshot
   * (when the copy carries captured text), the lineage row and the target
   * session's audit event all land together or not at all. The origin is only
   * read, never written — a copy can no more change the original than a quote
   * can change the page it came from.
   */
  async createCopiedSource(input: {
    source: Source;
    /** Null for a reference copy: metadata only, no captured text. */
    snapshot: SourceSnapshot | null;
    copy: {
      id: string;
      originSessionId: string;
      originSourceId: string;
      originSnapshotId: string | null;
      originSnapshotHash: string | null;
      copiedBy: string;
      copiedAt: string;
    };
    event: AppendEventInput;
  }): Promise<{ source: Source; snapshot: SourceSnapshot | null; copy: SourceCopyRow }> {
    return this.database.transaction(async (transaction) => {
      // The same two guards `createSource` applies, re-checked inside the
      // transaction so a racing import cannot produce a near-duplicate.
      const duplicate = await this.findDuplicateInSession(
        input.source.sessionId,
        {
          canonicalUrl: input.source.canonicalUrl ?? null,
          title: input.source.title
        }
      );
      if (duplicate) {
        throw new LibraryDuplicateSourceError(duplicate);
      }

      const [createdSource] = await transaction
        .insert(sources)
        .values({
          id: input.source.id,
          sessionId: input.source.sessionId,
          title: input.source.title,
          kind: input.source.kind,
          ...(input.source.url ? { url: input.source.url } : {}),
          ...(input.source.publisher ? { publisher: input.source.publisher } : {}),
          ...(input.source.author ? { author: input.source.author } : {}),
          ...(input.source.publishedAt
            ? { publishedAt: input.source.publishedAt }
            : {}),
          ...(input.source.note ? { note: input.source.note } : {}),
          ...(input.source.canonicalUrl
            ? { canonicalUrl: input.source.canonicalUrl }
            : {}),
          retrievalStatus: input.source.retrievalStatus ?? "not_requested",
          retrievalAttempts: input.source.retrievalAttempts ?? 0,
          ...(input.source.retrievedAt
            ? { retrievedAt: input.source.retrievedAt }
            : {}),
          ...(input.source.contentType
            ? { contentType: input.source.contentType }
            : {}),
          ...(input.source.contentHash
            ? { contentHash: input.source.contentHash }
            : {}),
          ...(input.source.contentBytes !== undefined
            ? { contentBytes: input.source.contentBytes }
            : {}),
          createdBy: input.source.createdBy,
          createdAt: input.source.createdAt,
          updatedAt: input.source.updatedAt
        })
        .returning();

      let createdSnapshot: SourceSnapshot | null = null;
      if (input.snapshot) {
        const [row] = await transaction
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
            ...(input.snapshot.sourceLanguage
              ? { sourceLanguage: input.snapshot.sourceLanguage }
              : {}),
            createdAt: input.snapshot.createdAt
          })
          .returning();
        createdSnapshot = parseSourceSnapshots([row!])[0]!;
      }

      const [createdCopy] = await transaction
        .insert(sourceCopies)
        .values({
          id: input.copy.id,
          sessionId: input.source.sessionId,
          sourceId: input.source.id,
          originSessionId: input.copy.originSessionId,
          originSourceId: input.copy.originSourceId,
          ...(input.copy.originSnapshotId
            ? { originSnapshotId: input.copy.originSnapshotId }
            : {}),
          ...(input.copy.originSnapshotHash
            ? { originSnapshotHash: input.copy.originSnapshotHash }
            : {}),
          copiedBy: input.copy.copiedBy,
          copiedAt: input.copy.copiedAt
        })
        .returning();

      await appendEvent(transaction, input.source.sessionId, input.event);

      return {
        source: parseSources([createdSource!])[0]!,
        snapshot: createdSnapshot,
        copy: parseCopy(createdCopy!)
      };
    });
  }

  async getCopyForSource(
    sessionId: string,
    sourceId: string
  ): Promise<SourceCopyRow | null> {
    const [row] = await this.database
      .select()
      .from(sourceCopies)
      .where(
        and(eq(sourceCopies.sessionId, sessionId), eq(sourceCopies.sourceId, sourceId))
      )
      .limit(1);
    return row ? parseCopy(row) : null;
  }

  /** Lineage rows for a session's sources, keyed by source id. */
  async listCopiesForSession(sessionId: string): Promise<Map<string, SourceCopyRow>> {
    const rows = await this.database
      .select()
      .from(sourceCopies)
      .where(eq(sourceCopies.sessionId, sessionId));
    return new Map(rows.map((row) => [String(row.sourceId), parseCopy(row)]));
  }

  /**
   * Origin source ids already copied into a session — what makes
   * "already copied" a fact rather than a guess.
   */
  async listCopiedOriginSourceIds(sessionId: string): Promise<Set<string>> {
    const rows = await this.database
      .select({ originSourceId: sourceCopies.originSourceId })
      .from(sourceCopies)
      .where(eq(sourceCopies.sessionId, sessionId));
    return new Set(rows.map((row) => row.originSourceId));
  }

  /**
   * Creates a grant and, when an event is supplied, writes it in the same
   * transaction: an authorization can never exist without its audit trail.
   */
  async createGrant(
    draft: ShareGrantDraft,
    grantedBy: string,
    event?: AppendEventInput
  ): Promise<ShareGrant> {
    return this.database.transaction(async (transaction) => {
      try {
        const [row] = await transaction
          .insert(sourceShareGrants)
          .values({
            id: newId(),
            subjectType: draft.subjectType,
            subjectId: draft.subjectId,
            scope: draft.scope,
            sessionId: draft.sessionId,
            grantedBy
          })
          .returning();
        if (event) {
          await appendEvent(transaction, draft.sessionId, event);
        }
        return parseGrant(row!);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          (error as { code?: string }).code === "23505"
        ) {
          throw new GrantAlreadyExistsError();
        }
        throw error;
      }
    });
  }

  async listGrants(sessionId: string): Promise<ShareGrant[]> {
    const rows = await this.database
      .select()
      .from(sourceShareGrants)
      .where(eq(sourceShareGrants.sessionId, sessionId))
      .orderBy(desc(sourceShareGrants.grantedAt));
    return rows.map(parseGrant);
  }

  async getGrant(grantId: string): Promise<ShareGrant | null> {
    const [row] = await this.database
      .select()
      .from(sourceShareGrants)
      .where(eq(sourceShareGrants.id, grantId))
      .limit(1);
    return row ? parseGrant(row) : null;
  }

  /**
   * Revokes a live grant, keeping the row. Returns null when the grant does
   * not exist or is already revoked, so a double revoke is a 404 rather than
   * a second audit entry claiming a fresh decision. The event is written in
   * the same transaction as the revocation.
   */
  async revokeGrant(
    grantId: string,
    revokedBy: string,
    reason: string,
    revokedAt: string,
    event?: AppendEventInput
  ): Promise<ShareGrant | null> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .update(sourceShareGrants)
        .set({
          revokedAt,
          revokedBy,
          revokeReason: reason
        })
        .where(
          and(
            eq(sourceShareGrants.id, grantId),
            sql`${sourceShareGrants.revokedAt} IS NULL`
          )
        )
        .returning();
      if (!row) {
        return null;
      }
      if (event) {
        await appendEvent(transaction, String(row.sessionId), event);
      }
      return parseGrant(row);
    });
  }
}

/**
 * Marks a copied source as forked when the target research captures content
 * that differs from the version it was copied as.
 *
 * Called inside the retrieval transaction, so a fork can never be recorded
 * without the capture that caused it. A re-capture of the *same* text leaves
 * the copy `synced`: nothing diverged.
 */
export async function markCopyForked(
  transaction: DbExecutor,
  input: {
    sessionId: string;
    sourceId: string;
    contentHash: string;
    forkedAt: string;
  }
): Promise<boolean> {
  const rows = await transaction
    .update(sourceCopies)
    .set({ forkState: "forked", forkedAt: input.forkedAt })
    .where(
      and(
        eq(sourceCopies.sessionId, input.sessionId),
        eq(sourceCopies.sourceId, input.sourceId),
        eq(sourceCopies.forkState, "synced"),
        sql`${sourceCopies.originSnapshotHash} IS DISTINCT FROM ${input.contentHash}`
      )
    )
    .returning({ id: sourceCopies.id });
  return rows.length > 0;
}
