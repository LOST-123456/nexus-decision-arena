import type { Evidence, SourceSnapshot } from "@nexus/shared";
import type {
  DiffHighlight,
  SnapshotDiff,
  SnapshotDiffSegment
} from "@nexus/shared";
import { findAnchor } from "./html-extract";

/**
 * Compares two stored captures of one source.
 *
 * A pure function over two snapshots: no table is written, no verdict is
 * touched, and the older capture is never modified — the whole point is that
 * both versions survive and a person can see what moved.
 *
 * What it produces:
 *  - paragraph-level segments (`same` / `added` / `removed`) from an LCS over
 *    paragraphs, with long unchanged runs collapsed so the diff stays readable;
 *  - advisory highlights: numbers, dates and negations that appear in a moved
 *    segment. A moved number is worth a second look; it is not a finding that
 *    the fact changed;
 *  - the excerpts that were anchored in the older version and are absent from
 *    the newer one, named so a researcher does not have to hunt for them.
 */

/** Collapsed unchanged runs longer than this are elided in the middle. */
const SAME_SEGMENT_LIMIT = 480;
/** One moved paragraph is capped so a huge insertion cannot flood the diff. */
const MOVED_SEGMENT_LIMIT = 4000;
/** How many advisory highlights are reported at most. */
const MAX_HIGHLIGHTS = 24;
/**
 * LCS cells are bounded by grouping paragraphs into blocks, so a pathological
 * pair of 200k-character captures cannot allocate an unbounded matrix.
 */
const MAX_LCS_CELLS = 4_000_000;
const BLOCK_SIZE = 8;

const NUMBER_PATTERN = /(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(?:%|％|元|美元|欧元|万元|亿元|万|亿|人次|个百分点|pp)?/g;
const DATE_PATTERN =
  /\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?|\d{1,2}\s*[-/月]\s*\d{1,2}\s*日/g;
const NEGATION_PATTERN = /(?:不再|并非|没有|无|非|未|否|禁止|拒不|从未|绝不)/g;

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}

function collapseSame(text: string): string {
  if (text.length <= SAME_SEGMENT_LIMIT) return text;
  const head = text.slice(0, 200);
  const tail = text.slice(-200);
  const omitted = text.length - 400;
  return `${head}\n…[中部未变化 ${omitted} 字已省略]…\n${tail}`;
}

function capMoved(text: string): string {
  if (text.length <= MOVED_SEGMENT_LIMIT) return text;
  return `${text.slice(0, MOVED_SEGMENT_LIMIT)}…[已省略 ${text.length - MOVED_SEGMENT_LIMIT} 字]`;
}

/**
 * Groups paragraphs into blocks when the pair is too large for a cell-bounded
 * LCS. Blocking keeps the comparison deterministic and total work bounded; the
 * granularity is coarser, and that is the honest trade for refusing to allocate
 * without limit.
 */
function align(
  previous: readonly string[],
  current: readonly string[]
): Array<{ kind: "same" | "removed" | "added"; paragraphs: string[] }> {
  let left = [...previous];
  let right = [...current];
  let block = 1;
  while (
    (left.length + 1) * (right.length + 1) > MAX_LCS_CELLS &&
    block < 64
  ) {
    block = Math.min(64, block * BLOCK_SIZE);
    left = groupInto(left, block);
    right = groupInto(right, block);
  }

  const rows = left.length;
  const columns = right.length;
  // Classic LCS table, one row at a time as a flat Int32Array.
  const width = columns + 1;
  const table = new Int32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(
              table[(i + 1) * width + j]!,
              table[i * width + j + 1]!
            );
    }
  }

  const aligned: Array<{
    kind: "same" | "removed" | "added";
    paragraphs: string[];
  }> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      push(aligned, "same", left[i]!);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      push(aligned, "removed", left[i]!);
      i += 1;
    } else {
      push(aligned, "added", right[j]!);
      j += 1;
    }
  }
  while (i < rows) {
    push(aligned, "removed", left[i]!);
    i += 1;
  }
  while (j < columns) {
    push(aligned, "added", right[j]!);
    j += 1;
  }
  return aligned;
}

function groupInto(paragraphs: string[], size: number): string[] {
  const grouped: string[] = [];
  for (let index = 0; index < paragraphs.length; index += size) {
    grouped.push(paragraphs.slice(index, index + size).join("\n"));
  }
  return grouped;
}

function push(
  aligned: Array<{ kind: "same" | "removed" | "added"; paragraphs: string[] }>,
  kind: "same" | "removed" | "added",
  paragraph: string
): void {
  const last = aligned[aligned.length - 1];
  if (last && last.kind === kind) {
    last.paragraphs.push(paragraph);
    return;
  }
  aligned.push({ kind, paragraphs: [paragraph] });
}

function highlightsOf(
  segments: readonly SnapshotDiffSegment[]
): DiffHighlight[] {
  const highlights: DiffHighlight[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    if (segment.kind === "same") continue;
    const matches: Array<{ kind: DiffHighlight["kind"]; text: string }> = [];
    for (const match of segment.text.matchAll(DATE_PATTERN)) {
      matches.push({ kind: "date", text: match[0] });
    }
    for (const match of segment.text.matchAll(NUMBER_PATTERN)) {
      const text = match[0].trim();
      if (text.length > 0) matches.push({ kind: "number", text });
    }
    for (const match of segment.text.matchAll(NEGATION_PATTERN)) {
      matches.push({ kind: "negation", text: match[0] });
    }
    for (const match of matches) {
      const key = `${match.kind}|${match.text}|${segment.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      highlights.push({
        kind: match.kind,
        text: match.text,
        segment: segment.kind
      });
      if (highlights.length >= MAX_HIGHLIGHTS) return highlights;
    }
  }
  return highlights;
}

function missingExcerpts(
  excerpts: readonly Evidence[],
  previous: SourceSnapshot,
  current: SourceSnapshot
): SnapshotDiff["missingExcerpts"] {
  const missing: SnapshotDiff["missingExcerpts"] = [];
  for (const excerpt of excerpts) {
    const anchorText = excerpt.anchorText?.trim();
    if (!anchorText) continue;
    const inPrevious =
      findAnchor(previous.content, anchorText).status === "anchored";
    if (!inPrevious) continue;
    const inCurrent =
      findAnchor(current.content, anchorText).status === "anchored";
    if (inCurrent) continue;
    missing.push({
      evidenceId: excerpt.id,
      title: excerpt.title,
      anchorText
    });
  }
  return missing;
}

/**
 * The comparison itself.
 *
 * `previous` may be null when the source has only ever had one capture; the
 * diff then says so by reporting an empty segment list rather than inventing a
 * version to compare against.
 */
export function diffSnapshots(input: {
  sessionId: string;
  sourceId: string;
  previous: SourceSnapshot | null;
  current: SourceSnapshot | null;
  excerpts?: readonly Evidence[] | undefined;
}): SnapshotDiff {
  const previous = input.previous;
  const current = input.current;

  if (previous === null || current === null) {
    const only = current ?? previous;
    return {
      sourceId: input.sourceId,
      sessionId: input.sessionId,
      previousSnapshotId: previous?.id ?? null,
      currentSnapshotId: current?.id ?? null,
      previousContentHash: previous?.contentHash ?? null,
      currentContentHash: current?.contentHash ?? null,
      previousRetrievedAt: previous?.retrievedAt ?? null,
      currentRetrievedAt: current?.retrievedAt ?? null,
      previousCharCount: previous?.charCount ?? 0,
      currentCharCount: current?.charCount ?? 0,
      titleChanged: false,
      previousTitle: previous?.title ?? null,
      currentTitle: current?.title ?? null,
      segments: [],
      addedChars: 0,
      removedChars: 0,
      highlights: [],
      missingExcerpts: []
    };
  }

  const aligned = align(
    splitParagraphs(previous.content),
    splitParagraphs(current.content)
  );

  const segments: SnapshotDiffSegment[] = [];
  let addedChars = 0;
  let removedChars = 0;
  for (const entry of aligned) {
    const text = entry.paragraphs.join("\n");
    if (entry.kind === "same") {
      segments.push({ kind: "same", text: collapseSame(text) });
      continue;
    }
    if (entry.kind === "added") {
      addedChars += text.length;
      segments.push({ kind: "added", text: capMoved(text) });
      continue;
    }
    removedChars += text.length;
    segments.push({ kind: "removed", text: capMoved(text) });
  }

  return {
    sourceId: input.sourceId,
    sessionId: input.sessionId,
    previousSnapshotId: previous.id,
    currentSnapshotId: current.id,
    previousContentHash: previous.contentHash,
    currentContentHash: current.contentHash,
    previousRetrievedAt: previous.retrievedAt,
    currentRetrievedAt: current.retrievedAt,
    previousCharCount: previous.charCount,
    currentCharCount: current.charCount,
    titleChanged: (previous.title ?? null) !== (current.title ?? null),
    previousTitle: previous.title ?? null,
    currentTitle: current.title ?? null,
    segments,
    addedChars,
    removedChars,
    highlights: highlightsOf(segments),
    missingExcerpts: missingExcerpts(input.excerpts ?? [], previous, current)
  };
}
