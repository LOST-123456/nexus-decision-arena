import { describe, expect, it } from "vitest";
import { assessCitationIntegrity, type CaptureVersion } from "./citation-integrity";

/**
 * Layer A is deterministic: these tests describe what the server may honestly
 * assert about a citation given the captures it actually holds.
 *
 * The distinctions being protected:
 *  - "cannot be checked" is not "failed the check";
 *  - a quote found in a different version is `stale`, not silently `anchored`;
 *  - a truncated quote is `partial`, not `anchored`;
 *  - nothing here ever forms an opinion about truth.
 */

const CURRENT: CaptureVersion = {
  id: "snap-current",
  contentHash: "hash-current",
  content:
    "Shipments grew 12% year over year.\n\n" +
    "The agency expects growth to continue.\n\n" +
    "Analysts remain cautious about the second half."
};

const OLDER: CaptureVersion = {
  id: "snap-older",
  contentHash: "hash-older",
  content:
    "Shipments grew 12% year over year.\n\n" +
    "The agency expects growth to continue because demand recovered."
};

function base(overrides: Partial<Parameters<typeof assessCitationIntegrity>[0]>) {
  return {
    anchorText: null,
    typedLocator: null,
    expectedContentHash: null,
    current: CURRENT,
    history: [] as CaptureVersion[],
    ...overrides
  };
}

describe("assessCitationIntegrity — states that are not a failure", () => {
  it("reports an excerpt with neither quote nor locator as unregistered", () => {
    const result = assessCitationIntegrity(base({}));
    expect(result.status).toBe("unmapped");
    expect(result.reason).toContain("未登记引用");
  });

  it("reports a hand-typed locator without a quote as unregistered too", () => {
    const result = assessCitationIntegrity(
      base({ typedLocator: "第 3 段中间那句" })
    );
    expect(result.status).toBe("unmapped");
    expect(result.reason).toContain("第 3 段中间那句");
  });

  it("does not call a source with no stored text 'missing'", () => {
    const result = assessCitationIntegrity(
      base({ anchorText: "Shipments grew 12%", current: null })
    );
    expect(result.status).toBe("unanchored");
    expect(result.reason).toContain("没有保存可检索的原文");
  });
});

describe("assessCitationIntegrity — anchored", () => {
  it("matches verbatim in the same version", () => {
    const result = assessCitationIntegrity(
      base({
        anchorText: "Shipments grew 12% year over year.",
        expectedContentHash: "hash-current"
      })
    );
    expect(result.status).toBe("anchored");
    expect(result.matchKind).toBe("exact");
    expect(result.contextText).toContain("Shipments grew 12%");
  });

  it("still anchors an excerpt with no recorded version, as a first confirmation", () => {
    const result = assessCitationIntegrity(
      base({ anchorText: "Analysts remain cautious about the second half." })
    );
    expect(result.status).toBe("anchored");
    expect(result.matchKind).toBe("exact");
  });

  it("matches through a reflowed page and says so", () => {
    const reflowed: CaptureVersion = {
      id: "snap-current",
      contentHash: "hash-current",
      content: "Shipments   grew\n12% year over year."
    };
    const result = assessCitationIntegrity(
      base({
        anchorText: "Shipments grew 12% year over year.",
        current: reflowed
      })
    );
    expect(result.status).toBe("anchored");
    expect(result.matchKind).toBe("normalized");
  });
});

describe("assessCitationIntegrity — the version matters", () => {
  it("marks a quote found in a changed capture as stale, not anchored", () => {
    const result = assessCitationIntegrity(
      base({
        anchorText: "Shipments grew 12% year over year.",
        expectedContentHash: "hash-older"
      })
    );
    // The words are still there, but nobody has re-read this citation since
    // the page moved, so asserting `anchored` would be a claim we cannot make.
    expect(result.status).toBe("stale");
    expect(result.reason).toContain("版本已变化");
  });

  it("marks a quote that only survives in an older capture as stale", () => {
    const result = assessCitationIntegrity(
      base({
        anchorText: "The agency expects growth to continue because demand recovered.",
        expectedContentHash: "hash-current",
        history: [OLDER]
      })
    );
    expect(result.status).toBe("stale");
    expect(result.reason).toContain("较早的一份快照");
  });

  it("distinguishes 'gone everywhere' from 'gone from this version'", () => {
    const result = assessCitationIntegrity(
      base({
        anchorText: "Demand collapsed in the fourth quarter.",
        expectedContentHash: "hash-older",
        history: [OLDER]
      })
    );
    expect(result.status).toBe("missing");
    expect(result.matchedText).toBeNull();
  });
});

describe("assessCitationIntegrity — truncated and spliced quotes", () => {
  it("accepts an elided quote only when every fragment resolves in order", () => {
    const result = assessCitationIntegrity(
      base({
        anchorText: "Shipments grew 12% … Analysts remain cautious about the second half.",
        expectedContentHash: "hash-current"
      })
    );
    expect(result.status).toBe("anchored");
    expect(result.matchKind).toBe("elided");
  });

  it("marks a quote whose later fragment is missing as incomplete", () => {
    const result = assessCitationIntegrity(
      base({
        anchorText: "Shipments grew 12% … Demand collapsed in the fourth quarter.",
        expectedContentHash: "hash-current"
      })
    );
    expect(result.status).toBe("partial");
    expect(result.matchedText).toBe("Shipments grew 12%");
    expect(result.reason).toContain("引用不完整");
  });

  it("does not accept fragments stitched together out of order", () => {
    const result = assessCitationIntegrity(
      base({
        anchorText: "Analysts remain cautious about the second half. … Shipments grew 12%",
        expectedContentHash: "hash-current"
      })
    );
    // The second fragment appears before the first in the page, so this is not
    // a quote of one passage.
    expect(result.status).toBe("partial");
  });
});
