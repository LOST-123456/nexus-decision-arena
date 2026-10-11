import { describe, expect, it } from "vitest";
import { simhashSimilarity, type Source } from "@nexus/shared";
import {
  extractExplicitReferences,
  normalizeReferencedUrl,
  sourceTextFingerprint
} from "./source-independence";

/**
 * The deterministic signals the independence analysis is built on.
 *
 * The rule that matters: these produce *evidence for a suspicion*, never a
 * conclusion. Nothing here asserts that two pages are the same source, and the
 * explicit-reference scan only accepts literal urls — turning prose such as
 * "转载自某某报" into a citation is how a fabricated provenance chain gets built.
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

describe("sourceTextFingerprint", () => {
  it("gives near-identical text a near-identical fingerprint", () => {
    const base =
      "国家统计局今日发布数据，上半年社会消费品零售总额同比增长百分之五点零。";
    const reworded =
      "国家统计局今日发布数据，上半年社会消费品零售总额同比增长百分之五点零！";
    const a = sourceTextFingerprint(base);
    const b = sourceTextFingerprint(base);
    // A hash: the same input always gives the same value.
    expect(a).toBe(b);

    /*
     * One changed character is one shingle out of thirty-two, so the value
     * does move. A simhash is a locality-sensitive hash, not a canonical one,
     * so asserting equality here would assert something untrue — what has to
     * hold is that near-identical text stays far closer to itself than two
     * unrelated sentences do, by a margin the calibrated screen can use.
     */
    expect(simhashSimilarity(a, sourceTextFingerprint(reworded))).toBeGreaterThan(
      0.85
    );
  });

  it("moves the fingerprint when the wording is genuinely different", () => {
    const left = sourceTextFingerprint(
      "The committee approved the budget after a long debate."
    );
    const right = sourceTextFingerprint(
      "Rainfall in the northern province reached a five year high."
    );
    expect(left).not.toBe(right);
    // …and the pair sits on the other side of the screen threshold.
    expect(simhashSimilarity(left, right)).toBeLessThan(0.7);
  });

  it("returns a stable value for empty text", () => {
    expect(sourceTextFingerprint("   ")).toBe("0000000000000000");
  });
});

describe("normalizeReferencedUrl", () => {
  it("ignores the fragment, the trailing slash and letter case in the host", () => {
    expect(normalizeReferencedUrl("HTTPS://Example.COM/a/#section")).toBe(
      "https://example.com/a"
    );
  });

  it("refuses something that is not a url", () => {
    expect(normalizeReferencedUrl("not a url")).toBeNull();
  });
});

describe("extractExplicitReferences", () => {
  it("finds a source this page links to", () => {
    const self = source({ canonicalUrl: "https://mirror.test/copy" });
    const upstream = source({ canonicalUrl: "https://origin.test/a" });
    const references = extractExplicitReferences({
      text: "本报道转载自 https://origin.test/a ，详见原文。",
      selfSourceId: self.id,
      sources: [self, upstream]
    });
    expect(references).toEqual([upstream.id]);
  });

  it("does not invent a reference from prose with no url", () => {
    const self = source({ canonicalUrl: "https://mirror.test/copy" });
    const upstream = source({ canonicalUrl: "https://origin.test/a" });
    const references = extractExplicitReferences({
      text: "本报道转载自某某报社，未经许可不得转载。",
      selfSourceId: self.id,
      sources: [self, upstream]
    });
    expect(references).toEqual([]);
  });

  it("ignores a link to a page outside the session", () => {
    const self = source({ canonicalUrl: "https://mirror.test/copy" });
    const references = extractExplicitReferences({
      text: "参考 https://elsewhere.test/unrelated 的资料。",
      selfSourceId: self.id,
      sources: [self]
    });
    expect(references).toEqual([]);
  });
});
