import {
  detectConfirmedSourceLinks,
  detectSuspectedSourceLinks,
  mergeSourceLinks,
  type Source,
  type SourceLink,
  type SourceRelation,
  type SourceSnapshot
} from "@nexus/shared";

/**
 * Deterministic, explainable signals the independence analysis runs on.
 *
 * Both functions here are pure and take no database handle, so the rules can be
 * tested on their own and the same inputs always produce the same links. None
 * of them asserts that two pages ARE the same source — they produce evidence
 * for the analysis, and near-duplicate wording is always surfaced as a
 * suspicion rather than a conclusion.
 */

/* ------------------------------------------------------------------ *
 * Simhash over character shingles
 * ------------------------------------------------------------------ */

function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Character shingles work for CJK as well as for spaced languages. */
const SHINGLE_SIZE = 4;

/**
 * A 64-bit simhash of the text, as 16 hex characters.
 *
 * Similar documents land on nearby values, so a hamming distance gives a cheap
 * screen for "these two pages read almost the same". It is a screen only: a
 * near-zero distance is reported as `suspected`, never as proof of a reprint.
 */
export function sourceTextFingerprint(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.length === 0) return "0".repeat(16);
  if (normalized.length < SHINGLE_SIZE) {
    const low = fnv1a32(normalized, 0x811c9dc5);
    const high = fnv1a32(normalized, 0x9e3779b9);
    return `${low.toString(16).padStart(8, "0")}${high
      .toString(16)
      .padStart(8, "0")}`;
  }

  const vector = new Array<number>(64).fill(0);
  for (let index = 0; index + SHINGLE_SIZE <= normalized.length; index += 1) {
    const shingle = normalized.slice(index, index + SHINGLE_SIZE);
    const low = fnv1a32(shingle, 0x811c9dc5);
    const high = fnv1a32(shingle, 0x01000193 ^ 0x9e3779b9);
    for (let bit = 0; bit < 32; bit += 1) {
      vector[bit] = (vector[bit] ?? 0) + (((low >>> bit) & 1) === 1 ? 1 : -1);
      vector[32 + bit] =
        (vector[32 + bit] ?? 0) + (((high >>> bit) & 1) === 1 ? 1 : -1);
    }
  }

  let hex = "";
  for (let nibble = 0; nibble < 16; nibble += 1) {
    let value = 0;
    for (let bit = 0; bit < 4; bit += 1) {
      value = (value << 1) | ((vector[nibble * 4 + bit] ?? 0) >= 0 ? 1 : 0);
    }
    hex += value.toString(16);
  }
  return hex;
}

/* ------------------------------------------------------------------ *
 * Explicit references
 * ------------------------------------------------------------------ */

/** Trims punctuation a url may have picked up from surrounding prose. */
function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?）)\]】>"'”’]+$/u, "");
}

/** Lower-cases the host, drops the fragment and any trailing slash. */
export function normalizeReferencedUrl(value: string): string | null {
  try {
    const url = new URL(stripTrailingPunctuation(value.trim()));
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return null;
  }
}

const URL_PATTERN = /https?:\/\/[^\s<>"'）)】\]，。；、]+/gu;

/**
 * Finds the session sources a piece of text explicitly links to.
 *
 * Only literal urls count. A page that writes "转载自某某报" without a link is
 * not matched: turning prose into a citation is exactly the kind of inference
 * that produces a fabricated provenance chain.
 */
export function extractExplicitReferences(input: {
  text: string;
  selfSourceId: string;
  sources: readonly Source[];
}): string[] {
  const byNormalizedUrl = new Map<string, string>();
  for (const source of input.sources) {
    if (source.id === input.selfSourceId) continue;
    for (const candidate of [source.canonicalUrl, source.url]) {
      if (!candidate) continue;
      const normalized = normalizeReferencedUrl(candidate);
      if (normalized) byNormalizedUrl.set(normalized, source.id);
    }
  }
  if (byNormalizedUrl.size === 0) return [];

  const referenced = new Set<string>();
  for (const match of input.text.matchAll(URL_PATTERN)) {
    const normalized = normalizeReferencedUrl(match[0]);
    if (!normalized) continue;
    const sourceId = byNormalizedUrl.get(normalized);
    if (sourceId && sourceId !== input.selfSourceId) {
      referenced.add(sourceId);
    }
  }
  return [...referenced].sort();
}

/** The version of these rules, recorded next to every analysis result. */
export const SOURCE_INDEPENDENCE_ALGORITHM = "source-independence-v1";

/**
 * Builds the link set from stored sources, their current captures, and the
 * human statements on record.
 *
 * Pure and shared so the live analysis, the fact-check report and a saved
 * report version all see exactly the same links for the same rows — three
 * implementations of "which pages are the same information" would eventually
 * disagree, and a disagreement about independence is exactly the kind of
 * quiet inconsistency this build refuses to ship.
 *
 * Nothing here asserts that two pages ARE the same source: confirmed links
 * come from rules that cannot be argued with (same normalized url, identical
 * content hash) or from a person; everything else is a suspicion, offered for
 * confirmation rather than merged.
 */
export function buildIndependenceLinks(input: {
  sources: readonly Source[];
  /** The current capture per source id. Sources without one are still compared by url. */
  snapshotBySource: ReadonlyMap<string, SourceSnapshot>;
  /** Human statements about pairs, as persisted. */
  humanRelations: readonly SourceRelation[];
}): SourceLink[] {
  const { sources, snapshotBySource, humanRelations } = input;

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

  return mergeSourceLinks({ detected, assertions: humanRelations });
}
