import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";
import type { Source } from "../domain/source";

/*
 * Source quality and independence — three questions that must never be merged.
 *
 *   1. 来源发布者的权威性 (authority) — who published it, and what that tells
 *      us about the *publisher*. This module records facts and evidence-based
 *      labels only. It never turns a well-known domain into a correctness
 *      claim, and it never invents a reliability score: a numeric-looking value
 *      that has not been calibrated is worse than no value at all.
 *
 *   2. 这条内容对当前 Claim 的适用性 (applicability) — whether a specific
 *      excerpt bears on a specific claim. That is the claim–evidence support
 *      assessment (see `citation-integrity.ts`). It is NOT computed here, and
 *      nothing in this module may be substituted for it.
 *
 *   3. 来源之间的独立性 (independence) — whether two pages are the same
 *      information. Five pages reprinting one wire story are ONE independent
 *      source, not five pieces of corroboration.
 *
 * The three are surfaced as three separate things. In particular, "text looks
 * similar" is never promoted to "these are the same source": similarity is
 * always reported as `suspected` until a person confirms it.
 */

/* ------------------------------------------------------------------ *
 * Vocabularies
 * ------------------------------------------------------------------ */

/** 来源类型：一手 / 二手 / 评论 / 机构公告 / 数据集 / 未知。 */
export const SourceProvenanceKindSchema = z.enum([
  "primary",
  "secondary",
  "commentary",
  "official_notice",
  "dataset",
  "unknown"
]);

export type SourceProvenanceKind = z.infer<typeof SourceProvenanceKindSchema>;

/** How two sources are related. */
export const SourceRelationKindSchema = z.enum([
  /** The same canonical url: one page, however many rows name it. */
  "same_page",
  /** Byte-identical content behind two different urls. */
  "duplicate",
  /** Reproduces another source's content (确定或人工声明的转载). */
  "reprint",
  /** Explicitly cites another source. */
  "quotes",
  /** Both appear to depend on one upstream source that is not in the session. */
  "same_origin",
  /** Text is very similar but not identical — a candidate, not a conclusion. */
  "near_duplicate",
  /** Human-declared: these two are NOT the same information. */
  "unrelated"
]);

export type SourceRelationKind = z.infer<typeof SourceRelationKindSchema>;

/** The evidence a link is based on. */
export const SourceRelationBasisSchema = z.enum([
  "canonical_url",
  "content_hash",
  "text_similarity",
  "explicit_citation",
  "human_assertion"
]);

export type SourceRelationBasis = z.infer<typeof SourceRelationBasisSchema>;

/**
 * Whether a link is a fact or a proposal.
 *
 * `confirmed` means the server re-derived it from stored data by a rule that
 * cannot be argued with (same normalized url, identical content hash).
 * `suspected` means a heuristic flagged it — near-identical text, or an
 * explicit citation. A suspected link is shown and offered for a human to
 * confirm or reject, and it is only merged into the independence count once a
 * person confirms it, because text similarity alone does not prove common
 * origin.
 */
export const SourceLinkConfidenceSchema = z.enum(["confirmed", "suspected"]);
export type SourceLinkConfidence = z.infer<typeof SourceLinkConfidenceSchema>;

export const SourceRelationOriginSchema = z.enum(["system", "human"]);
export type SourceRelationOrigin = z.infer<typeof SourceRelationOriginSchema>;

/* ------------------------------------------------------------------ *
 * Persisted human assertions
 * ------------------------------------------------------------------ */

/**
 * A relation a person asserted (or corrected). Append-only: a correction
 * inserts a new row pointing at the one it replaced, so what was believed
 * before, by whom and why stays readable.
 */
export const SourceRelationSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  fromSourceId: IdSchema,
  toSourceId: IdSchema,
  kind: SourceRelationKindSchema,
  basis: SourceRelationBasisSchema,
  /** Similarity the assertion was made against, for `near_duplicate`. */
  similarity: z.number().min(0).max(1).nullable(),
  reason: z.string().min(1).max(2000),
  origin: SourceRelationOriginSchema,
  actor: z.string().min(1).max(160),
  supersedesId: IdSchema.nullable(),
  isCurrent: z.boolean(),
  createdAt: TimestampSchema
});

export type SourceRelation = z.infer<typeof SourceRelationSchema>;

/** A human override of a source's 来源类型 (provenance kind). */
export const SourceProfileOverrideSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  sourceId: IdSchema,
  provenanceKind: SourceProvenanceKindSchema,
  note: z.string().min(1).max(2000),
  origin: SourceRelationOriginSchema,
  actor: z.string().min(1).max(160),
  supersedesId: IdSchema.nullable(),
  isCurrent: z.boolean(),
  createdAt: TimestampSchema
});

export type SourceProfileOverride = z.infer<typeof SourceProfileOverrideSchema>;

/* ------------------------------------------------------------------ *
 * Computed (never persisted) shapes
 * ------------------------------------------------------------------ */

export type SourceLink = {
  fromSourceId: string;
  toSourceId: string;
  kind: SourceRelationKind;
  basis: SourceRelationBasis;
  confidence: SourceLinkConfidence;
  similarity: number | null;
  reason: string;
  origin: SourceRelationOrigin;
};

export type SourceProfile = {
  sourceId: string;
  title: string;
  canonicalUrl: string | null;
  /** 来源类型. Human override wins; otherwise inferred from recorded facts. */
  provenanceKind: SourceProvenanceKind;
  provenanceOrigin: SourceRelationOrigin;
  provenanceReasons: string[];
  /** Facts read off the record. Never invented. */
  facts: {
    publisher: string | null;
    author: string | null;
    publishedAt: string | null;
    retrievedAt: string | null;
    contentVersion: string | null;
    contentType: string | null;
    charCount: number | null;
    retrievalStatus: string;
  };
  /** Upstream sources this one explicitly refers to. */
  referencesSourceIds: string[];
  /** Sources that appear to reproduce or quote this one. */
  referencedBySourceIds: string[];
  /** Evidence-based quality labels. No numeric score is produced. */
  qualityLabels: string[];
  /** What could not be established from the recorded data. */
  limitations: string[];
  /*
   * Deliberately absent: whether this source bears on any claim. Applicability
   * is the claim–evidence support assessment and is not folded in here.
   */
};

export type SourceCluster = {
  clusterId: string;
  representativeSourceId: string;
  sourceIds: string[];
  pageCount: number;
  /** Relation kinds that hold the cluster together (all confirmed links). */
  confirmedKinds: SourceRelationKind[];
  notes: string[];
};

export type IndependenceSummary = {
  sessionId: string;
  /** How many pages were examined. */
  pages: number;
  /**
   * Independent information sources when only deterministic links are merged.
   * This is the defensible upper bound: a suspected duplicate still counts as
   * its own source until a person confirms otherwise.
   */
  confirmedIndependentSources: number;
  /**
   * Lower bound: also merges every suspected link, i.e. the reader is being
   * shown the smallest count the evidence could support.
   */
  suspectedIndependentSources: number;
  clusters: SourceCluster[];
  confirmedLinks: SourceLink[];
  /** Suspected links, surfaced for confirmation. Not merged into clusters. */
  suspectedLinks: SourceLink[];
  /** Sources with no relation to any other source in the session. */
  unlinkedSourceIds: string[];
  notes: string[];
};

/* ------------------------------------------------------------------ *
 * Similarity — pure, so the rule is testable without any stored text
 * ------------------------------------------------------------------ */

/**
 * Similarity of two simhash values given as hex strings, in `[0, 1]`.
 *
 * `1` means identical fingerprints. The value is a *screening* signal: it says
 * "look closer", never "these are the same source".
 */
export function simhashSimilarity(a: string, b: string): number {
  const length = Math.max(a.length, b.length);
  if (length === 0) return 1;
  let distance = 0;
  for (let index = 0; index < length; index += 1) {
    const left = Number.parseInt(a[index] ?? "0", 16);
    const right = Number.parseInt(b[index] ?? "0", 16);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 0;
    let xor = left ^ right;
    while (xor > 0) {
      distance += xor & 1;
      xor >>= 1;
    }
  }
  return 1 - distance / (length * 4);
}

/* ------------------------------------------------------------------ *
 * Detection
 * ------------------------------------------------------------------ */

function pairId(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Links the server can prove from stored data alone:
 *   - two rows naming the same normalized url are the same page;
 *   - two sources whose current capture hash is identical carry the same bytes.
 *
 * Both are `confirmed`. Nothing here looks at text similarity.
 */
export function detectConfirmedSourceLinks(
  sources: readonly Source[],
  /**
   * Hash of each source's *current* capture, keyed by source id.
   *
   * The version hash belongs to the capture, and a source row only carries a
   * copy of it. Callers that already read captures pass them here so that two
   * rows pointing at byte-identical bodies are recognised as one page even
   * when the row has not caught up. The row wins when both are present.
   */
  captureHashes: Readonly<Record<string, string | undefined>> = {}
): SourceLink[] {
  const links = new Map<string, SourceLink>();

  const byCanonicalUrl = new Map<string, Source[]>();
  const byContentHash = new Map<string, Source[]>();
  for (const source of sources) {
    const canonical = source.canonicalUrl?.trim().toLowerCase();
    if (canonical) {
      byCanonicalUrl.set(canonical, [...(byCanonicalUrl.get(canonical) ?? []), source]);
    }
    const hash = source.contentHash?.trim() || captureHashes[source.id]?.trim();
    if (hash) {
      byContentHash.set(hash, [...(byContentHash.get(hash) ?? []), source]);
    }
  }

  const link = (input: {
    a: Source;
    b: Source;
    kind: SourceRelationKind;
    basis: SourceRelationBasis;
    reason: string;
  }): void => {
    const key = `${pairId(input.a.id, input.b.id)}#${input.kind}`;
    if (links.has(key)) return;
    links.set(key, {
      fromSourceId: input.a.id,
      toSourceId: input.b.id,
      kind: input.kind,
      basis: input.basis,
      confidence: "confirmed",
      similarity: null,
      reason: input.reason,
      origin: "system"
    });
  };

  for (const [, group] of byCanonicalUrl) {
    const [head, ...rest] = group;
    if (!head) continue;
    for (const other of rest) {
      link({
        a: head,
        b: other,
        kind: "same_page",
        basis: "canonical_url",
        reason: `两个来源登记了同一个规范化地址 ${head.canonicalUrl ?? ""}，指向同一页面。`
      });
    }
  }

  for (const [hash, group] of byContentHash) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const a = group[i];
        const b = group[j];
        if (!a || !b) continue;
        link({
          a,
          b,
          kind: "duplicate",
          basis: "content_hash",
          reason: `两个来源的正文内容版本哈希相同（${hash.slice(0, 12)}…），是同一份内容的重复登记。`
        });
      }
    }
  }

  return [...links.values()];
}

/**
 * Screening threshold for near-duplicate text, in `[0, 1]`.
 *
 * Calibrated against how the character-shingle simhash actually behaves on the
 * short passages this workspace deals with, rather than picked for how it
 * sounds: changing one character of a 35-character Chinese sentence lands at
 * ~0.88–0.91, while genuinely unrelated sentences sit at ~0.47–0.53. `0.85`
 * sits in that gap and errs towards flagging, because a false positive costs a
 * reviewer one click while a false negative quietly inflates the count of
 * independent sources.
 */
export const NEAR_DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

/**
 * Screens for near-duplicate text using precomputed fingerprints.
 *
 * Always `suspected`: two pages can share wording because one copied the
 * other, because both copied a third, or because the topic has a fixed
 * phrasing. Which of those it is needs a human, so the link is offered for
 * confirmation rather than merged.
 */
export function detectSuspectedSourceLinks(input: {
  sources: readonly Source[];
  /** Simhash (hex) of each source's current capture text, keyed by source id. */
  fingerprints?: Readonly<Record<string, string>>;
  /** Similarity at or above this is flagged. Defaults to the calibrated screen. */
  similarityThreshold?: number;
}): SourceLink[] {
  const fingerprints = input.fingerprints ?? {};
  const threshold = input.similarityThreshold ?? NEAR_DUPLICATE_SIMILARITY_THRESHOLD;
  const links: SourceLink[] = [];
  for (let i = 0; i < input.sources.length; i += 1) {
    for (let j = i + 1; j < input.sources.length; j += 1) {
      const a = input.sources[i];
      const b = input.sources[j];
      if (!a || !b) continue;
      const left = fingerprints[a.id];
      const right = fingerprints[b.id];
      if (!left || !right) continue;
      const similarity = simhashSimilarity(left, right);
      if (similarity < threshold) continue;
      links.push({
        fromSourceId: a.id,
        toSourceId: b.id,
        kind: "near_duplicate",
        basis: "text_similarity",
        confidence: "suspected",
        similarity,
        reason: `两份正文的近似指纹相似度 ${(similarity * 100).toFixed(1)}%（阈值 ${(threshold * 100).toFixed(0)}%），疑似重复，需人工确认是否同源。`,
        origin: "system"
      });
    }
  }
  return links;
}

/**
 * Applies human assertions over the detected links.
 *
 * A person's assertion about a pair replaces whatever was detected for that
 * pair — including `unrelated`, which says "these are different" and removes
 * the pair from consideration entirely. Human silence leaves detection as-is.
 */
export function mergeSourceLinks(input: {
  detected: readonly SourceLink[];
  assertions: readonly SourceRelation[];
}): SourceLink[] {
  const overriddenPairs = new Set(
    input.assertions.map((assertion) =>
      pairId(assertion.fromSourceId, assertion.toSourceId)
    )
  );

  const merged = input.detected.filter(
    (link) => !overriddenPairs.has(pairId(link.fromSourceId, link.toSourceId))
  );

  for (const assertion of input.assertions) {
    if (assertion.kind === "unrelated") continue;
    merged.push(assertionToLink(assertion));
  }

  return merged;
}

/** Turns a persisted human assertion into a computed link. */
export function assertionToLink(assertion: SourceRelation): SourceLink {
  return {
    fromSourceId: assertion.fromSourceId,
    toSourceId: assertion.toSourceId,
    kind: assertion.kind,
    basis: assertion.basis,
    // A human statement is as confirmed as it gets — for the record. Whether it
    // is *correct* is a different matter and is not this module's business.
    confidence: "confirmed",
    similarity: assertion.similarity,
    reason: assertion.reason,
    origin: "human"
  };
}

/* ------------------------------------------------------------------ *
 * Independence
 * ------------------------------------------------------------------ */

class DisjointSet {
  private readonly parent = new Map<string, string>();

  find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined || parent === value) {
      this.parent.set(value, value);
      return value;
    }
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

function clusterCount(
  sourceIds: readonly string[],
  links: readonly SourceLink[]
): number {
  const set = new DisjointSet();
  for (const id of sourceIds) set.find(id);
  for (const link of links) {
    if (sourceIds.includes(link.fromSourceId) && sourceIds.includes(link.toSourceId)) {
      set.union(link.fromSourceId, link.toSourceId);
    }
  }
  return new Set(sourceIds.map((id) => set.find(id))).size;
}

/**
 * Groups sources into independent information sources.
 *
 * Clusters are built on **confirmed** links only. Suspected links are reported
 * separately and are not merged, so the headline count never quietly treats a
 * near-duplicate as a duplicate. `summarizeIndependence` also reports the
 * lower bound that would result if every suspected link were confirmed, so a
 * reader can see the range instead of a single number pretending to be exact.
 */
export function summarizeIndependence(input: {
  sessionId: string;
  sources: readonly Source[];
  links: readonly SourceLink[];
}): IndependenceSummary {
  const sourceIds = input.sources.map((source) => source.id);
  const confirmedLinks = input.links.filter(
    (link) => link.confidence === "confirmed"
  );
  const suspectedLinks = input.links.filter(
    (link) => link.confidence === "suspected"
  );

  const confirmedSummary = buildClusters(sourceIds, confirmedLinks);
  const suspectedClusters = clusterCount(sourceIds, [
    ...confirmedLinks,
    ...suspectedLinks
  ]);

  const notes: string[] = [];
  if (suspectedLinks.length > 0) {
    notes.push(
      `另有 ${suspectedLinks.length} 组文本相近的疑似重复待人工确认，未计入独立性合并。`
    );
  }
  if (suspectedClusters < confirmedSummary.clusters.length) {
    notes.push(
      `若全部疑似重复都被确认，独立信息源将减少至 ${suspectedClusters} 条。`
    );
  }

  return {
    sessionId: input.sessionId,
    pages: input.sources.length,
    confirmedIndependentSources: confirmedSummary.clusters.length,
    suspectedIndependentSources: suspectedClusters,
    clusters: confirmedSummary.clusters,
    confirmedLinks,
    suspectedLinks,
    unlinkedSourceIds: input.sources
      .filter(
        (source) =>
          !input.links.some(
            (link) =>
              link.fromSourceId === source.id || link.toSourceId === source.id
          )
      )
      .map((source) => source.id),
    notes
  };
}

function buildClusters(
  sourceIds: readonly string[],
  links: readonly SourceLink[]
): { clusters: SourceCluster[] } {
  const set = new DisjointSet();
  for (const id of sourceIds) set.find(id);
  for (const link of links) {
    if (sourceIds.includes(link.fromSourceId) && sourceIds.includes(link.toSourceId)) {
      set.union(link.fromSourceId, link.toSourceId);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of sourceIds) {
    const root = set.find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }

  const clusters: SourceCluster[] = [];
  for (const [root, members] of groups) {
    const sorted = [...members].sort();
    const representative = sorted[0]!;
    const inner = links.filter(
      (link) =>
        members.includes(link.fromSourceId) && members.includes(link.toSourceId)
    );
    clusters.push({
      clusterId: root,
      representativeSourceId: representative,
      sourceIds: sorted,
      pageCount: sorted.length,
      confirmedKinds: [...new Set(inner.map((link) => link.kind))].sort(),
      notes:
        sorted.length > 1
          ? [`${sorted.length} 个页面属于同一份独立信息源。`]
          : []
    });
  }

  clusters.sort((a, b) => b.pageCount - a.pageCount || a.clusterId.localeCompare(b.clusterId));
  return { clusters };
}

/**
 * The sentence the report and the workspace both use, so a reader never sees
 * two different counts for the same session.
 */
export function independenceHeadline(summary: IndependenceSummary): string {
  const { pages, confirmedIndependentSources: max, suspectedIndependentSources: min } =
    summary;
  if (max === min) {
    return `${pages} 个页面、${max} 条独立信息源`;
  }
  return `${pages} 个页面、${min}–${max} 条独立信息源（含 ${max - min} 组疑似重复待确认）`;
}

/* ------------------------------------------------------------------ *
 * Source profile
 * ------------------------------------------------------------------ */

/**
 * Builds the explainable profile of one source.
 *
 * The provenance kind is inferred only from facts that were actually recorded.
 * When nothing in the record justifies a label the answer is `unknown` with the
 * reasons listed — an unprovable "一手资料" would be exactly the kind of
 * invented authority this module exists to prevent. A human may override it.
 */
export function buildSourceProfile(input: {
  source: Source;
  /** Text length of the current capture, when one exists. */
  charCount?: number | null;
  /** Which session sources this one explicitly refers to. */
  referencesSourceIds?: readonly string[];
  /** Which session sources refer to this one. */
  referencedBySourceIds?: readonly string[];
  /** Human override of the provenance kind, when one was recorded. */
  override?: SourceProfileOverride | null;
  /** Reference instant for staleness. Defaults to now. */
  asOf?: Date;
  /** Age past which a dated source is labelled stale. Defaults to ~5 years. */
  stalenessDays?: number;
}): SourceProfile {
  const { source } = input;
  const references = [...(input.referencesSourceIds ?? [])].sort();
  const referencedBy = [...(input.referencedBySourceIds ?? [])].sort();

  const reasons: string[] = [];
  let kind: SourceProvenanceKind;
  if (input.override) {
    kind = input.override.provenanceKind;
    reasons.push(
      `由 ${input.override.actor} 人工判定：${input.override.note}`
    );
  } else {
    kind = inferProvenance(source, references, reasons);
  }

  const qualityLabels: string[] = [];
  const limitations: string[] = [];

  if (source.publisher) qualityLabels.push("已登记发布机构");
  else limitations.push("未登记发布机构，无法判断发布主体。");

  if (source.author) qualityLabels.push("已登记作者");
  else limitations.push("未登记作者或责任主体。");

  if (source.publishedAt) qualityLabels.push("已登记发布时间");
  else limitations.push("未登记发布时间，时效性无法判断。");

  const charCount = input.charCount ?? null;
  if (charCount !== null && charCount > 0) qualityLabels.push("已保存正文版本");
  else limitations.push("没有可检索的正文快照，无法与原文比对。");

  if (references.length > 0) {
    qualityLabels.push("显式引用上游来源");
  } else if (kind === "unknown") {
    limitations.push("未发现显式引用的上游来源，原始出处不可追溯。");
  }

  const staleDays = input.stalenessDays ?? 365 * 5;
  const asOf = input.asOf ?? new Date();
  if (source.publishedAt) {
    const published = new Date(source.publishedAt).getTime();
    if (Number.isFinite(published)) {
      const ageDays = (asOf.getTime() - published) / 86_400_000;
      if (ageDays > staleDays) {
        qualityLabels.push(`发布时间距今超过 ${Math.round(staleDays / 365)} 年`);
        limitations.push(
          `发布时间为 ${source.publishedAt}，距今已超过 ${Math.round(staleDays / 365)} 年，内容可能已过期。`
        );
      }
    }
  }

  if (source.retrievalStatus === "failed") {
    qualityLabels.push("抓取失败");
    limitations.push("最近一次抓取失败，当前没有可用正文。");
  }

  return {
    sourceId: source.id,
    title: source.title,
    canonicalUrl: source.canonicalUrl ?? null,
    provenanceKind: kind,
    provenanceOrigin: input.override ? "human" : "system",
    provenanceReasons:
      reasons.length > 0
        ? reasons
        : ["按已记录的事实无法判定来源类型，标记为未知。"],
    facts: {
      publisher: source.publisher ?? null,
      author: source.author ?? null,
      publishedAt: source.publishedAt ?? null,
      retrievedAt: source.retrievedAt ?? null,
      contentVersion: source.contentHash ?? null,
      contentType: source.contentType ?? null,
      charCount,
      retrievalStatus: source.retrievalStatus ?? "not_requested"
    },
    referencesSourceIds: references,
    referencedBySourceIds: referencedBy,
    qualityLabels,
    limitations
  };
}

function inferProvenance(
  source: Source,
  references: readonly string[],
  reasons: string[]
): SourceProvenanceKind {
  if (source.kind === "dataset") {
    reasons.push("登记类型为数据集，视为原始资料。");
    return "dataset";
  }

  const note = (source.note ?? "").toLowerCase();

  if (references.length > 0) {
    reasons.push(
      `正文/登记信息显式引用了本会话内其他来源（${references.length} 个），判为二手转述。`
    );
    return "secondary";
  }

  if (/(一手|原始资料|亲自记录|original source|first[- ]hand)/.test(note)) {
    reasons.push("登记备注声明为原始资料，按声明判为一手（需人工复核）。");
    return "primary";
  }

  if (/(公告|通知|official notice|press release)/.test(note)) {
    reasons.push("登记备注声明为机构公告，按声明判定（需人工复核）。");
    return "official_notice";
  }

  if (/(评论|观点|评论文章|opinion|commentary)/.test(note)) {
    reasons.push("登记备注声明为评论/观点文章，按声明判定（需人工复核）。");
    return "commentary";
  }

  reasons.push("没有任何已记录的证据可以判定来源类型。");
  return "unknown";
}

/* ------------------------------------------------------------------ *
 * Drafts accepted from the API
 * ------------------------------------------------------------------ */

/** What a person supplies to declare or correct a relation. */
export const SourceRelationDraftSchema = z.object({
  fromSourceId: IdSchema,
  toSourceId: IdSchema,
  kind: SourceRelationKindSchema,
  reason: z.string().trim().min(10).max(2000)
});

export type SourceRelationDraft = z.infer<typeof SourceRelationDraftSchema>;

/** What a person supplies to override a source's provenance kind. */
export const SourceProfileOverrideDraftSchema = z.object({
  sourceId: IdSchema,
  provenanceKind: SourceProvenanceKindSchema,
  note: z.string().trim().min(10).max(2000)
});

export type SourceProfileOverrideDraft = z.infer<
  typeof SourceProfileOverrideDraftSchema
>;

/** Relation kinds a person may assert. `unrelated` is a declaration, not a link. */
export const HUMAN_ASSERTABLE_RELATION_KINDS: readonly SourceRelationKind[] = [
  "same_page",
  "duplicate",
  "reprint",
  "quotes",
  "same_origin",
  "near_duplicate",
  "unrelated"
];

export function isAssertableRelationKind(
  value: string
): value is SourceRelationKind {
  return (HUMAN_ASSERTABLE_RELATION_KINDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ *
 * Failure vocabulary
 * ------------------------------------------------------------------ */

/**
 * Why an independence analysis could not produce a reading. Named so the UI
 * can say what to do next, and so "we could not analyse this" is never shown
 * as "there is nothing to worry about".
 */
export const SourceAnalysisFailureCodeSchema = z.enum([
  "source_not_found",
  "invalid_request",
  "storage_unavailable"
]);

export type SourceAnalysisFailureCode = z.infer<
  typeof SourceAnalysisFailureCodeSchema
>;
