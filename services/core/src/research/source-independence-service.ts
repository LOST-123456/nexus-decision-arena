import type { EvidenceRepository, SourceIndependenceRepository } from "@nexus/db";
import {
  buildSourceProfile,
  detectConfirmedSourceLinks,
  detectSuspectedSourceLinks,
  isAssertableRelationKind,
  mergeSourceLinks,
  summarizeIndependence,
  type IndependenceSummary,
  type Source,
  type SourceAnalysisFailureCode,
  type SourceLink,
  type SourceProfile,
  type SourceProfileOverride,
  type SourceProfileOverrideDraft,
  type SourceRelation,
  type SourceRelationDraft,
  type SourceSnapshot
} from "@nexus/shared";
import {
  extractExplicitReferences,
  SOURCE_INDEPENDENCE_ALGORITHM,
  sourceTextFingerprint
} from "./source-independence";

/**
 * Source independence analysis.
 *
 * The whole point is to stop a set of reprints from reading as corroboration.
 * Two questions stay apart throughout:
 *   - which pages are the same information (this service), and
 *   - which source is authoritative and which excerpt bears on a claim (not
 *     this service — authority is a label, applicability is the support
 *     assessment).
 *
 * Detection is recomputed on every read from the stored sources and captures,
 * so nothing can go stale. Only a person's statements are persisted, and this
 * service writes nothing else: it does not touch `sources`, `evidence`, a
 * verification status or a verdict.
 */

export class SourceIndependenceError extends Error {
  constructor(
    message: string,
    readonly code: SourceAnalysisFailureCode,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "SourceIndependenceError";
  }
}

export type SourceAnalysisResult = {
  sessionId: string;
  /** The version of the detection rules, so a result can be re-derived. */
  algorithm: string;
  generatedAt: string;
  summary: IndependenceSummary;
  /** Recomputed on every read; never persisted. */
  links: SourceLink[];
  profiles: SourceProfile[];
  /** The human statements this analysis was merged with. */
  humanRelations: SourceRelation[];
};

type SourcesDependency = Pick<
  EvidenceRepository,
  "listSources" | "listLatestSnapshots" | "getSource"
>;

type AssertionsDependency = Pick<
  SourceIndependenceRepository,
  | "recordRelation"
  | "listCurrentRelations"
  | "listRelationsForSource"
  | "listRelationHistory"
  | "recordProfileOverride"
  | "listCurrentProfileOverrides"
  | "listProfileOverrideHistory"
>;

export class SourceIndependenceService {
  constructor(
    private readonly dependencies: {
      sources: SourcesDependency;
      assertions: AssertionsDependency;
      now?: () => Date;
    }
  ) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  /**
   * Builds the independence reading for a whole session.
   *
   * An empty session is a valid answer, not an error: the workspace still has
   * to render, and "there is nothing to compare yet" is a real state.
   */
  async analyze(sessionId: string): Promise<SourceAnalysisResult> {
    const sources = await this.dependencies.sources.listSources(sessionId);
    const snapshots = await this.dependencies.sources.listLatestSnapshots(
      sessionId
    );
    const snapshotBySource = new Map<string, SourceSnapshot>();
    for (const snapshot of snapshots) {
      if (!snapshotBySource.has(snapshot.sourceId)) {
        snapshotBySource.set(snapshot.sourceId, snapshot);
      }
    }

    if (sources.length === 0) {
      const empty = summarizeIndependence({ sessionId, sources, links: [] });
      empty.notes.push("本研究会话还没有登记来源，暂时无法比较独立性。");
      return {
        sessionId,
        algorithm: SOURCE_INDEPENDENCE_ALGORITHM,
        generatedAt: this.now().toISOString(),
        summary: empty,
        links: [],
        profiles: [],
        humanRelations: []
      };
    }

    const fingerprints: Record<string, string> = {};
    const captureHashes: Record<string, string> = {};
    for (const [sourceId, snapshot] of snapshotBySource) {
      fingerprints[sourceId] = sourceTextFingerprint(snapshot.content);
      const hash = snapshot.contentHash.trim();
      if (hash) captureHashes[sourceId] = hash;
    }

    const detected: SourceLink[] = [
      ...detectConfirmedSourceLinks(sources, captureHashes),
      ...detectSuspectedSourceLinks({ sources, fingerprints })
    ];

    // Explicit references found in the stored text. Suspected, not asserted:
    // a link on a page says the page pointed at another page, not that it
    // copied it.
    const seenCitation = new Set<string>();
    for (const [sourceId, snapshot] of snapshotBySource) {
      for (const referencedId of extractExplicitReferences({
        text: snapshot.content,
        selfSourceId: sourceId,
        sources
      })) {
        const key = `${sourceId}->${referencedId}`;
        if (seenCitation.has(key)) continue;
        seenCitation.add(key);
        detected.push({
          fromSourceId: sourceId,
          toSourceId: referencedId,
          kind: "quotes",
          basis: "explicit_citation",
          confidence: "suspected",
          similarity: null,
          reason: "正文中出现了指向本会话另一个来源的链接，疑似引用/转载，需人工确认。",
          origin: "system"
        });
      }
    }

    const humanRelations = await this.dependencies.assertions.listCurrentRelations(
      sessionId
    );
    const links = mergeSourceLinks({ detected, assertions: humanRelations });
    const summary = summarizeIndependence({ sessionId, sources, links });

    const overrides = await this.dependencies.assertions.listCurrentProfileOverrides(
      sessionId
    );
    const overrideBySource = new Map<string, SourceProfileOverride>();
    for (const override of overrides) {
      overrideBySource.set(override.sourceId, override);
    }

    const profiles = sources.map((source) =>
      this.profileFor({
        source,
        snapshot: snapshotBySource.get(source.id) ?? null,
        links,
        override: overrideBySource.get(source.id) ?? null
      })
    );

    return {
      sessionId,
      algorithm: SOURCE_INDEPENDENCE_ALGORITHM,
      generatedAt: this.now().toISOString(),
      summary,
      links,
      profiles,
      humanRelations
    };
  }

  private profileFor(input: {
    source: Source;
    snapshot: SourceSnapshot | null;
    links: readonly SourceLink[];
    override: SourceProfileOverride | null;
  }): SourceProfile {
    const references: string[] = [];
    const referencedBy: string[] = [];
    for (const link of input.links) {
      const isReference =
        link.kind === "quotes" || link.kind === "reprint" || link.kind === "same_origin";
      if (!isReference) continue;
      if (link.fromSourceId === input.source.id) references.push(link.toSourceId);
      if (link.toSourceId === input.source.id) referencedBy.push(link.fromSourceId);
    }

    return buildSourceProfile({
      source: input.source,
      charCount: input.snapshot?.charCount ?? null,
      referencesSourceIds: references,
      referencedBySourceIds: referencedBy,
      override: input.override,
      asOf: this.now()
    });
  }

  /**
   * Records a person's ruling about a pair of sources.
   *
   * Both sources must belong to the session: an id from another research task
   * is reported as not found rather than silently accepted, so a relation can
   * never bridge two projects.
   */
  async declareRelation(input: {
    sessionId: string;
    draft: SourceRelationDraft;
    relationId: string;
    actor: string;
    similarity?: number | null;
  }): Promise<{ relation: SourceRelation; event: import("@nexus/shared").ExecutionEvent }> {
    if (!isAssertableRelationKind(input.draft.kind)) {
      throw new SourceIndependenceError(
        `Unknown relation kind: ${input.draft.kind}`,
        "invalid_request",
        400
      );
    }
    await this.assertSourceInSession(input.sessionId, input.draft.fromSourceId);
    await this.assertSourceInSession(input.sessionId, input.draft.toSourceId);

    return this.dependencies.assertions.recordRelation({
      sessionId: input.sessionId,
      relation: {
        id: input.relationId,
        sessionId: input.sessionId,
        fromSourceId: input.draft.fromSourceId,
        toSourceId: input.draft.toSourceId,
        kind: input.draft.kind,
        basis: "human_assertion",
        similarity: clampSimilarity(input.similarity),
        reason: input.draft.reason,
        origin: "human",
        actor: input.actor
      },
      event: {
        correlationId: input.relationId,
        type: "SOURCE_RELATION_RECORDED",
        payload: {
          fromSourceId: input.draft.fromSourceId,
          toSourceId: input.draft.toSourceId,
          kind: input.draft.kind,
          recordedBy: input.actor
        }
      }
    });
  }

  /** Records a person's override of one source's provenance kind. */
  async overrideProfile(input: {
    sessionId: string;
    draft: SourceProfileOverrideDraft;
    overrideId: string;
    actor: string;
  }): Promise<{ override: SourceProfileOverride; event: import("@nexus/shared").ExecutionEvent }> {
    await this.assertSourceInSession(input.sessionId, input.draft.sourceId);
    return this.dependencies.assertions.recordProfileOverride({
      sessionId: input.sessionId,
      override: {
        id: input.overrideId,
        sessionId: input.sessionId,
        sourceId: input.draft.sourceId,
        provenanceKind: input.draft.provenanceKind,
        note: input.draft.note,
        origin: "human",
        actor: input.actor
      },
      event: {
        correlationId: input.overrideId,
        type: "SOURCE_PROFILE_OVERRIDDEN",
        payload: {
          sourceId: input.draft.sourceId,
          provenanceKind: input.draft.provenanceKind,
          overriddenBy: input.actor
        }
      }
    });
  }

  /** The full history of one pair's statements, newest last. */
  async relationHistory(input: {
    sessionId: string;
    firstSourceId: string;
    secondSourceId: string;
  }): Promise<SourceRelation[]> {
    return this.dependencies.assertions.listRelationHistory(
      input.sessionId,
      input.firstSourceId,
      input.secondSourceId
    );
  }

  /** The full history of one source's profile overrides, newest first. */
  async profileHistory(
    sessionId: string,
    sourceId: string
  ): Promise<SourceProfileOverride[]> {
    return this.dependencies.assertions.listProfileOverrideHistory(
      sessionId,
      sourceId
    );
  }

  private async assertSourceInSession(
    sessionId: string,
    sourceId: string
  ): Promise<void> {
    const source = await this.dependencies.sources.getSource(sessionId, sourceId);
    if (!source) {
      throw new SourceIndependenceError(
        `Source not found in this research: ${sourceId}`,
        "source_not_found",
        404
      );
    }
  }
}

function clampSimilarity(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}
