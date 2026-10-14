import { describe, expect, it } from "vitest";
import type { Source } from "../domain/source";
import {
  buildSourceProfile,
  detectConfirmedSourceLinks,
  detectSuspectedSourceLinks,
  independenceHeadline,
  mergeSourceLinks,
  simhashSimilarity,
  summarizeIndependence,
  type SourceLink,
  type SourceRelation
} from "./source-independence";

/**
 * Independence rules.
 *
 * The one that matters most: pages are only merged into a single independent
 * source when the server can *prove* they are the same information (same
 * normalized url, identical content hash). Similar wording is reported as a
 * suspicion and left unmerged, because "these two look alike" is not the same
 * statement as "these two are one source".
 */

let counter = 0;

function source(overrides: Partial<Source> = {}): Source {
  counter += 1;
  return {
    id: `source-${counter}`,
    sessionId: "session-1",
    title: `Source ${counter}`,
    kind: "url",
    createdBy: "human",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}

function relation(overrides: Partial<SourceRelation> = {}): SourceRelation {
  return {
    id: `relation-${counter}`,
    sessionId: "session-1",
    fromSourceId: "source-a",
    toSourceId: "source-b",
    kind: "reprint",
    basis: "human_assertion",
    similarity: null,
    reason: "编辑确认这篇是那篇的转载。",
    origin: "human",
    actor: "Researcher (researcher)",
    supersedesId: null,
    isCurrent: true,
    createdAt: "2026-10-02T00:00:00.000Z",
    ...overrides
  };
}

describe("detectConfirmedSourceLinks", () => {
  it("merges rows that name the same normalized url", () => {
    const a = source({ canonicalUrl: "https://example.com/story" });
    const b = source({ canonicalUrl: "https://example.com/story" });
    const links = detectConfirmedSourceLinks([a, b]);
    expect(links).toHaveLength(1);
    expect(links[0]?.kind).toBe("same_page");
    expect(links[0]?.confidence).toBe("confirmed");
  });

  it("recognises two different urls carrying identical content", () => {
    const a = source({
      canonicalUrl: "https://news.example.com/a",
      contentHash: "hash-abc"
    });
    const b = source({
      canonicalUrl: "https://mirror.example.com/b",
      contentHash: "hash-abc"
    });
    const links = detectConfirmedSourceLinks([a, b]);
    expect(links.map((link) => link.kind)).toEqual(["duplicate"]);
  });

  it("leaves pages with nothing in common unlinked", () => {
    const a = source({ canonicalUrl: "https://a.example.com/x", contentHash: "h1" });
    const b = source({ canonicalUrl: "https://b.example.com/y", contentHash: "h2" });
    expect(detectConfirmedSourceLinks([a, b])).toHaveLength(0);
  });
});

describe("summarizeIndependence", () => {
  it("says '5 pages, 1 independent source' when five pages are one story", () => {
    const sources = [
      source({ contentHash: "wire" }),
      source({ contentHash: "wire" }),
      source({ contentHash: "wire" }),
      source({ contentHash: "wire" }),
      source({ contentHash: "wire" })
    ];
    const links = detectConfirmedSourceLinks(sources);
    const summary = summarizeIndependence({
      sessionId: "session-1",
      sources,
      links
    });
    expect(summary.pages).toBe(5);
    expect(summary.confirmedIndependentSources).toBe(1);
    expect(independenceHeadline(summary)).toBe("5 个页面、1 条独立信息源");
  });

  it("does not merge mere similarity into the independent count", () => {
    const sources = [
      source({ canonicalUrl: "https://a.example.com/1" }),
      source({ canonicalUrl: "https://a.example.com/2" })
    ];
    const suspected: SourceLink[] = [
      {
        fromSourceId: sources[0]!.id,
        toSourceId: sources[1]!.id,
        kind: "near_duplicate",
        basis: "text_similarity",
        confidence: "suspected",
        similarity: 0.95,
        reason: "文本高度相似",
        origin: "system"
      }
    ];
    const summary = summarizeIndependence({
      sessionId: "session-1",
      sources,
      links: suspected
    });
    // Confirmed view still sees two sources; the lower bound shows the range.
    expect(summary.confirmedIndependentSources).toBe(2);
    expect(summary.suspectedIndependentSources).toBe(1);
    expect(summary.suspectedLinks).toHaveLength(1);
    expect(independenceHeadline(summary)).toContain("1–2 条独立信息源");
    expect(independenceHeadline(summary)).toContain("疑似重复待确认");
  });

  it("counts a handful of unrelated pages as that many sources", () => {
    const sources = [source(), source(), source()];
    const summary = summarizeIndependence({
      sessionId: "session-1",
      sources,
      links: []
    });
    expect(summary.confirmedIndependentSources).toBe(3);
    expect(summary.unlinkedSourceIds).toHaveLength(3);
  });
});

describe("mergeSourceLinks", () => {
  it("lets a human assertion replace what was detected for that pair", () => {
    const a = source({ canonicalUrl: "https://example.com/p" });
    const b = source({ canonicalUrl: "https://example.com/p" });
    const detected = detectConfirmedSourceLinks([a, b]);
    const merged = mergeSourceLinks({
      detected,
      assertions: [
        relation({
          fromSourceId: a.id,
          toSourceId: b.id,
          kind: "unrelated",
          reason: "编辑确认这是两个不同的报道，只是标题相同。"
        })
      ]
    });
    // The detected duplicate link is gone…
    expect(
      merged.filter((link) => link.kind !== "unrelated")
    ).toHaveLength(0);
    // …and the person's statement of independence survives as a confirmed
    // link, so readers after this point can still see the ruling.
    expect(merged).toHaveLength(1);
    expect(merged[0]?.kind).toBe("unrelated");
    expect(merged[0]?.confidence).toBe("confirmed");
    expect(merged[0]?.origin).toBe("human");
  });

  it("keeps a human 'unrelated' statement out of the merge", () => {
    const a = source({ canonicalUrl: "https://example.com/p" });
    const b = source({ canonicalUrl: "https://example.com/p" });
    const links = mergeSourceLinks({
      detected: detectConfirmedSourceLinks([a, b]),
      assertions: [
        relation({ fromSourceId: a.id, toSourceId: b.id, kind: "unrelated" })
      ]
    });
    const summary = summarizeIndependence({
      sessionId: "session-1",
      sources: [a, b],
      links
    });
    // Detection alone would have merged the identical url into one source;
    // the ruling overrides the merge and the count reflects it.
    expect(summary.confirmedIndependentSources).toBe(2);
    expect(summary.clusters.every((cluster) => cluster.pageCount === 1)).toBe(
      true
    );
    expect(
      summary.clusters.flatMap((cluster) => cluster.confirmedKinds)
    ).not.toContain("unrelated");
    // The pair is no longer unexamined: a human ruled on it.
    expect(summary.unlinkedSourceIds).toHaveLength(0);
  });

  it("adds a human-declared link that detection could not make", () => {
    const a = source();
    const b = source();
    const merged = mergeSourceLinks({
      detected: [],
      assertions: [
        relation({ fromSourceId: a.id, toSourceId: b.id, kind: "reprint" })
      ]
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.origin).toBe("human");
    expect(merged[0]?.confidence).toBe("confirmed");
  });
});

describe("detectSuspectedSourceLinks", () => {
  it("flags near-identical fingerprints but never as confirmed", () => {
    const a = source();
    const b = source();
    const links = detectSuspectedSourceLinks({
      sources: [a, b],
      fingerprints: { [a.id]: "ffffffff", [b.id]: "ffffffff" }
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.confidence).toBe("suspected");
    expect(links[0]?.kind).toBe("near_duplicate");
  });

  it("leaves dissimilar fingerprints alone", () => {
    const a = source();
    const b = source();
    const links = detectSuspectedSourceLinks({
      sources: [a, b],
      fingerprints: { [a.id]: "ffffffff", [b.id]: "00000000" },
      similarityThreshold: 0.92
    });
    expect(links).toHaveLength(0);
  });

  it("screens at the calibrated threshold in both directions", () => {
    const a = source();
    const b = source();

    /*
     * These are real values produced by the shipped fingerprint for a
     * 35-character Chinese sentence: `f57afbc2…` is the sentence itself,
     * `f57aebc2…` the same sentence with its final full stop changed to an
     * exclamation mark (~0.91), and `2926e96b…` an unrelated sentence (~0.47).
     * The screen has to accept the first pair and reject the second, which is
     * what makes the default threshold a calibrated number rather than a
     * guess.
     */
    expect(
      detectSuspectedSourceLinks({
        sources: [a, b],
        fingerprints: { [a.id]: "f57afbc23cb4abae", [b.id]: "f57aebc22c84ebee" }
      })
    ).toHaveLength(1);

    expect(
      detectSuspectedSourceLinks({
        sources: [a, b],
        fingerprints: { [a.id]: "f57afbc23cb4abae", [b.id]: "2926e96be98cc670" }
      })
    ).toHaveLength(0);
  });
});

describe("simhashSimilarity", () => {
  it("is 1 for identical fingerprints and 0 for opposite ones", () => {
    expect(simhashSimilarity("ffffffff", "ffffffff")).toBe(1);
    expect(simhashSimilarity("ffffffff", "00000000")).toBe(0);
  });
});

describe("buildSourceProfile", () => {
  it("does not invent a provenance kind when nothing supports one", () => {
    const profile = buildSourceProfile({ source: source() });
    expect(profile.provenanceKind).toBe("unknown");
    expect(profile.provenanceReasons.join()).toContain("判定来源类型");
    expect(profile.limitations.length).toBeGreaterThan(0);
  });

  it("treats a dataset as primary material", () => {
    const profile = buildSourceProfile({ source: source({ kind: "dataset" }) });
    expect(profile.provenanceKind).toBe("dataset");
  });

  it("calls a source secondary when it cites another source in the session", () => {
    const profile = buildSourceProfile({
      source: source(),
      referencesSourceIds: ["source-upstream"]
    });
    expect(profile.provenanceKind).toBe("secondary");
  });

  it("lets a human override win and records who decided", () => {
    const profile = buildSourceProfile({
      source: source(),
      override: {
        id: "override-1",
        sessionId: "session-1",
        sourceId: "source-1",
        provenanceKind: "primary",
        note: "确认这是统计局原始发布。",
        origin: "human",
        actor: "Researcher (researcher)",
        supersedesId: null,
        isCurrent: true,
        createdAt: "2026-10-02T00:00:00.000Z"
      }
    });
    expect(profile.provenanceKind).toBe("primary");
    expect(profile.provenanceOrigin).toBe("human");
    expect(profile.provenanceReasons.join()).toContain("Researcher");
  });

  it("labels a very old publication as possibly outdated", () => {
    const profile = buildSourceProfile({
      source: source({ publishedAt: "2015-01-01T00:00:00.000Z" }),
      asOf: new Date("2026-10-10T00:00:00.000Z")
    });
    expect(profile.qualityLabels.join()).toContain("超过");
    expect(profile.limitations.join()).toContain("可能已过期");
  });
});
