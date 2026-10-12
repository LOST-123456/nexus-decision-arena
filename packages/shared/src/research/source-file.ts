import { z } from "zod";
import { IdSchema, TimestampSchema } from "../ids";

/*
 * Local research files: PDF, DOCX, TXT, Markdown and CSV.
 *
 * This module describes one thing and one thing only: **the file that was
 * imported and what happened when the server tried to read it.** It is not a
 * parallel record system. Everything a citation needs already exists elsewhere:
 *
 *   - the text lives in `source_snapshots` (one immutable capture per version),
 *   - the citation lives in `evidence`, created by a person through the
 *     unchanged evidence API,
 *   - verification remains its own axis, decided by humans.
 *
 * Nothing here asserts truth. A parsed file is a file we could read; whether
 * any sentence in it supports or contradicts a claim is a separate judgement
 * made by a person, later, through the existing flows. Three consequences are
 * baked into these types on purpose:
 *
 *   - `needs_ocr` and `failed` are real, terminal outcomes. A scanned PDF is not
 *     "parsed with empty text"; pretending otherwise would let a person anchor
 *     an excerpt against nothing and call it sourced.
 *   - Content identity is the hash, never the file name. Same name with
 *     different bytes is a different file; different name with the same bytes is
 *     the same content.
 *   - The row never leaves the session it was uploaded to.
 */

/* ------------------------------------------------------------------ *
 * What the bytes actually are
 * ------------------------------------------------------------------ */

/**
 * The formats this build can read — decided from the file signature, never from
 * the name the uploader gave it.
 */
export const SourceFileKindSchema = z.enum([
  "pdf",
  "docx",
  "txt",
  "markdown",
  "csv"
]);

export type SourceFileKind = z.infer<typeof SourceFileKindSchema>;

/**
 * Separator between pages inside a stored PDF capture.
 *
 * The capture is one text column, and the reader splits on this to show pages.
 * It exists so a citation can name a page and someone can be shown that page,
 * instead of the whole document being an undifferentiated blob.
 */
export const SOURCE_FILE_PAGE_SEPARATOR = "\f";

/** The stored `source_snapshots.content_type` used for each kind. */
export const SOURCE_FILE_CONTENT_TYPES: Readonly<
  Record<SourceFileKind, string>
> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  markdown: "text/markdown",
  csv: "text/csv"
};

/* ------------------------------------------------------------------ *
 * How the read went
 * ------------------------------------------------------------------ */

/**
 * Three outcomes, no placeholder in between.
 *
 * `parsed` means text was extracted and stored. `needs_ocr` means a PDF whose
 * pages carry no text layer — the file is real, the build simply cannot read
 * it, so it says so instead of shipping empty content. `failed` means the bytes
 * could not be turned into text at all, and carries a reason.
 */
export const SourceFileParseStatusSchema = z.enum([
  "parsed",
  "needs_ocr",
  "failed"
]);

export type SourceFileParseStatus = z.infer<
  typeof SourceFileParseStatusSchema
>;

/* ------------------------------------------------------------------ *
 * Shape counters
 * ------------------------------------------------------------------ */

const PdfParseStatsSchema = z.object({
  kind: z.literal("pdf"),
  pageCount: z.number().int().min(0),
  charCount: z.number().int().min(0)
});

const DocxParseStatsSchema = z.object({
  kind: z.literal("docx"),
  headingCount: z.number().int().min(0),
  paragraphCount: z.number().int().min(0),
  tableCount: z.number().int().min(0),
  charCount: z.number().int().min(0)
});

const TextParseStatsSchema = z.object({
  kind: z.literal("txt"),
  paragraphCount: z.number().int().min(0),
  charCount: z.number().int().min(0)
});

const MarkdownParseStatsSchema = z.object({
  kind: z.literal("markdown"),
  headingCount: z.number().int().min(0),
  paragraphCount: z.number().int().min(0),
  charCount: z.number().int().min(0)
});

/** Per-column kind, inferred from the values actually present in that column. */
export const CsvColumnTypeSchema = z.enum([
  "integer",
  "number",
  "boolean",
  "date",
  "text",
  "empty"
]);

export type CsvColumnType = z.infer<typeof CsvColumnTypeSchema>;

const CsvParseStatsSchema = z.object({
  kind: z.literal("csv"),
  columnCount: z.number().int().min(0),
  rowCount: z.number().int().min(0),
  /** Original column names, in file order, kept so the reader can show them. */
  columns: z.array(z.string().max(120)).max(64),
  /** Inferred type per column, aligned by index with `columns`. */
  columnTypes: z.array(CsvColumnTypeSchema).max(64),
  charCount: z.number().int().min(0)
});

/** A PDF we could open but not read: pages exist, there is no text layer. */
const OcrParseStatsSchema = z.object({
  kind: z.literal("ocr"),
  pageCount: z.number().int().min(0)
});

/**
 * Structure the reader can navigate by.
 *
 * These are counts and column names — the file's shape — never conclusions. A
 * row count is not a finding, and a column type is a guess about how to display
 * a value, printed as a guess rather than as fact.
 */
export const SourceFileParseStatsSchema = z.discriminatedUnion("kind", [
  PdfParseStatsSchema,
  DocxParseStatsSchema,
  TextParseStatsSchema,
  MarkdownParseStatsSchema,
  CsvParseStatsSchema,
  OcrParseStatsSchema
]);

export type SourceFileParseStats = z.infer<typeof SourceFileParseStatsSchema>;

/* ------------------------------------------------------------------ *
 * Persisted shape
 * ------------------------------------------------------------------ */

export const SourceFileRecordSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  /** The Source created from this file. Set only when `parseStatus` is parsed. */
  sourceId: z.preprocess(
    (value) => (value === null ? undefined : value),
    IdSchema.optional()
  ),
  /** As the uploader named it. Display only; never used to decide anything. */
  fileName: z.string().min(1).max(240),
  /** What the client claimed. Kept to audit mismatches, never trusted. */
  declaredMimeType: z.string().max(240),
  /** What the server established from the bytes. This is the one we use. */
  detectedKind: SourceFileKindSchema,
  byteSize: z.number().int().min(0),
  /** Content identity within the session. Lowercase sha256 hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  parseStatus: SourceFileParseStatusSchema,
  /** Why reading failed, when it did. */
  parseError: z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.string().max(2000).optional()
  ),
  parseStats: SourceFileParseStatsSchema.nullable(),
  /** Which parser (and version) produced the stored text. */
  parserVersion: z.string().min(1).max(120),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema
});

export type SourceFileRecord = z.infer<typeof SourceFileRecordSchema>;

/*
 * Note on what is deliberately absent: there is no `storageKey` here. Where the
 * bytes physically live is an implementation detail of the server's store, and
 * handing it to a browser would expose the filesystem layout for no benefit.
 * Reading them is always a request against this record's own endpoint.
 */

/* ------------------------------------------------------------------ *
 * Failure vocabulary
 * ------------------------------------------------------------------ */

export const FileIngestionFailureCodeSchema = z.enum([
  "file_not_found",
  /** The bytes are not one of the supported document kinds. */
  "unsupported_type",
  /** Nothing to read: zero bytes. */
  "empty_file",
  /** Larger than the configured per-file ceiling. */
  "file_too_large",
  /** The file looked right but could not be turned into text. */
  "parse_failed",
  /** The managed file store could not be written to or read from. */
  "storage_unavailable"
]);

export type FileIngestionFailureCode = z.infer<
  typeof FileIngestionFailureCodeSchema
>;
