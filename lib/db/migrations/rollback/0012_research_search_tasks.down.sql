-- Inverse of 0012_research_search_tasks.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0012.
--
-- Both tables are dropped wholesale. research_search_tasks holds search
-- requests and their status; search_candidates holds the leads a controlled
-- search surfaced. Neither stores domain records: `claims`, `evidence`,
-- `sources` and source snapshots are untouched, and no verification status or
-- verdict is stored here. What is lost is the record of which searches were
-- run, what they suggested, and which leads a person registered or rejected.
--
-- This script undoes 0012 only. It must not assume anything about migrations
-- added after 0012 — roll any newer ones back first, newest going first.
DROP INDEX IF EXISTS "search_candidates_session_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "search_candidates_task_idx";
--> statement-breakpoint
ALTER TABLE "search_candidates" DROP CONSTRAINT IF EXISTS "search_candidates_source_type_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "search_candidates";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_search_tasks_session_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_search_tasks_plan_item_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_search_tasks_session_idx";
--> statement-breakpoint
ALTER TABLE "research_search_tasks" DROP CONSTRAINT IF EXISTS "research_search_tasks_failed_has_reason_check";
--> statement-breakpoint
ALTER TABLE "research_search_tasks" DROP CONSTRAINT IF EXISTS "research_search_tasks_status_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "research_search_tasks";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0012 state as well, otherwise
-- `db:migrate` would skip 0012 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0012_research_search_tasks.sql';
