import { describeAnchor, findAnchor } from "./html-extract";

/**
 * Decides what a confirmed excerpt's locator state should be.
 *
 * Confirming an excerpt is the moment a researcher says "this is the sentence I
 * mean, in this page". What the server can honestly assert at that point is
 * only whether the sentence was actually found in the stored text — not
 * whether it is true, and not whether anyone has verified it. So this module
 * produces exactly one of three locator states and never touches verification.
 *
 * The distinction that matters:
 *  - `unanchored` — nobody has checked it. Either the researcher typed a
 *    description by hand, or there is no stored page text to check against.
 *  - `anchored`   — the excerpt was found verbatim in the current capture.
 *  - `missing`    — a capture exists and the excerpt is not in it, so the
 *    citation no longer resolves and the workspace must say so.
 *
 * A `missing` excerpt stays exactly as verified (or unverified) as it was: a
 * quote that vanished from a page it was taken from is a locator problem, not
 * a sudden verdict on the claim it supports.
 */

export type ExcerptAnchorPlan = {
  locatorStatus: "unanchored" | "anchored" | "missing";
  /** Human-readable position, or the researcher's own description. */
  locator: string | null;
  /** The exact excerpt used for locating. */
  anchorText: string | null;
  /**
   * Hash of the capture the excerpt was checked against, so later drift can be
   * attributed to the version it actually matched.
   */
  sourceContentHash: string | null;
};

export function planExcerptAnchor(input: {
  /** Text of the source's current capture, or null when there is none. */
  content: string | null;
  /** Hash of that capture, or null when there is none. */
  contentHash: string | null;
  /** The excerpt the researcher picked out of the reader. */
  anchorText: string | null;
  /** A locator the researcher typed, used when nothing can be searched. */
  typedLocator: string | null;
}): ExcerptAnchorPlan {
  const anchorText = input.anchorText?.trim() ? input.anchorText.trim() : null;
  const typedLocator =
    input.typedLocator?.trim() ? input.typedLocator.trim() : null;

  if (anchorText === null) {
    // Nothing to locate: any position is the researcher's own description and
    // must not be presented as a check the server performed.
    return {
      locatorStatus: "unanchored",
      locator: typedLocator,
      anchorText: null,
      sourceContentHash: null
    };
  }

  if (input.content === null || input.contentHash === null) {
    // An excerpt was picked, but this source has no stored text — a manual
    // source, or a page that was never captured. Not being able to check is
    // not the same as failing the check.
    return {
      locatorStatus: "unanchored",
      locator: typedLocator,
      anchorText,
      sourceContentHash: null
    };
  }

  const found = findAnchor(input.content, anchorText);
  if (found.status === "anchored") {
    return {
      locatorStatus: "anchored",
      locator: typedLocator ?? describeAnchor(input.content, found.index),
      anchorText,
      sourceContentHash: input.contentHash
    };
  }

  return {
    locatorStatus: "missing",
    locator: typedLocator ?? "无法在原文中定位",
    anchorText,
    sourceContentHash: input.contentHash
  };
}

/**
 * Re-checks an existing excerpt against the source's current capture.
 *
 * Returns null when there is nothing to re-check — no anchor, or no capture —
 * in which case the existing state is left alone rather than guessed at.
 */
export function recheckExcerpt(input: {
  content: string | null;
  contentHash: string | null;
  anchorText: string | null;
  typedLocator: string | null;
}): ExcerptAnchorPlan | null {
  if (!input.anchorText?.trim()) return null;
  if (input.content === null || input.contentHash === null) return null;
  return planExcerptAnchor(input);
}
