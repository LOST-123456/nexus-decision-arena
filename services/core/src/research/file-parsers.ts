import { createHash } from "node:crypto";
import {
  type CsvColumnType,
  type FileIngestionFailureCode,
  type SourceFileKind,
  type SourceFileParseStats,
  SOURCE_FILE_PAGE_SEPARATOR
} from "@nexus/shared";
// Both libraries are CommonJS namespace objects at runtime, so they are taken as
// defaults; declaring named exports would compile but fail to resolve in Node.
import mammoth from "mammoth";
import Papa from "papaparse";
import { extractText, getDocumentProxy } from "unpdf";

/*
 * Reading local research files.
 *
 * This module turns bytes into text, and nothing else. What it deliberately
 * does not do:
 *
 *   - **No judgement.** It never decides that a sentence supports or contradicts
 *     a claim, never assigns verification, and never "extracts findings". Text
 *     in, text out. The requirement is explicit: a number in a table is not a
 *     proven finding, and nothing here may imply it is.
 *   - **No trust in names.** The file extension decides nothing about how bytes
 *     are read. The signature does (with one narrow exception documented on
 *     `detectSourceFileKind`: choosing between plain text, Markdown and CSV —
 *     three effectively identical byte streams — which only affects how the
 *     reader renders them, never what we accept).
 *   - **No network, no scripts, no macros.** All three libraries are local.
 *     Nothing here fetches a URL, resolves an external entity, executes a
 *     document script, or opens a path. Content is data, never instructions: it
 *     is stored as text and never placed in a privileged prompt.
 *   - **No silent success.** A PDF whose pages carry no text layer comes back as
 *     `needs_ocr`, not as an empty-but-parsed document. An empty result is a
 *     reported failure, always.
 */

/** Version recorded alongside the stored text so a re-read can be attributed. */
export const FILE_PARSER_VERSION = "nexus-file-parsers@1";

/** Default per-file ceiling. Operations override it from deployment config. */
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Additional ceilings, all of them about keeping one upload bounded. */
const MAX_EXTRACTED_CHARS = 1_500_000;
const MAX_PDF_PAGES = 1_000;
const MAX_CSV_ROWS = 100_000;
const MAX_CSV_COLUMNS = 64;
/** How many csv rows the reader is given; the count shown is always the total. */
export const CSV_PREVIEW_ROW_LIMIT = 1_000;
const DEFAULT_PARSE_TIMEOUT_MS = 30_000;

/**
 * Page separator inside a stored PDF capture.
 *
 * A form feed is invisible enough not to disturb reading and unambiguous enough
 * for the reader to split on. It exists so a citation can name a page and the
 * reader can show that page, rather than the text being one undifferentiated
 * blob.
 */
export const PDF_PAGE_SEPARATOR = SOURCE_FILE_PAGE_SEPARATOR;

export class DocumentParseError extends Error {
  constructor(
    message: string,
    readonly code: FileIngestionFailureCode
  ) {
    super(message);
    this.name = "DocumentParseError";
  }
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

export type CsvStructure = {
  columns: string[];
  columnTypes: CsvColumnType[];
  /** First rows only — `rowCount` carries how many exist in total. */
  rows: string[][];
  rowCount: number;
};

export type ParsedDocument =
  | {
      outcome: "parsed";
      kind: SourceFileKind;
      /** Extracted text, stored as the source capture. Never executed. */
      content: string;
      charCount: number;
      stats: SourceFileParseStats;
      /** Present for csv, so the reader can show a table instead of prose. */
      table?: CsvStructure;
    }
  | {
      outcome: "needs_ocr";
      kind: "pdf";
      pageCount: number;
      stats: SourceFileParseStats;
    };

export type ParseLimits = {
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
};

/* ------------------------------------------------------------------ *
 * Bytes in: identity and type
 * ------------------------------------------------------------------ */

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  return true;
}

function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * Whether these bytes are a text stream we can decode.
 *
 * Binary disguised as text is rejected here rather than smuggled into a
 * capture: a NUL byte or an undecodable sequence means it is not a document we
 * can honestly read.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

function decodeText(bytes: Uint8Array): string {
  // Text files are normalized to LF and stripped of a byte-order mark: the
  // stored capture is extracted text rather than a byte-exact copy, and stable
  // newlines are what let an excerpt stay locatable.
  return new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n");
}

/**
 * What these bytes actually are.
 *
 * `null` means "not a document this build can read", which the caller turns
 * into a refusal instead of a guess. Only the byte stream decides; the name is
 * consulted for one purpose alone (choosing between text formats that are
 * byte-identical in kind), never to widen what we accept.
 */
export function detectSourceFileKind(input: {
  bytes: Uint8Array;
  fileName: string;
}): SourceFileKind | null {
  const { bytes, fileName } = input;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  // A Word document is a zip container; anything else zip-shaped is rejected
  // later by the parser itself, which knows what its own format looks like.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "docx";
  if (looksLikeText(bytes)) {
    const extension = extensionOf(fileName);
    if (extension === "csv") return "csv";
    if (extension === "md" || extension === "markdown") return "markdown";
    return "txt";
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Format-specific readers
 * ------------------------------------------------------------------ */

async function withTimeout<T>(
  work: Promise<T> | T,
  timeoutMs: number,
  kind: SourceFileKind
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new DocumentParseError(
              `解析超时：${kind} 文件在 ${Math.round(timeoutMs / 1000)} 秒内没有读完。`,
              "parse_failed"
            )
          );
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stripTags(html: string): string {
  return decodeEntities(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

/**
 * PDF text, page by page.
 *
 * `needs_ocr` is the honest answer for a scanned document: the pages exist and
 * we can count them, but there is no text layer, so there is nothing to store
 * and nothing for anyone to excerpt. Reporting that beats shipping a "parsed"
 * file whose content is empty.
 */
/**
 * Refuses bytes that only look like a PDF.
 *
 * This check exists for one concrete reason, found while testing: handed a file
 * that opens with `%PDF-` but has no document structure at all, the underlying
 * PDF library recovers asynchronously and rejects later with nobody listening —
 * an unhandled rejection that can take a server process down. Refusing those
 * bytes ourselves is both safer and a clearer answer than "Invalid PDF
 * structure", which says nothing about what to do next.
 *
 * Real PDFs end with `%%EOF`; anything else is truncated or mislabelled.
 */
function ensurePdfStructure(bytes: Uint8Array): void {
  const tailStart = Math.max(0, bytes.length - 2_048);
  const tail = new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(tailStart)
  );
  if (!tail.includes("%%EOF")) {
    throw new DocumentParseError(
      "该文件不是完整的 PDF：文件结尾缺少 %%EOF 标记，可能已被截断或只是借用了 PDF 的扩展名。",
      "parse_failed"
    );
  }
}

async function parsePdf(
  bytes: Uint8Array,
  timeoutMs: number
): Promise<ParsedDocument> {
  ensurePdfStructure(bytes);
  const proxy = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await withTimeout(
    extractText(proxy, { mergePages: false }),
    timeoutMs,
    "pdf"
  );
  if (totalPages > MAX_PDF_PAGES) {
    throw new DocumentParseError(
      `页数超过上限：该文件有 ${totalPages} 页，最多支持 ${MAX_PDF_PAGES} 页。`,
      "parse_failed"
    );
  }
  const pages = text.map((page) => page.replace(/\s+$/u, ""));
  const joined = pages.join(PDF_PAGE_SEPARATOR);
  if (joined.trim().length === 0) {
    return {
      outcome: "needs_ocr",
      kind: "pdf" as const,
      pageCount: Math.max(totalPages, pages.length),
      stats: { kind: "ocr" as const, pageCount: Math.max(totalPages, pages.length) }
    };
  }
  const content = enforceContentLimit(joined, "pdf");
  return {
    outcome: "parsed",
    kind: "pdf",
    content,
    charCount: content.length,
    stats: { kind: "pdf", pageCount: pages.length, charCount: content.length }
  };
}

function enforceContentLimit(content: string, kind: SourceFileKind): string {
  if (content.length > MAX_EXTRACTED_CHARS) {
    // Refusing beats truncating: a silently cut-off capture would let an excerpt
    // from the tail of the document anchor against text that is not there.
    throw new DocumentParseError(
      `提取文本超过上限：${kind.toUpperCase()} 文件提取出 ${content.length} 个字符，最多支持 ${MAX_EXTRACTED_CHARS} 个。`,
      "parse_failed"
    );
  }
  return content;
}

/**
 * Word documents: heading outline, paragraphs and tables, kept as lines.
 *
 * Mammoth converts to HTML, from which structure is recovered; headings are
 * written back with Markdown-style markers and table rows keep their cell
 * boundaries, so nothing gets flattened into a paragraph of prose that would
 * read like a conclusion. A table stays a table.
 */
async function parseDocx(
  bytes: Uint8Array,
  timeoutMs: number
): Promise<ParsedDocument> {
  const [htmlResult, rawResult] = await withTimeout(
    Promise.all([
      mammoth.convertToHtml({ buffer: bytes }),
      mammoth.extractRawText({ buffer: bytes })
    ]),
    timeoutMs,
    "docx"
  );

  const blockPattern =
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>|<table[^>]*>([\s\S]*?)<\/table>|<p[^>]*>([\s\S]*?)<\/p>/gi;
  const lines: string[] = [];
  let headingCount = 0;
  let paragraphCount = 0;
  let tableCount = 0;

  for (
    let match = blockPattern.exec(htmlResult.value);
    match !== null;
    match = blockPattern.exec(htmlResult.value)
  ) {
    const [, headingLevel, headingHtml, tableHtml, paragraphHtml] = match;
    if (tableHtml) {
      tableCount += 1;
      for (const row of extractTableRows(tableHtml)) lines.push(row);
      continue;
    }
    if (headingLevel && headingHtml !== undefined) {
      headingCount += 1;
      const heading = stripTags(headingHtml);
      if (heading.length > 0) {
        lines.push(`${"#".repeat(Number(headingLevel))} ${heading}`);
      }
      continue;
    }
    if (paragraphHtml !== undefined) {
      paragraphCount += 1;
      const paragraph = stripTags(paragraphHtml);
      if (paragraph.length > 0) lines.push(paragraph);
    }
  }

  // No recognizable blocks: fall back to mammoth's plain text rather than
  // pretending there was nothing in the file.
  let content =
    lines.length > 0 ? lines.join("\n") : rawResult.value.replace(/\r\n?/g, "\n");
  content = content.trim();
  if (content.length === 0) {
    throw new DocumentParseError(
      "文件没有可读文本内容：未能从该 Word 文档中提取任何文字。",
      "empty_file"
    );
  }
  content = enforceContentLimit(content, "docx");

  return {
    outcome: "parsed",
    kind: "docx",
    content,
    charCount: content.length,
    stats: {
      kind: "docx",
      headingCount,
      paragraphCount,
      tableCount,
      charCount: content.length
    }
  };
}

function extractTableRows(tableHtml: string): string[] {
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const rows: string[] = [];
  for (
    let match = rowPattern.exec(tableHtml);
    match !== null;
    match = rowPattern.exec(tableHtml)
  ) {
    const rowHtml = match[1] ?? "";
    const cells: string[] = [];
    for (
      let cell = cellPattern.exec(rowHtml);
      cell !== null;
      cell = cellPattern.exec(rowHtml)
    ) {
      cells.push(stripTags(cell[1] ?? ""));
    }
    if (cells.length > 0) rows.push(cells.join(" | "));
  }
  return rows;
}

/**
 * Plain text and Markdown.
 *
 * Structure is preserved rather than re-flowed: paragraphs stay paragraphs (the
 * reader numbers them), and Markdown heading markers are left untouched so the
 * reader can build an outline from the text itself.
 */
function parseText(
  bytes: Uint8Array,
  kind: "txt" | "markdown"
): ParsedDocument {
  const text = decodeText(bytes).replace(/\s+$/u, "");
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const headingCount = text
    .split("\n")
    .filter((line) => /^#{1,6}\s+\S/.test(line.trim())).length;
  if (text.trim().length === 0) {
    throw new DocumentParseError(
      "文件没有可读文本内容：该文件是空文件或只包含空白字符。",
      "empty_file"
    );
  }
  const content = enforceContentLimit(text, kind);
  return {
    outcome: "parsed",
    kind,
    content,
    charCount: content.length,
    stats:
      kind === "markdown"
        ? {
            kind: "markdown",
            headingCount,
            paragraphCount: paragraphs.length,
            charCount: content.length
          }
        : {
            kind: "txt",
            paragraphCount: paragraphs.length,
            charCount: content.length
          }
  };
}

/* ------------------------------------------------------------------ *
 * CSV structure
 * ------------------------------------------------------------------ */

function inferColumnType(values: string[]): CsvColumnType {
  const present = values.map((value) => value.trim()).filter((v) => v.length > 0);
  if (present.length === 0) return "empty";
  if (present.every((value) => /^[+-]?\d+$/.test(value))) return "integer";
  if (
    present.every((value) => /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value))
  ) {
    return "number";
  }
  if (present.every((value) => /^(true|false|是|否|true|false)$/i.test(value))) {
    return "boolean";
  }
  if (present.every((value) => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(value))) {
    return "date";
  }
  return "text";
}

/**
 * Reads a csv as a table.
 *
 * Used both at import time (to record the shape) and at read time (to render
 * it), so nothing about the table has to be stored twice. The inferred type per
 * column is a display hint inferred from the values actually present — it is
 * reported as an inference, never relied upon for a conclusion.
 */
export function inspectCsv(content: string): CsvStructure {
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: "greedy"
  });
  const columns = (parsed.meta.fields ?? []).slice(0, MAX_CSV_COLUMNS + 1);
  if (columns.length === 0) {
    throw new DocumentParseError(
      "无法识别 CSV 表头：文件没有列名行。",
      "parse_failed"
    );
  }
  if (columns.length > MAX_CSV_COLUMNS) {
    throw new DocumentParseError(
      `列数超过上限：该文件有 ${columns.length} 列，最多支持 ${MAX_CSV_COLUMNS} 列。`,
      "parse_failed"
    );
  }
  const rows = parsed.data;
  const rowCount = rows.length;
  if (rowCount > MAX_CSV_ROWS) {
    throw new DocumentParseError(
      `行数超过上限：该文件有 ${rowCount} 行，最多支持 ${MAX_CSV_ROWS} 行。`,
      "parse_failed"
    );
  }
  const columnTypes = columns.map((column) =>
    inferColumnType(rows.map((row) => row[column] ?? ""))
  );
  const previewRows = rows
    .slice(0, CSV_PREVIEW_ROW_LIMIT)
    .map((row) => columns.map((column) => row[column] ?? ""));
  return { columns, columnTypes, rows: previewRows, rowCount };
}

async function parseCsv(
  bytes: Uint8Array,
  timeoutMs: number
): Promise<ParsedDocument> {
  const text = decodeText(bytes);
  if (text.trim().length === 0) {
    throw new DocumentParseError(
      "文件没有可读文本内容：该 CSV 文件是空的。",
      "empty_file"
    );
  }
  const table = await withTimeout(inspectCsv(text), timeoutMs, "csv");
  const content = enforceContentLimit(text, "csv");
  return {
    outcome: "parsed",
    kind: "csv",
    content,
    charCount: content.length,
    stats: {
      kind: "csv",
      columnCount: table.columns.length,
      rowCount: table.rowCount,
      columns: table.columns,
      columnTypes: table.columnTypes,
      charCount: content.length
    },
    table
  };
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Parses an already-detected kind.
 *
 * Size was checked before this point by the service; here every failure becomes
 * a `DocumentParseError` the API can report as-is, because "we could not read
 * this" is a legitimate outcome rather than an exception to hide.
 */
export async function parseDocument(input: {
  bytes: Uint8Array;
  kind: SourceFileKind;
  limits?: ParseLimits;
}): Promise<ParsedDocument> {
  const timeoutMs = input.limits?.timeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;
  try {
    switch (input.kind) {
      case "pdf":
        return await parsePdf(input.bytes, timeoutMs);
      case "docx":
        return await parseDocx(input.bytes, timeoutMs);
      case "txt":
        return parseText(input.bytes, "txt");
      case "markdown":
        return parseText(input.bytes, "markdown");
      case "csv":
        return await parseCsv(input.bytes, timeoutMs);
    }
  } catch (error) {
    if (error instanceof DocumentParseError) throw error;
    throw new DocumentParseError(
      describeParserFailure(error, input.kind),
      "parse_failed"
    );
  }
}

/**
 * A parser failure translated for a researcher.
 *
 * The underlying wording is kept: "the file is corrupt" and "the file is
 * missing its parts" are different problems. Stack traces and internal paths are
 * not — they are dropped here, because the person reading this can act on the
 * fact, not on a stack.
 */
function describeParserFailure(cause: unknown, kind: SourceFileKind): string {
  const message =
    cause instanceof Error && cause.message.length > 0
      ? cause.message.replace(/\s+/g, " ").slice(0, 300)
      : "未知错误";
  if (kind === "docx" && /word\/document\.xml|Could not find part/i.test(message)) {
    return "该文件不是 Word 文档内容不完整：找不到 word/document.xml，无法读取正文。";
  }
  if (kind === "pdf" && /Invalid|password|encrypt/i.test(message)) {
    return "该 PDF 无法读取：文件可能已损坏、被加密或设置了打开密码。";
  }
  return `文件解析失败（${kind.toUpperCase()}）：${message}`;
}
