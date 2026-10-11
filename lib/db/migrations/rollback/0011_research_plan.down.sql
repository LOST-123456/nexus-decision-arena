-- Inverse of 0011_research_plan.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0011.
--
-- The table is dropped wholesale. It holds research decisions and their
-- outcomes, never domain records: `claims`, `evidence`, `sources` and
-- `sources` snapshots are untouched, and no verification status or verdict is
-- stored here. What is lost is the record of which gaps someone decided to
-- pursue, what they found and who closed them.
--
-- This script undoes 0011 only. It must not assume anything about migrations
-- added after 0011 — roll any newer ones back first, newest going first.
DROP INDEX IF EXISTS "research_plan_items_claim_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_plan_items_session_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_plan_items_current_idx";
--> statement-breakpoint
ALTER TABLE "research_plan_items" DROP CONSTRAINT IF EXISTS "research_plan_items_decision_check";
--> statement-breakpoint
ALTER TABLE "research_plan_items" DROP CONSTRAINT IF EXISTS "research_plan_items_failed_has_reason_check";
--> statement-breakpoint
ALTER TABLE "research_plan_items" DROP CONSTRAINT IF EXISTS "research_plan_items_completed_has_outcome_check";
--> statement-breakpoint
ALTER TABLE "research_plan_items" DROP CONSTRAINT IF EXISTS "research_plan_items_priority_check";
--> statement-breakpoint
ALTER TABLE "research_plan_items" DROP CONSTRAINT IF EXISTS "research_plan_items_severity_check";
--> statement-breakpoint
ALTER TABLE "research_plan_items" DROP CONSTRAINT IF EXISTS "research_plan_items_kind_check";
--> statement-breakpoint
ALTER TABLE "research_plan_items" DROP CONSTRAINT IF EXISTS "research_plan_items_status_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "research_plan_items";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0011 state as well, otherwise
-- `db:migrate` would skip 0011 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0011_research_plan.sql';
