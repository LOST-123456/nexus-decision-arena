import type {
  CitationIntegrityStatus,
  CitationMatchKind
} from "@nexus/shared";
import { findAnchor } from "./html-extract";

/**
 * Layer A: does this citation still exist, in the version it was taken from,
 * exactly as recorded?
 *
 * This is a question about stored text and it is answered here, by the server,
 * every time. No model is involved and no model result can override it, which
 * is what makes the answer defensible: it is a lookup plus a version
 * comparison, not an opinion.
 *
 * The states are deliberately not collapsed into `evidence.locator_status`:
 * that column records whether an excerpt is currently findable, while a check
 * additionally records *which version* was searched, what matched, and why.
 * A quote that is still present can therefore still be reported `stale` when
 * the page moved — silently re-stamping it "anchored" would hide the fact that
 * nobody has re-read it since.
 */

export type CaptureVersion = {
  id: string;
  contentHash: string;
  content: string;
};

export type IntegrityInput = {
  /** The exact text the excerpt claims to quote. */
  anchorText: string | null;
  /** A locator the researcher typed by hand, when there is no anchor. */
  typedLocator: string | null;
  /** Version the excerpt was anchored against, when one was recorded. */
  expectedContentHash: string | null;
  /** The source's current capture, or null when it has none. */
  current: CaptureVersion | null;
  /** Older captures of the same source, newest first. */
  history: readonly CaptureVersion[];
};

export type IntegrityAssessment = {
  status: CitationIntegrityStatus;
  matchKind: CitationMatchKind | null;
  matchedText: string | null;
  /** The text around the first match, so a reader can see the quote in place. */
  contextText: string | null;
  reason: string;
};

/** Quotes that skip over the middle of a sentence are split on these. */
const ELISION = /…|\.\.\.|\[…\]|\[\.\.\.\]|〔…〕/;

function splitFragments(anchorText: string): string[] {
  return anchorText
    .split(ELISION)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function locate(
  content: string,
  fragment: string
): { index: number; exact: boolean } | null {
  const needle = fragment.trim();
  if (needle.length === 0) return null;
  const exact = content.indexOf(needle);
  if (exact !== -1) {
    return { index: exact, exact: true };
  }
  const found = findAnchor(content, needle);
  if (found.status === "anchored") {
    return { index: found.index, exact: false };
  }
  return null;
}

const CONTEXT_RADIUS = 180;

function surround(content: string, index: number): string {
  const start = Math.max(0, index - CONTEXT_RADIUS);
  const end = Math.min(content.length, index + CONTEXT_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end)}${suffix}`;
}

/**
 * Searches one capture for the anchor, handling elided quotes fragment by
 * fragment so a truncated or spliced quote is distinguishable from a real one.
 */
function searchCapture(
  capture: CaptureVersion,
  anchorText: string
):
  | { status: "anchored"; matchKind: CitationMatchKind; index: number }
  | { status: "partial"; matchedText: string | null; index: number }
  | { status: "missing" } {
  const fragments = splitFragments(anchorText);
  if (fragments.length === 0) {
    return { status: "missing" };
  }

  if (fragments.length === 1) {
    const found = locate(capture.content, fragments[0]!);
    if (!found) return { status: "missing" };
    return {
      status: "anchored",
      matchKind: found.exact ? "exact" : "normalized",
      index: found.index
    };
  }

  // An elided quote has to resolve in order: the fragments must appear one
  // after another, otherwise what is being shown is a splice of two places.
  let cursor = 0;
  let firstIndex = -1;
  let normalized = false;
  const resolved: string[] = [];
  for (const fragment of fragments) {
    const slice = capture.content.slice(cursor);
    const relative = locate(slice, fragment);
    if (!relative) {
      return {
        status: "partial",
        matchedText: resolved.length > 0 ? resolved.join(" … ") : null,
        index: firstIndex === -1 ? 0 : firstIndex
      };
    }
    const absolute = cursor + relative.index;
    if (firstIndex === -1) firstIndex = absolute;
    if (!relative.exact) normalized = true;
    resolved.push(fragment);
    cursor = absolute + fragment.length;
  }

  return {
    status: "anchored",
    matchKind: normalized ? "normalized" : "elided",
    index: firstIndex === -1 ? 0 : firstIndex
  };
}

/**
 * Decides the integrity state of one citation.
 *
 * Order matters: "cannot be checked" answers come first, because reporting a
 * source with no stored text as `missing` would accuse the researcher of a bad
 * quote when the truth is that nothing was ever captured.
 */
export function assessCitationIntegrity(
  input: IntegrityInput
): IntegrityAssessment {
  const anchorText = input.anchorText?.trim() ? input.anchorText.trim() : null;
  const typedLocator = input.typedLocator?.trim()
    ? input.typedLocator.trim()
    : null;

  if (anchorText === null) {
    return {
      status: "unmapped",
      matchKind: null,
      matchedText: null,
      contextText: null,
      reason: typedLocator
        ? `未登记引用：只记录了人工定位描述「${typedLocator}」，没有可核对的原文摘录，无法核查。`
        : "未登记引用：既没有摘录原文也没有定位信息，无法核查。"
    };
  }

  if (input.current === null) {
    return {
      status: "unanchored",
      matchKind: null,
      matchedText: null,
      contextText: null,
      reason:
        "该来源没有保存可检索的原文（手工来源或从未抓取），无法核查；这不等于引用失效。"
    };
  }

  const inCurrent = searchCapture(input.current, anchorText);

  const versionChanged =
    input.expectedContentHash !== null &&
    input.expectedContentHash !== input.current.contentHash;

  if (inCurrent.status === "anchored") {
    const matchedText = anchorText;
    const contextText = surround(input.current.content, inCurrent.index);
    if (versionChanged) {
      return {
        status: "stale",
        matchKind: inCurrent.matchKind,
        matchedText,
        contextText,
        reason:
          `摘录仍能在当前原文中找到（${
            inCurrent.matchKind === "exact"
              ? "精确匹配"
              : inCurrent.matchKind === "normalized"
                ? "按折叠空白匹配"
                : "省略片段按顺序匹配"
          }），但快照版本已变化：` +
          `锚定时记录的版本与当前版本不同，需要人工重新确认。`
      };
    }
    return {
      status: "anchored",
      matchKind: inCurrent.matchKind,
      matchedText,
      contextText,
      reason:
        inCurrent.matchKind === "exact"
          ? "摘录在当前快照中完整、精确命中，且版本一致。"
          : inCurrent.matchKind === "normalized"
            ? "摘录在当前快照中命中（页面换行/空白有变化，文字一致）。"
            : "省略引用的每个片段都能在当前快照中按顺序找到。"
    };
  }

  if (inCurrent.status === "partial") {
    return {
      status: "partial",
      matchKind: null,
      matchedText: inCurrent.matchedText,
      contextText: surround(input.current.content, inCurrent.index),
      reason:
        "引用不完整：这是一条省略引用，其中部分片段未能在当前原文中按顺序找到，" +
        "读者看到的是被截断或拼接过的句子，需要人工核对原文。"
    };
  }

  // Not in the current version. An older capture may still hold it, which is
  // the case worth naming: the quote is not invented, the page moved on.
  for (const older of input.history) {
    if (older.id === input.current.id) continue;
    if (older.contentHash === input.current.contentHash) continue;
    const inOlder = searchCapture(older, anchorText);
    if (inOlder.status === "anchored") {
      return {
        status: "stale",
        matchKind: inOlder.matchKind,
        matchedText: anchorText,
        contextText: surround(older.content, inOlder.index),
        reason:
          "摘录已不在当前快照中，但能在较早的一份快照里找到：来源内容已更新，" +
          "该引用需要人工重新确认或换新版本。"
      };
    }
  }

  return {
    status: "missing",
    matchKind: null,
    matchedText: null,
    contextText: null,
    reason:
      versionChanged
        ? "摘录在当前快照中找不到，历史快照中也找不到；锚定版本与当前版本不同，引用已无法定位。"
        : "摘录在当前快照和历史快照中都找不到，引用已无法定位。"
  };
}
