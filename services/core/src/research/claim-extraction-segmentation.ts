/**
 * Splits a capture into pieces small enough to ask about, and large enough to
 * still carry a claim's meaning.
 *
 * Segmentation exists for two reasons. First, a whole page does not fit in one
 * request. Second — the more important one — every suggestion must be traceable:
 * a candidate records which slice it came from, so a reviewer can go back to
 * that slice and read the sentence the model was actually looking at.
 *
 * The split is by paragraph, never mid-sentence. Cutting inside a sentence is
 * how a conditional quietly becomes an absolute.
 */

export type TextSegment = {
  index: number;
  /** Offset of the first character inside the full capture. */
  charStart: number;
  /** Offset just past the last character. */
  charEnd: number;
  text: string;
};

/**
 * Version stamped onto every run that used it. If this ever changes, cached
 * input hashes change with it and the stored answers are invalidated rather
 * than silently attributed to a different slicing.
 */
export const SEGMENTATION_VERSION = "paragraph-v1";

const DEFAULT_MAX_SEGMENT_CHARS = 6000;
const DEFAULT_MAX_SEGMENTS = 24;

export type SegmentOptions = {
  maxChars?: number;
  maxSegments?: number;
};

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * Segments by blank-line-separated paragraph, joining neighbours back together
 * until the piece reaches roughly `maxChars`, then starting a new one.
 *
 * A single paragraph longer than the budget is kept whole unless it exceeds
 * twice the budget; cutting it would drop the context that makes it readable,
 * and the limit here is about keeping requests sane, not about precision.
 */
export function segmentText(
  content: string,
  options: SegmentOptions = {}
): TextSegment[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_SEGMENT_CHARS;
  const maxSegments = options.maxSegments ?? DEFAULT_MAX_SEGMENTS;
  const normalized = content.replace(/\r\n/g, "\n");
  const paragraphs = normalized.split(/\n{2,}/).filter((part) => !isBlank(part));
  if (paragraphs.length === 0) {
    return [];
  }

  const segments: TextSegment[] = [];
  let buffer = "";
  let bufferStart = -1;
  let cursor = 0;

  const flush = () => {
    if (buffer.trim().length === 0) {
      buffer = "";
      bufferStart = -1;
      return;
    }
    segments.push({
      index: segments.length,
      charStart: bufferStart,
      charEnd: bufferStart + buffer.length,
      text: buffer.trim()
    });
    buffer = "";
    bufferStart = -1;
  };

  for (const paragraph of paragraphs) {
    const start = normalized.indexOf(paragraph, cursor);
    cursor = start >= 0 ? start + paragraph.length : cursor + paragraph.length;
    if (bufferStart === -1) {
      bufferStart = start >= 0 ? start : 0;
    }

    if (buffer.length === 0) {
      buffer = paragraph;
    } else if (buffer.length + 2 + paragraph.length <= maxChars) {
      buffer = `${buffer}\n\n${paragraph}`;
    } else {
      flush();
      buffer = paragraph;
      bufferStart = start >= 0 ? start : 0;
    }

    const oversized = paragraph.length > maxChars * 2;
    if (buffer.length >= maxChars || oversized) {
      flush();
    }

    if (segments.length >= maxSegments) {
      break;
    }
  }
  flush();

  return segments.slice(0, maxSegments);
}

/**
 * The few sentences around a quote, so a candidate can be read in context
 * instead of as a floating sentence.
 */
export function contextAround(
  segment: string,
  excerpt: string,
  radius = 160
): string | undefined {
  const index = segment.indexOf(excerpt);
  if (index < 0) {
    return undefined;
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(segment.length, index + excerpt.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < segment.length ? "…" : "";
  return `${prefix}${segment.slice(start, end)}${suffix}`;
}
