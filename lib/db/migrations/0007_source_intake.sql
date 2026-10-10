-- Research intake: the retrieval state of an imported page, immutable content
-- snapshots that keep the previous version once a page changes, and the anchor
-- that ties a confirmed excerpt back to the exact text it was taken from.
--
-- Rollback: see migrations/rollback/0007_source_intake.down.sql
--
-- Two rules this migration is built around:
--   1. Retrieval state is its own axis. Whether a page was fetched has nothing
--      to do with whether its excerpt is verified, so it lives on `sources` and
--      never on `evidence.verification_status`.
--   2. A snapshot is append-only. A changed page adds a row; the older row is
--      kept so an excerpt confirmed against it can still be re-checked.
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "canonical_url" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "retrieval_status" text NOT NULL DEFAULT 'not_requested';
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "retrieval_attempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "retrieved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "retrieval_error" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "content_type" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "content_hash" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "content_bytes" integer;
--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_retrieval_status_check" CHECK ("retrieval_status" IN ('not_requested', 'pending', 'fetched', 'failed'));
--> statement-breakpoint
-- One page per research task. Importing the same normalized url twice reuses the
-- existing row instead of creating a near-duplicate source; manual sources have
-- a null canonical url and are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS "sources_session_canonical_url_idx" ON "sources" USING btree ("session_id", "canonical_url") WHERE "canonical_url" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_snapshots" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action,
  "source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  "canonical_url" text NOT NULL,
  "content_hash" text NOT NULL,
  "title" text,
  "author" text,
  "publisher" text,
  "published_at" timestamp with time zone,
  "content_type" text NOT NULL,
  "content" text NOT NULL,
  "content_bytes" integer NOT NULL,
  "char_count" integer NOT NULL,
  "retrieved_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_snapshots_version_idx" ON "source_snapshots" USING btree ("source_id", "content_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_snapshots_source_retrieved_idx" ON "source_snapshots" USING btree ("source_id", "retrieved_at");
--> statement-breakpoint
-- Locator state is a third, separate axis: it says whether the excerpt can still
-- be found in the source text. Existing rows are honestly `unanchored`: they
-- were typed in before any snapshot existed, so nobody ever checked them.
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "locator_kind" text;
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "locator_status" text NOT NULL DEFAULT 'unanchored';
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "anchor_text" text;
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "source_content_hash" text;
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_locator_status_check" CHECK ("locator_status" IN ('unanchored', 'anchored', 'missing'));
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_locator_kind_check" CHECK ("locator_kind" IS NULL OR "locator_kind" IN ('quote', 'heading', 'paragraph', 'page', 'timestamp', 'manual'));
