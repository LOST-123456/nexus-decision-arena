/**
 * Turns a fetched HTML or plain-text body into the text a researcher reads.
 *
 * This is deliberately a string transformation, not a browser: nothing here
 * executes scripts, loads subresources or interprets markup. The fetched bytes
 * are untrusted data from the open internet, so the output is plain text that
 * the UI renders as text — never as markup.
 *
 * The same normalization is used to record a snapshot and to locate an excerpt
 * inside it, so the offsets a reader sees are the offsets the anchor search
 * later uses.
 */

const DROPPED_ELEMENTS: readonly string[] = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "embed",
  "canvas",
  "head",
  "nav",
  "form"
];

/** Elements whose end implies a line break in the extracted text. */
const BLOCK_ELEMENTS: readonly string[] = [
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "blockquote",
  "figure",
  "figcaption",
  "table",
  "thead",
  "tbody",
  "tr",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "hr",
  "br"
];

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  times: "×",
  copy: "©",
  reg: "®",
  deg: "°",
  permil: "‰",
  laquo: "«",
  raquo: "»",
  bull: "•",
  minus: "−",
  shy: ""
};

export function decodeEntities(input: string): string {
  return input.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const isHex = entity[1] === "x" || entity[1] === "X";
        const digits = isHex ? entity.slice(2) : entity.slice(1);
        const code = Number.parseInt(digits, isHex ? 16 : 10);
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
        // Surrogates and the null code point are not valid characters.
        if (code >= 0xd800 && code <= 0xdfff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      const named = NAMED_ENTITIES[entity.toLowerCase()];
      return named === undefined ? match : named;
    }
  );
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ");
}

function stripDroppedElements(html: string): string {
  let output = html;
  for (const tag of DROPPED_ELEMENTS) {
    // An unclosed dropped element would hide the rest of the document, so the
    // unterminated case falls back to dropping through the end of input.
    output = output.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi"),
      " "
    );
    output = output.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), " ");
  }
  return output;
}

function blockBoundariesToNewlines(html: string): string {
  const pattern = new RegExp(`</?(?:${BLOCK_ELEMENTS.join("|")})\\b[^>]*>`, "gi");
  return html.replace(pattern, "\n");
}

/** Collapses runs of whitespace but keeps paragraph breaks meaningful. */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0\u200b]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

export function htmlToPlainText(html: string): string {
  const withoutComments = stripComments(html);
  const withoutDropped = stripDroppedElements(withoutComments);
  const withBreaks = blockBoundariesToNewlines(withoutDropped);
  const withoutTags = withBreaks.replace(/<[^>]*>/g, " ");
  return normalizeText(decodeEntities(withoutTags));
}

function firstMatch(input: string, pattern: RegExp): string | null {
  const match = pattern.exec(input);
  const value = match?.[1];
  if (value === undefined) return null;
  const decoded = decodeEntities(value).trim();
  return decoded.length > 0 ? decoded : null;
}

function metaContent(html: string, keys: readonly string[]): string | null {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Attribute order is not guaranteed in the wild, so both orders are tried.
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:name|property)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
        "i"
      ),
      new RegExp(
        `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${escaped}["']`,
        "i"
      )
    ];
    for (const pattern of patterns) {
      const value = firstMatch(html, pattern);
      if (value !== null) return value;
    }
  }
  return null;
}

export type ExtractedPage = {
  title: string | null;
  author: string | null;
  publisher: string | null;
  /** ISO 8601 when the page declares a parseable publication date. */
  publishedAt: string | null;
  text: string;
  truncated: boolean;
};

function toIsoDate(value: string | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // Reject dates far outside a plausible publication window: a stray "1970" or
  // a nonsense year is worse than no date at all.
  const year = parsed.getUTCFullYear();
  if (year < 1500 || year > 2200) return null;
  return parsed.toISOString();
}

/**
 * Extracts the readable text plus the publication metadata a citation needs.
 *
 * When the body is not HTML it is taken as the text itself, so a `text/plain`
 * source is imported verbatim rather than guessed at.
 */
export function extractPage(input: {
  body: string;
  contentType: string;
  maxChars: number;
}): ExtractedPage {
  const isHtml = input.contentType.includes("html");
  if (!isHtml) {
    const text = normalizeText(input.body);
    const truncated = text.length > input.maxChars;
    return {
      title: null,
      author: null,
      publisher: null,
      publishedAt: null,
      text: truncated ? text.slice(0, input.maxChars) : text,
      truncated
    };
  }

  const text = htmlToPlainText(input.body);
  const truncated = text.length > input.maxChars;
  return {
    title: firstMatch(input.body, /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i),
    author: metaContent(input.body, ["author", "article:author", "og:article:author"]),
    publisher: metaContent(input.body, [
      "og:site_name",
      "publisher",
      "application-name",
      "article:publisher"
    ]),
    publishedAt: toIsoDate(
      metaContent(input.body, [
        "article:published_time",
        "datePublished",
        "date",
        "og:published_time",
        "pubdate"
      ])
    ),
    text: truncated ? text.slice(0, input.maxChars) : text,
    truncated
  };
}

export type AnchorResult =
  | { status: "anchored"; index: number; matched: string }
  | { status: "missing" };

/**
 * Finds an excerpt inside a snapshot's text.
 *
 * Exact matching is tried first. A second pass compares collapsed whitespace,
 * because a page can reflow without changing a single word and a researcher
 * should not be told their quote vanished when it merely moved a line.
 */
export function findAnchor(content: string, anchor: string): AnchorResult {
  const needle = anchor.trim();
  if (needle.length === 0) return { status: "missing" };

  const exact = content.indexOf(needle);
  if (exact !== -1) {
    return { status: "anchored", index: exact, matched: needle };
  }

  const collapsedNeedle = normalizeText(needle).replace(/\s+/g, " ");
  if (collapsedNeedle.length < 12) {
    // Too short to be a meaningful anchor once whitespace is ignored.
    return { status: "missing" };
  }

  // Walk the content keeping a map from collapsed offset back to a real index,
  // so the reported position still points at readable text.
  let collapsed = "";
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    if (/\s/.test(char)) {
      pendingSpace = collapsed.length > 0;
      continue;
    }
    if (pendingSpace) {
      collapsed += " ";
      offsets.push(index);
      pendingSpace = false;
    }
    collapsed += char;
    offsets.push(index);
  }

  const found = collapsed.indexOf(collapsedNeedle);
  if (found === -1) return { status: "missing" };
  const realIndex = offsets[found];
  if (realIndex === undefined) return { status: "missing" };
  return { status: "anchored", index: realIndex, matched: needle };
}

/** A short human-readable locator, e.g. "第 3 段 · …开头文字…". */
export function describeAnchor(content: string, index: number): string {
  const before = content.slice(0, index);
  const paragraph = before.split(/\n{2,}/).length;
  return `第 ${paragraph} 段`;
}
