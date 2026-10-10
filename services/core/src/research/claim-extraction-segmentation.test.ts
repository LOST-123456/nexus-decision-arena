import { describe, expect, it } from "vitest";
import {
  contextAround,
  segmentText,
  SEGMENTATION_VERSION
} from "./claim-extraction-segmentation";

describe("segmentText", () => {
  it("returns nothing for empty or whitespace-only content", () => {
    expect(segmentText("")).toEqual([]);
    expect(segmentText("   \n\n  \n")).toEqual([]);
  });

  it("lets neighbouring paragraphs share a segment while they fit the budget", () => {
    const content = `${"One sentence here."}\n\n${"Two sentences here."}`;
    const segments = segmentText(content, { maxChars: 120 });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toContain("One sentence here.");
    expect(segments[0]!.text).toContain("Two sentences here.");
  });

  it("splits by paragraph when the budget is too small to hold two", () => {
    const first = "First paragraph about shipments.";
    const second = "Second paragraph about pricing.";
    const content = `${first}\n\n${second}`;
    const segments = segmentText(content, { maxChars: 40 });

    expect(segments).toHaveLength(2);
    expect(segments[0]!.index).toBe(0);
    expect(segments[0]!.text).toBe(first);
    // The recorded range has to point at the real text, otherwise "which slice
    // did this come from" would be a number nobody can follow.
    expect(content.slice(segments[0]!.charStart, segments[0]!.charEnd)).toBe(
      first
    );
    expect(segments[1]!.index).toBe(1);
    expect(content.slice(segments[1]!.charStart, segments[1]!.charEnd)).toBe(
      second
    );
  });

  it("joins short neighbours instead of cutting inside a paragraph", () => {
    const content = "One sentence here.\n\nTwo sentences here.\n\nThree here.";
    const segments = segmentText(content, { maxChars: 120 });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toContain("One sentence here.");
    expect(segments[0]!.text).toContain("Three here.");
  });

  it("starts a new segment once the budget is reached", () => {
    const paragraph = "x".repeat(60);
    const content = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const segments = segmentText(content, { maxChars: 60 });
    expect(segments.length).toBeGreaterThan(1);
  });

  it("stamps a version so a changed slicing invalidates cached hashes", () => {
    expect(SEGMENTATION_VERSION).toMatch(/v\d+$/);
  });

  it("caps how many pieces one page can be raised to", () => {
    const content = Array.from({ length: 40 }, (_, index) => `段落 ${index} 的内容。`).join(
      "\n\n"
    );
    const segments = segmentText(content, { maxSegments: 3, maxChars: 50 });
    expect(segments.length).toBeLessThanOrEqual(3);
  });
});

describe("contextAround", () => {
  it("returns the surrounding text with ellipses when trimmed", () => {
    const text = "前缀内容足够长以便被裁掉。核心句子在这里。后缀内容也足够长。";
    const context = contextAround(text, "核心句子在这里。", 4);
    expect(context).toBe("…被裁掉。核心句子在这里。后缀内容…");
  });

  it("returns undefined when the excerpt is not in this segment", () => {
    expect(contextAround("某个别的内容", "不在这里")).toBeUndefined();
  });
});
