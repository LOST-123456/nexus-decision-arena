-- Local research files (PDF / DOCX / TXT / Markdown / CSV) that were imported
-- into a session.
--
-- Rollback: see migrations/rollback/0013_source_files.down.sql
--
-- Eight rules this migration is built around:
--   1. This table stores the *file and its parse outcome*, nothing else. It is
--      not a second evidence system: the text a person later cites lives in
--      `source_snapshots`, the citation lives in `evidence`, and neither is
--      duplicated here.
--   2. A parse that produced no text is recorded as such. There is no silent
--      "parsed" success: a scanned PDF becomes `needs_ocr`, and a broken file
--      becomes `failed`, and neither creates a Source, because there would be
--      nothing to read.
--   3. A failure has to explain itself — `failed` requires `parse_error`, the
--      same honesty constraint the research search and research plan enforce.
--   4. Content identity beats file names. `sha256` is what deduplicates; two
--      files with the same name and different bytes are two rows, and two files
--      with different names and identical bytes are one row per session.
--   5. Every row is scoped to one session, so cross-session isolation is a
--      foreign key rather than a query convention.
--   6. Bytes are stored outside the database. `storage_key` points at the
--      managed file store; this table never holds binary content.
--   7. `source_id` is only set once text actually exists, which keeps
--      "we have the file" separate from "we can cite something from it".
--   8. Who read the file is recoverable: `parser_version` records which parser
--      produced the stored text, so a re-read can be attributed.
CREATE TABLE IF NOT EXISTS "source_files" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  /** Null until a parse actually produced text; set only for `parsed`. */
  "source_id" uuid REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action,
  /** The name the uploader gave. Display only — never used for decisions. */
  "file_name" text NOT NULL,
  /** What the client claimed the file was. Kept for auditing, not trusted. */
  "declared_mime_type" text NOT NULL,
  /** What the bytes actually are, decided server-side from the file signature. */
  "detected_kind" text NOT NULL,
  "byte_size" integer NOT NULL,
  /** Content identity across uploads. Lowercase hex sha256. */
  "sha256" text NOT NULL,
  "parse_status" text NOT NULL,
  /** Why parsing did not succeed. Required when the status is `failed`. */
  "parse_error" text,
  /** Shape counters for the reader (pages, heading count, csv columns…). */
  "parse_stats" jsonb,
  /** Where the original bytes live in managed storage. Never a filesystem path. */
  "storage_key" text NOT NULL,
  /** The parser (and version) that produced the stored text. */
  "parser_version" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Only realistic document kinds may be stored, so no row can claim to be a
-- format nobody can read back.
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_detected_kind_check" CHECK ("detected_kind" IN ('pdf', 'docx', 'txt', 'markdown', 'csv'));
--> statement-breakpoint
-- Three outcomes and no placeholders: either the file was read, it needs OCR,
-- or it failed. There is no fourth, in-between state that could be mistaken
-- for success.
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_parse_status_check" CHECK ("parse_status" IN ('parsed', 'needs_ocr', 'failed'));
--> statement-breakpoint
-- A failed parse says what went wrong, or it does not get to be `failed`.
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_failed_has_error_check" CHECK ("parse_status" <> 'failed' OR "parse_error" IS NOT NULL);
--> statement-breakpoint
-- A Source exists only when there is text to attribute to it. A row that never
-- parsed must not point at a citable record.
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_source_requires_parsed_check" CHECK ("source_id" IS NULL OR "parse_status" = 'parsed');
--> statement-breakpoint
-- Same bytes, same session, one row: re-uploading an identical file is a
-- lookup, not a duplicate import.
CREATE UNIQUE INDEX IF NOT EXISTS "source_files_session_hash_idx" ON "source_files" USING btree ("session_id", "sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_files_session_idx" ON "source_files" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_files_source_idx" ON "source_files" USING btree ("source_id");
