-- Inverse of 0013_source_files.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0013.
--
-- This drops the file-import ledger only. It does not touch `sources`,
-- `source_snapshots` or `evidence`: rows created from an imported file are
-- domain records owned by other migrations and survive intact, which means any
-- excerpt already confirmed against imported text stays verifiable. What is
-- lost is the record of which files were uploaded, their content hashes, and
-- how each parse settled — and therefore the ability to re-read those bytes
-- through this build's storage. Files in managed storage are not removed by
-- this script; prune them deliberately if that is the intent.
--
-- This script undoes 0013 only. It must not assume anything about migrations
-- added after 0013 — roll any newer ones back first, newest going first.
DROP INDEX IF EXISTS "source_files_source_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "source_files_session_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "source_files_session_hash_idx";
--> statement-breakpoint
ALTER TABLE "source_files" DROP CONSTRAINT IF EXISTS "source_files_source_requires_parsed_check";
--> statement-breakpoint
ALTER TABLE "source_files" DROP CONSTRAINT IF EXISTS "source_files_failed_has_error_check";
--> statement-breakpoint
ALTER TABLE "source_files" DROP CONSTRAINT IF EXISTS "source_files_parse_status_check";
--> statement-breakpoint
ALTER TABLE "source_files" DROP CONSTRAINT IF EXISTS "source_files_detected_kind_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "source_files";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0013 state as well, otherwise
-- `db:migrate` would skip 0013 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0013_source_files.sql';
