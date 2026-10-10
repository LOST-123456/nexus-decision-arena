-- Inverse of 0009_citation_review.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0009.
--
-- Both tables are dropped wholesale. They hold checks and assessments, never
-- domain records: `evidence` and `claims` rows are untouched, so dropping this
-- loses the audit trail of what was checked and how each result was corrected,
-- and nothing else. In particular no verdict, no verification status and no
-- locator state is stored here, so none of those can be lost by this script.
--
-- This script undoes 0009 only. It must not assume anything about migrations
-- added after 0009 — roll any newer ones back first, newest going first.
DROP INDEX IF EXISTS "claim_support_assessments_evidence_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "claim_support_assessments_claim_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "claim_support_assessments_current_idx";
--> statement-breakpoint
ALTER TABLE "claim_support_assessments" DROP CONSTRAINT IF EXISTS "claim_support_assessments_origin_check";
--> statement-breakpoint
ALTER TABLE "claim_support_assessments" DROP CONSTRAINT IF EXISTS "claim_support_assessments_status_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "claim_support_assessments";
--> statement-breakpoint
DROP INDEX IF EXISTS "citation_integrity_checks_session_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "citation_integrity_checks_current_idx";
--> statement-breakpoint
ALTER TABLE "citation_integrity_checks" DROP CONSTRAINT IF EXISTS "citation_integrity_checks_origin_check";
--> statement-breakpoint
ALTER TABLE "citation_integrity_checks" DROP CONSTRAINT IF EXISTS "citation_integrity_checks_match_kind_check";
--> statement-breakpoint
ALTER TABLE "citation_integrity_checks" DROP CONSTRAINT IF EXISTS "citation_integrity_checks_status_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "citation_integrity_checks";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0009 state as well, otherwise
-- `db:migrate` would skip 0009 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0009_citation_review.sql';
