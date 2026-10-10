-- Inverse of 0007_source_intake.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0007.
--
-- `source_snapshots` is dropped wholesale: the captured page text has no home
-- in the pre-0007 schema, and leaving the table behind would let a later run of
-- `db:migrate` create a half-populated shape. Confirmed excerpts keep their
-- `content` and `locator` in `evidence`; only the ability to re-locate them in
-- a stored snapshot is lost, which is exactly what 0007 added.

ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_locator_kind_check";
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_locator_status_check";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "source_content_hash";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "anchor_text";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "locator_status";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "locator_kind";
--> statement-breakpoint
DROP INDEX IF EXISTS "source_snapshots_source_retrieved_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "source_snapshots_version_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "source_snapshots";
--> statement-breakpoint
DROP INDEX IF EXISTS "sources_session_canonical_url_idx";
--> statement-breakpoint
ALTER TABLE "sources" DROP CONSTRAINT IF EXISTS "sources_retrieval_status_check";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN IF EXISTS "content_bytes";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN IF EXISTS "content_hash";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN IF EXISTS "content_type";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN IF EXISTS "retrieval_error";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN IF EXISTS "retrieved_at";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN IF EXISTS "retrieval_attempts";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN IF EXISTS "retrieval_status";
--> statement-breakpoint
ALTER TABLE "sources" DROP COLUMN IF EXISTS "canonical_url";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0007 state as well, otherwise
-- `db:migrate` would skip 0007 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0007_source_intake.sql';
