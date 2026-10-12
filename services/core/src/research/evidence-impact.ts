import type { Evidence, EvidenceImpact, SourceSnapshot } from "@nexus/shared";
import { findAnchor } from "./html-extract";

/**
 * Derives what a source change does to each excerpt drawn from it.
 *
 * A pure function over persisted rows: it reads `locatorStatus` and
 * `verificationStatus` and carries them through untouched. Nothing here writes
 * anything, and nothing here re-rules on an excerpt — a quote that vanished
 * from a page is a locator problem, not a sudden verdict on the claim it
 * supports.
 *
 * The five outcomes, in the order they are checked:
 *  - `needs_review`    — nothing could be established: no anchor text, no
 *                        capture to compare against, or the quote is in
 *                        neither version. "We could not tell" is said as such.
 *  - `anchor_missing`  — the quote was in the old version and is not in the
 *                        new one. The citation no longer resolves.
 *  - `anchor_moved`    — still locatable, but at a different position, or not
 *                        present in the old version at all.
 *  - `content_changed` — the quote is still there at the same place, but the
 *                        text around it moved.
 *  - `unaffected`      — the quote and its surroundings are identical.
 */

/** How much context around the anchor is compared for `content_changed`. */
const CONTEXT_CHARS = 120;

function contextAround(
  content: string,
  index: number,
  length: number
): string {
  const from = Math.max(0, index - CONTEXT_CHARS);
  const to = Math.min(content.length, index + length + CONTEXT_CHARS);
  return content.slice(from, to);
}

export function deriveEvidenceImpacts(input: {
  excerpts: readonly Evidence[];
  previous: SourceSnapshot | null;
  current: SourceSnapshot | null;
}): EvidenceImpact[] {
  return input.excerpts.map((excerpt) =>
    impactFor(excerpt, input.previous, input.current)
  );
}

function impactFor(
  excerpt: Evidence,
  previous: SourceSnapshot | null,
  current: SourceSnapshot | null
): EvidenceImpact {
  const base = {
    evidenceId: excerpt.id,
    title: excerpt.title,
    locator: excerpt.locator ?? null,
    // The stored value, defaulted to the honest reading of an absent one:
    // nobody ever checked this excerpt against any version.
    locatorStatus: excerpt.locatorStatus ?? "unanchored",
    verificationStatus: excerpt.verificationStatus,
    direction: excerpt.direction
  };

  const anchorText = excerpt.anchorText?.trim() ?? "";
  if (anchorText.length === 0) {
    return {
      ...base,
      impact: "needs_review",
      reason: "该摘录没有锚定文本，无法自动比较；请人工确认其针对的来源版本。"
    };
  }
  if (current === null) {
    return {
      ...base,
      impact: "needs_review",
      reason: "该来源当前没有已保存的正文版本，无法比较；请先取得可读取的版本。"
    };
  }
  if (previous === null) {
    return {
      ...base,
      impact: "needs_review",
      reason: "该来源此前没有已保存的版本，无法判断变化；这通常是首次登记。"
    };
  }

  const inPrevious = findAnchor(previous.content, anchorText);
  const inCurrent = findAnchor(current.content, anchorText);

  if (inCurrent.status === "anchored" && inPrevious.status === "anchored") {
    const index = inCurrent.index;
    if (index !== inPrevious.index) {
      return {
        ...base,
        impact: "anchor_moved",
        reason: `摘录仍可在新版本中定位，但位置发生变化（旧版第 ${inPrevious.index} 字 → 新版第 ${index} 字）。`
      };
    }
    const previousContext = contextAround(
      previous.content,
      inPrevious.index,
      anchorText.length
    );
    const currentContext = contextAround(
      current.content,
      index,
      anchorText.length
    );
    if (previousContext !== currentContext) {
      return {
        ...base,
        impact: "content_changed",
        reason: "摘录原文仍在新版本中且位置未变，但其上下文文字发生了变化，建议重新阅读。"
      };
    }
    return {
      ...base,
      impact: "unaffected",
      reason: "摘录在新版本中原样存在，上下文也未变化。"
    };
  }

  if (inPrevious.status === "anchored" && inCurrent.status !== "anchored") {
    return {
      ...base,
      impact: "anchor_missing",
      reason: "该摘录出现在旧版本中，但在新版本里已找不到：引用不再能对回原文。"
    };
  }

  if (inCurrent.status === "anchored") {
    return {
      ...base,
      impact: "anchor_moved",
      reason: "摘录在新版本中可以定位，但未出现在旧版本中：它可能针对更早或另一个版本。"
    };
  }

  return {
    ...base,
    impact: "needs_review",
    reason: "该摘录在旧版本与新版本中都无法定位，无法自动判断；请人工确认。"
  };
}
