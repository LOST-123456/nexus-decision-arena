import {
  SourceLibraryRepository,
  type LibrarySourceRow,
  type LibrarySessionMeta,
  type SourceCopyRow
} from "@nexus/db";
import {
  SourceSchema,
  SourceSnapshotSchema,
  type CopyOriginStatus,
  type LibrarySearchFilters,
  type LibrarySearchResult,
  type LibrarySessionSummary,
  type LibrarySourceDetail,
  type LibrarySourceSummary,
  type ShareGrant,
  type ShareGrantDraft,
  type Source,
  type SourceCopyRecord,
  type SourceSnapshot
} from "@nexus/shared";

/**
 * Cross-research library: authorized search across researches, and the one
 * sanctioned way material moves between them — an explicit copy that keeps
 * its origin.
 *
 * The authorization rule in one sentence: a caller sees a session's material
 * when they own that session or hold a live grant on it, and nothing else
 * widens that. Unknown or unauthorized ids answer 404, never 403-with-details
 * and never an empty-looking 200 that confirms existence.
 */

export type LibraryCaller = {
  userId: string;
  role: "owner" | "reviewer" | "viewer";
  /** Display form used for attribution, e.g. "Owner (owner)". */
  name: string;
  /**
   * True only when the deployment runs without an identity system: there are
   * no users to authorize against, so the workspace operator sees the
   * workspace. Never set by a request that carried a login.
   */
  implicitOperator?: boolean;
};

/** A copy either carries the captured text or only the reference. */
export type LibraryCopyMode = "copy" | "reference";

export type LibraryCopyCommand = {
  targetSessionId: string;
  sourceSessionId: string;
  sourceId: string;
  mode: LibraryCopyMode;
  /** Deterministic ids derived from the idempotency key by the route. */
  ids: {
    sourceId: string;
    snapshotId: string;
    copyId: string;
  };
};

export class LibrarySessionNotFoundError extends Error {
  constructor() {
    super("Session not found");
    this.name = "LibrarySessionNotFoundError";
  }
}

/** Authorization failure. Answers 404 on purpose: no existence disclosure. */
export class LibraryNotVisibleError extends Error {
  constructor() {
    super("Not found");
    this.name = "LibraryNotVisibleError";
  }
}

export class LibrarySnapshotNotVisibleError extends Error {
  constructor() {
    super("Not found");
    this.name = "LibrarySnapshotNotVisibleError";
  }
}

export class LibraryViewerForbiddenError extends Error {
  constructor() {
    super("Reviewer role required");
    this.name = "LibraryViewerForbiddenError";
  }
}

export class LibraryGrantNotPermittedError extends Error {
  constructor() {
    super("Only the research owner may manage its sharing");
    this.name = "LibraryGrantNotPermittedError";
  }
}

export class LibraryGrantNotFoundError extends Error {
  constructor() {
    super("Share grant not found");
    this.name = "LibraryGrantNotFoundError";
  }
}

export class LibraryGrantExistsError extends Error {
  constructor() {
    super("An active grant for this subject and scope already exists");
    this.name = "LibraryGrantExistsError";
  }
}

export class LibrarySourceHasNoCaptureError extends Error {
  constructor() {
    super(
      "This source has no saved content to copy; use a reference copy instead"
    );
    this.name = "LibrarySourceHasNoCaptureError";
  }
}

/**
 * The grant subject names nothing that can ever hold the grant.
 *
 * Refused rather than stored: a grant filed under a subject that cannot match
 * would look like sharing while sharing nothing, and the operator who believes
 * they shared would be wrong in the direction they cannot see.
 */
export class LibrarySubjectNotFoundError extends Error {
  constructor() {
    super("No account or role matches that grant subject");
    this.name = "LibrarySubjectNotFoundError";
  }
}

/**
 * Turns a typed grant subject into the id the repository matches on.
 *
 * Returns null when the subject names nothing real. A deployment with no
 * account directory supplies no resolver at all, and the value is taken
 * verbatim — the pre-existing behaviour.
 */
export type GrantSubjectResolver = (
  draft: ShareGrantDraft
) => ShareGrantDraft | null;

export class SourceLibraryService {
  constructor(
    private readonly library: SourceLibraryRepository,
    private readonly resolveSubject?: GrantSubjectResolver
  ) {}

  /**
   * Resolves what the caller may do, in one place so no method re-derives it.
   *
   * Three sets, because they are three different permissions:
   *  - `visible` — may read the research's material (owns it, or holds any
   *    live grant);
   *  - `copiable` — may take material out of it (owns it, or holds a grant
   *    whose scope is `copy`). A read-only share must not become a copy right.
   *  - `own` — may add material to it. Writing into a research is not implied
   *    by being granted access to it.
   */
  private async authorizedSessions(caller: LibraryCaller): Promise<{
    own: Set<string>;
    granted: Set<string>;
    copiable: Set<string>;
    visible: Set<string>;
  }> {
    const browsable = await this.browsableSessions(caller);
    const ownIds = new Set(browsable.own.map((row) => row.sessionId));
    const grantedIds = new Set(browsable.granted.map((row) => row.sessionId));

    if (caller.implicitOperator) {
      // No identity system: the workspace operator already has full access to
      // every session through the existing session-scoped APIs, so scoping
      // the library any tighter here would only hide data from its operator.
      const all = new Set([...ownIds, ...grantedIds]);
      return { own: all, granted: new Set(), copiable: all, visible: all };
    }

    // A grant is the only thing that widens access, and only its own scope.
    const copyScoped = browsable.granted
      .filter((row) => row.grantScope === "copy")
      .map((row) => row.sessionId);
    return {
      own: ownIds,
      granted: grantedIds,
      copiable: new Set([...ownIds, ...copyScoped]),
      visible: new Set([...ownIds, ...grantedIds])
    };
  }

  /**
   * The sessions the caller may browse, with their metadata.
   *
   * A deployment without auth has no users to authorize against; the
   * workspace operator then sees the workspace, which is exactly the access
   * the session-scoped APIs already give them.
   */
  private async browsableSessions(caller: LibraryCaller): Promise<{
    own: LibrarySessionMeta[];
    granted: LibrarySessionMeta[];
  }> {
    if (caller.implicitOperator) {
      return { own: await this.library.listAllSessionMetas(), granted: [] };
    }
    return this.library.listAuthorizedSessions(caller.userId, caller.role);
  }

  /** Sessions the caller may browse, with counts and why they may browse. */
  async listSessions(
    caller: LibraryCaller
  ): Promise<LibrarySessionSummary[]> {
    const { own, granted } = await this.browsableSessions(caller);
    const counts = await this.library.countSourcesBySession([
      ...own.map((row) => row.sessionId),
      ...granted.map((row) => row.sessionId)
    ]);

    const toSummary = (
      row: LibrarySessionMeta,
      access: LibrarySessionSummary["access"]
    ): LibrarySessionSummary => ({
      sessionId: row.sessionId,
      ...(row.researchQuestion
        ? { researchQuestion: row.researchQuestion }
        : {}),
      ...(row.projectName ? { projectName: row.projectName } : {}),
      access,
      // The grant that makes it visible, and what that grant allows: a reader
      // must be able to tell "you may browse this" from "you may copy from
      // this" before pressing a button, not by being refused afterwards.
      ...(row.grantId ? { grantId: row.grantId } : {}),
      ...(row.grantScope ? { grantScope: row.grantScope } : {}),
      sourceCount: counts.get(row.sessionId) ?? 0,
      updatedAt: row.updatedAt
    });

    return [
      ...own.map((row) => toSummary(row, "own")),
      ...granted.map((row) => toSummary(row, "granted"))
    ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Searches inside the authorized sessions only.
   *
   * A filter naming a session the caller may not see yields an empty result
   * rather than an error: the search must not become an oracle for which
   * session ids exist.
   */
  async searchSources(
    caller: LibraryCaller,
    filters: LibrarySearchFilters
  ): Promise<LibrarySearchResult> {
    const { visible, own } = await this.authorizedSessions(caller);
    const sessionIds = [...visible];
    if (filters.sessionId && !visible.has(filters.sessionId)) {
      return { sources: [], total: 0 };
    }

    const { rows, total } = await this.library.searchLibrarySources({
      sessionIds,
      ...(filters.query ? { query: filters.query } : {}),
      ...(filters.publisher ? { publisher: filters.publisher } : {}),
      ...(filters.author ? { author: filters.author } : {}),
      ...(filters.domain ? { domain: filters.domain } : {}),
      ...(filters.publishedFrom ? { publishedFrom: filters.publishedFrom } : {}),
      ...(filters.publishedTo ? { publishedTo: filters.publishedTo } : {}),
      ...(filters.language ? { language: filters.language } : {}),
      ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
      limit: filters.limit ?? 50,
      offset: filters.offset ?? 0
    });

    // "Already copied" is only answerable for a research the caller may copy
    // into. Consulting any other id would turn the marker into a way to learn
    // what someone else copied into their research.
    const alreadyCopied =
      filters.targetSessionId && own.has(filters.targetSessionId)
        ? await this.library.listCopiedOriginSourceIds(filters.targetSessionId)
        : new Set<string>();

    return {
      sources: rows.map((row) => this.toSummary(row, alreadyCopied)),
      total
    };
  }

  /**
   * The original source with its version history. Authorized callers only;
   * anyone else gets the same 404 an unknown id would get.
   */
  async getSourceDetail(
    caller: LibraryCaller,
    sourceId: string
  ): Promise<LibrarySourceDetail> {
    const { source } = await this.requireVisibleSource(caller, sourceId);
    const versions = await this.library.listVersions(sourceId);
    return {
      ...this.toSummary(
        {
          source,
          snapshotCount: versions.length,
          latestSnapshotAt: versions[0]?.retrievedAt ?? null,
          latestContentHash: versions[0]?.contentHash ?? null,
          languages: [
            ...new Set(
              versions
                .map((version) => version.sourceLanguage)
                .filter((value): value is string => Boolean(value))
            )
          ]
        },
        new Set<string>()
      ),
      ...(source.note ? { note: source.note } : {}),
      versions: versions.map((version) => ({
        snapshotId: version.id,
        contentHash: version.contentHash,
        ...(version.title ? { title: version.title } : {}),
        ...(version.author ? { author: version.author } : {}),
        ...(version.publisher ? { publisher: version.publisher } : {}),
        ...(version.publishedAt ? { publishedAt: version.publishedAt } : {}),
        contentType: version.contentType,
        contentBytes: version.contentBytes,
        charCount: version.charCount,
        ...(version.sourceLanguage
          ? { sourceLanguage: version.sourceLanguage }
          : {}),
        retrievedAt: version.retrievedAt
      }))
    };
  }

  /** One immutable capture's text, for reading what is about to be copied. */
  async getSnapshotContent(
    caller: LibraryCaller,
    sourceId: string,
    snapshotId: string
  ): Promise<{ snapshotId: string; content: string; contentHash: string }> {
    await this.requireVisibleSource(caller, sourceId);
    const snapshot = await this.library.getSnapshotById(snapshotId);
    if (!snapshot || snapshot.sourceId !== sourceId) {
      throw new LibrarySnapshotNotVisibleError();
    }
    return {
      snapshotId: snapshot.id,
      content: snapshot.content,
      contentHash: snapshot.contentHash
    };
  }

  /**
   * Copies a source into the caller's research as an independent source with
   * a self-contained snapshot, keeping the origin reference.
   *
   * What is deliberately *not* copied: evidence, claims, verification states
   * and reviews. Material travels; judgments do not — the target session
   * re-decides everything through the existing controlled paths.
   */
  async copySourceIntoSession(
    caller: LibraryCaller,
    command: LibraryCopyCommand
  ): Promise<{
    sourceId: string;
    sessionId: string;
    copy: SourceCopyRecord;
    mode: LibraryCopyMode;
  }> {
    if (caller.role === "viewer") {
      throw new LibraryViewerForbiddenError();
    }

    const access = await this.authorizedSessions(caller);
    const target = await this.library.getSessionMeta(command.targetSessionId);
    // Material is only ever added to a research the caller owns. A target the
    // caller may not write into answers exactly what an unknown id answers, so
    // this route cannot be used to probe for, or write into, someone else's
    // research.
    if (!target || !access.own.has(command.targetSessionId)) {
      throw new LibrarySessionNotFoundError();
    }

    const { source, snapshot } = await this.requireVisibleSource(
      caller,
      command.sourceId
    );
    if (source.sessionId !== command.sourceSessionId) {
      // The caller named a different origin session than the source really
      // belongs to. Treat it as not visible rather than trusting the body.
      throw new LibraryNotVisibleError();
    }
    // Reading a source is not the same right as taking it: only its owner, or
    // the holder of a `copy`-scoped grant, may reuse it elsewhere.
    if (!access.copiable.has(source.sessionId)) {
      throw new LibraryNotVisibleError();
    }

    if (command.mode === "copy" && !snapshot) {
      throw new LibrarySourceHasNoCaptureError();
    }

    const now = new Date().toISOString();
    const copiedSource = SourceSchema.parse({
      id: command.ids.sourceId,
      sessionId: command.targetSessionId,
      title: source.title,
      kind: source.kind,
      ...(source.url ? { url: source.url } : {}),
      ...(source.publisher ? { publisher: source.publisher } : {}),
      ...(source.author ? { author: source.author } : {}),
      ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
      // The note records where the material came from; the researcher's own
      // note on the origin is not silently adopted as this research's note.
      ...(source.note ? { note: source.note } : {}),
      ...(source.canonicalUrl ? { canonicalUrl: source.canonicalUrl } : {}),
      // Retrieval facts describe *this* copy. A reference copy has read
      // nothing yet, so it honestly starts at `not_requested`.
      retrievalStatus:
        command.mode === "copy" ? "fetched" : "not_requested",
      retrievalAttempts: 0,
      ...(command.mode === "copy" && snapshot
        ? {
            retrievedAt: snapshot.retrievedAt,
            contentType: snapshot.contentType,
            contentHash: snapshot.contentHash,
            contentBytes: snapshot.contentBytes
          }
        : {}),
      createdBy: "human",
      createdAt: now,
      updatedAt: now
    });

    const copiedSnapshot =
      command.mode === "copy" && snapshot
        ? SourceSnapshotSchema.parse({
            id: command.ids.snapshotId,
            sessionId: command.targetSessionId,
            sourceId: command.ids.sourceId,
            canonicalUrl: snapshot.canonicalUrl,
            contentHash: snapshot.contentHash,
            ...(snapshot.title ? { title: snapshot.title } : {}),
            ...(snapshot.author ? { author: snapshot.author } : {}),
            ...(snapshot.publisher ? { publisher: snapshot.publisher } : {}),
            ...(snapshot.publishedAt ? { publishedAt: snapshot.publishedAt } : {}),
            contentType: snapshot.contentType,
            content: snapshot.content,
            contentBytes: snapshot.contentBytes,
            charCount: snapshot.charCount,
            retrievedAt: snapshot.retrievedAt,
            ...(snapshot.sourceLanguage
              ? { sourceLanguage: snapshot.sourceLanguage }
              : {}),
            createdAt: now
          })
        : null;

    const result = await this.library.createCopiedSource({
      source: copiedSource,
      snapshot: copiedSnapshot,
      copy: {
        id: command.ids.copyId,
        originSessionId: source.sessionId,
        originSourceId: source.id,
        originSnapshotId: snapshot?.id ?? null,
        originSnapshotHash: snapshot?.contentHash ?? null,
        copiedBy: caller.name,
        copiedAt: now
      },
      event: {
        correlationId: command.ids.sourceId,
        type: "SOURCE_COPIED_TO_RESEARCH",
        payload: {
          sourceId: command.ids.sourceId,
          originSessionId: source.sessionId,
          originSourceId: source.id,
          ...(snapshot
            ? {
                originSnapshotId: snapshot.id,
                originSnapshotHash: snapshot.contentHash
              }
            : {}),
          mode: command.mode,
          copiedBy: caller.name
        }
      }
    });

    return {
      sourceId: result.source.id,
      sessionId: command.targetSessionId,
      copy: this.toCopyRecord(result.copy, "current"),
      mode: command.mode
    };
  }

  /**
   * Grants another user (or a whole role) the right to browse a research's
   * material. Only the research owner may grant; on a legacy session with no
   * recorded owner, only the `owner` role may, so no reviewer can share away
   * a session whose real owner is unknown.
   */
  async createGrant(
    caller: LibraryCaller,
    draft: ShareGrantDraft
  ): Promise<ShareGrant> {
    if (caller.role === "viewer") {
      throw new LibraryViewerForbiddenError();
    }
    const session = await this.library.getSessionMeta(draft.sessionId);
    if (!session) {
      throw new LibrarySessionNotFoundError();
    }
    if (!this.mayAdministerGrants(caller, session)) {
      throw new LibraryGrantNotPermittedError();
    }

    // Resolved only *after* the caller is known to be allowed to grant: an
    // unresolvable subject must not be distinguishable to someone who may not
    // share this research in the first place, or the route becomes a way to
    // ask whether an account exists.
    let draftToStore = draft;
    if (this.resolveSubject) {
      const resolved = this.resolveSubject(draft);
      if (!resolved) {
        throw new LibrarySubjectNotFoundError();
      }
      draftToStore = resolved;
    }

    try {
      return await this.library.createGrant(
        draftToStore,
        caller.name,
        {
          correlationId: draftToStore.sessionId,
          type: "SOURCE_LIBRARY_GRANTED",
          payload: {
            subjectType: draftToStore.subjectType,
            subjectId: draftToStore.subjectId,
            scope: draftToStore.scope,
            grantedBy: caller.name
          }
        }
      );
    } catch (error) {
      if (error instanceof LibraryGrantExistsError) {
        throw new LibraryGrantExistsError();
      }
      throw error;
    }
  }

  async listGrants(
    caller: LibraryCaller,
    sessionId: string
  ): Promise<ShareGrant[]> {
    const session = await this.library.getSessionMeta(sessionId);
    if (!session) {
      throw new LibrarySessionNotFoundError();
    }
    if (!this.mayAdministerGrants(caller, session)) {
      throw new LibraryGrantNotPermittedError();
    }
    return this.library.listGrants(sessionId);
  }

  /**
   * Revokes a live grant. The grant row stays, with who revoked it and why;
   * copies made under it stay too — revoking access to the origin must not
   * delete material a research is already citing.
   */
  async revokeGrant(
    caller: LibraryCaller,
    grantId: string,
    reason: string
  ): Promise<ShareGrant> {
    const grant = await this.library.getGrant(grantId);
    if (!grant) {
      throw new LibraryGrantNotFoundError();
    }
    const session = await this.library.getSessionMeta(grant.sessionId);
    if (!session) {
      throw new LibraryGrantNotFoundError();
    }
    if (!this.mayAdministerGrants(caller, session)) {
      throw new LibraryGrantNotPermittedError();
    }

    const revoked = await this.library.revokeGrant(
      grantId,
      caller.name,
      reason,
      new Date().toISOString(),
      {
        correlationId: grantId,
        type: "SOURCE_LIBRARY_REVOKED",
        payload: {
          subjectType: grant.subjectType,
          subjectId: grant.subjectId,
          scope: grant.scope,
          revokedBy: caller.name,
          reason
        }
      }
    );
    if (!revoked) {
      // Already revoked: a second revocation is not a new decision.
      throw new LibraryGrantNotFoundError();
    }
    return revoked;
  }

  /**
   * Lineage for the sources of one session, with the live origin status.
   *
   * `originStatus` is derived per viewer on purpose: whether the origin has
   * moved, and whether this viewer may still reach it, are facts about *now*,
   * and storing them would let the database claim a currency it cannot keep.
   */
  async listCopyLineage(
    caller: LibraryCaller,
    sessionId: string
  ): Promise<Map<string, SourceCopyRecord>> {
    const { visible } = await this.authorizedSessions(caller);
    if (!visible.has(sessionId)) {
      // Lineage is part of the research it belongs to: where its material came
      // from is not readable by someone who cannot browse that research.
      throw new LibrarySessionNotFoundError();
    }
    const copies = await this.library.listCopiesForSession(sessionId);
    if (copies.size === 0) {
      return new Map();
    }

    // One round trip for every distinct origin instead of one per copy: a
    // session that copies from N origins used to make N serial round trips.
    const distinctOrigins = new Set<string>();
    for (const copy of copies.values()) {
      distinctOrigins.add(copy.originSourceId);
    }
    const originSnapshots = await this.library.getLatestSnapshotContentHashes(
      [...distinctOrigins]
    );

    const lineage = new Map<string, SourceCopyRecord>();
    for (const copy of copies.values()) {
      lineage.set(
        copy.sourceId,
        this.toCopyRecord(
          copy,
          this.deriveOriginStatus(copy, visible, originSnapshots)
        )
      );
    }
    return lineage;
  }

  private mayAdministerGrants(
    caller: LibraryCaller,
    session: LibrarySessionMeta
  ): boolean {
    if (caller.implicitOperator) {
      return true;
    }
    if (session.ownerUserId === null) {
      // Legacy workspace session: the deployment admin owns the decision.
      return caller.role === "owner";
    }
    return session.ownerUserId === caller.userId;
  }

  /**
   * Loads a source the caller is allowed to see, or throws the same
   * not-visible error an unknown id would raise. Authorization is ownership
   * of the source's session or a live grant on it.
   */
  private async requireVisibleSource(
    caller: LibraryCaller,
    sourceId: string
  ): Promise<{ source: Source; snapshot: SourceSnapshot | null }> {
    const source = await this.library.getSourceById(sourceId);
    if (!source) {
      throw new LibraryNotVisibleError();
    }
    const { visible } = await this.authorizedSessions(caller);
    if (!visible.has(source.sessionId)) {
      throw new LibraryNotVisibleError();
    }
    const snapshot = await this.library.getLatestSnapshotForSource(sourceId);
    return { source, snapshot };
  }

  private deriveOriginStatus(
    copy: SourceCopyRow,
    visible: ReadonlySet<string>,
    originSnapshots: ReadonlyMap<string, string | null>
  ): CopyOriginStatus {
    if (!visible.has(copy.originSessionId)) {
      // Either the grant is gone, or the origin research itself was removed:
      // in both cases the live link is dead. The copy keeps its material and
      // its audit trail, but nothing here may keep claiming it can be checked
      // against the origin.
      return "revoked";
    }
    if (copy.originSnapshotHash === null) {
      // A reference copy has no captured version to drift from.
      return "current";
    }
    const latestHash = originSnapshots.get(copy.originSourceId);
    if (latestHash === null || latestHash === undefined) {
      // The origin source no longer has any capture.
      return "unavailable";
    }
    return latestHash === copy.originSnapshotHash ? "current" : "changed";
  }

  private toSummary(
    row: LibrarySourceRow,
    alreadyCopied: ReadonlySet<string>
  ): LibrarySourceSummary {
    return {
      sourceId: row.source.id,
      sessionId: row.source.sessionId,
      title: row.source.title,
      kind: row.source.kind,
      ...(row.source.url ? { url: row.source.url } : {}),
      ...(row.source.canonicalUrl ? { canonicalUrl: row.source.canonicalUrl } : {}),
      ...(row.source.publisher ? { publisher: row.source.publisher } : {}),
      ...(row.source.author ? { author: row.source.author } : {}),
      ...(row.source.publishedAt ? { publishedAt: row.source.publishedAt } : {}),
      languages: row.languages,
      snapshotCount: row.snapshotCount,
      ...(row.latestSnapshotAt ? { latestSnapshotAt: row.latestSnapshotAt } : {}),
      ...(row.latestContentHash ? { contentHash: row.latestContentHash } : {}),
      retrievalStatus: row.source.retrievalStatus ?? "not_requested",
      alreadyCopied: alreadyCopied.has(row.source.id)
    };
  }

  private toCopyRecord(
    copy: SourceCopyRow,
    originStatus: CopyOriginStatus
  ): SourceCopyRecord {
    return {
      sessionId: copy.sessionId,
      sourceId: copy.sourceId,
      originSessionId: copy.originSessionId,
      originSourceId: copy.originSourceId,
      ...(copy.originSnapshotId ? { originSnapshotId: copy.originSnapshotId } : {}),
      ...(copy.originSnapshotHash
        ? { originSnapshotHash: copy.originSnapshotHash }
        : {}),
      copiedBy: copy.copiedBy,
      copiedAt: copy.copiedAt,
      forkState: copy.forkState,
      ...(copy.forkedAt ? { forkedAt: copy.forkedAt } : {}),
      originStatus
    };
  }
}
