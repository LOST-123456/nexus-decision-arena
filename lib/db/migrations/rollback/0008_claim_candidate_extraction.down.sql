-- Inverse of 0008_claim_candidate_extraction.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0008.
--
-- Candidate tables are dropped wholesale. They hold only suggestions: nothing
-- outside this migration reads them, and `claims` / `evidence` are untouched,
-- so a row that was already accepted keeps its own existence. What is lost is
-- the record of what was suggested and how each suggestion was ruled on.
--
-- This script undoes 0008 only. It must not assume anything about migrations
-- added after 0008 — roll any newer ones back first, newest going first.
DROP INDEX IF EXISTS "evidence_candidates_run_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "evidence_candidates_claim_candidate_idx";
--> statement-breakpoint
ALTER TABLE "evidence_candidates" DROP CONSTRAINT IF EXISTS "evidence_candidates_status_check";
--> statement-breakpoint
ALTER TABLE "evidence_candidates" DROP CONSTRAINT IF EXISTS "evidence_candidates_locator_kind_check";
--> statement-breakpoint
ALTER TABLE "evidence_candidates" DROP CONSTRAINT IF EXISTS "evidence_candidates_locator_status_check";
--> statement-breakpoint
ALTER TABLE "evidence_candidates" DROP CONSTRAINT IF EXISTS "evidence_candidates_direction_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "evidence_candidates";
--> statement-breakpoint
DROP INDEX IF EXISTS "claim_candidates_source_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "claim_candidates_run_idx";
--> statement-breakpoint
ALTER TABLE "claim_candidates" DROP CONSTRAINT IF EXISTS "claim_candidates_status_check";
--> statement-breakpoint
ALTER TABLE "claim_candidates" DROP CONSTRAINT IF EXISTS "claim_candidates_type_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "claim_candidates";
--> statement-breakpoint
DROP INDEX IF EXISTS "claim_extraction_runs_source_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "claim_extraction_runs_input_idx";
--> statement-breakpoint
ALTER TABLE "claim_extraction_runs" DROP CONSTRAINT IF EXISTS "claim_extraction_runs_failure_code_check";
--> statement-breakpoint
ALTER TABLE "claim_extraction_runs" DROP CONSTRAINT IF EXISTS "claim_extraction_runs_status_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "claim_extraction_runs";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0008 state as well, otherwise
-- `db:migrate` would skip 0008 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0008_claim_candidate_extraction.sql';
