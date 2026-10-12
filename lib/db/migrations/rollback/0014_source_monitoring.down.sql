-- Inverse of 0014_source_monitoring.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0014.
--
-- This drops the monitoring ledger only. It does not touch `sources`,
-- `source_snapshots` or `evidence`: the captures a monitoring check pointed
-- at are domain records owned by earlier migrations and survive intact, which
-- means every citation stays re-locatable and every verification decision
-- stays exactly as it was. What is lost is the record of which sources were
-- checked, when, with what result, and which re-checks a person still owed.
--
-- This script undoes 0014 only. It must not assume anything about migrations
-- added after 0014 — roll any newer ones back first, newest going first.
DROP INDEX IF EXISTS "source_checks_session_checked_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "source_checks_source_checked_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "revalidation_task_events_session_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "revalidation_task_events_task_idx";
--> statement-breakpoint
ALTER TABLE "revalidation_task_events" DROP CONSTRAINT IF EXISTS "revalidation_task_events_status_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "revalidation_task_events";
--> statement-breakpoint
DROP INDEX IF EXISTS "revalidation_tasks_source_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "revalidation_tasks_session_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "revalidation_tasks_current_idx";
--> statement-breakpoint
ALTER TABLE "revalidation_tasks" DROP CONSTRAINT IF EXISTS "revalidation_tasks_hash_length_check";
--> statement-breakpoint
ALTER TABLE "revalidation_tasks" DROP CONSTRAINT IF EXISTS "revalidation_tasks_claim_ids_array_check";
--> statement-breakpoint
ALTER TABLE "revalidation_tasks" DROP CONSTRAINT IF EXISTS "revalidation_tasks_evidence_ids_array_check";
--> statement-breakpoint
ALTER TABLE "revalidation_tasks" DROP CONSTRAINT IF EXISTS "revalidation_tasks_open_has_no_closure_check";
--> statement-breakpoint
ALTER TABLE "revalidation_tasks" DROP CONSTRAINT IF EXISTS "revalidation_tasks_closed_has_reason_check";
--> statement-breakpoint
ALTER TABLE "revalidation_tasks" DROP CONSTRAINT IF EXISTS "revalidation_tasks_status_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "revalidation_tasks";
--> statement-breakpoint
ALTER TABLE "source_checks" DROP CONSTRAINT IF EXISTS "source_checks_new_version_requires_capture_check";
--> statement-breakpoint
ALTER TABLE "source_checks" DROP CONSTRAINT IF EXISTS "source_checks_changed_has_versions_check";
--> statement-breakpoint
ALTER TABLE "source_checks" DROP CONSTRAINT IF EXISTS "source_checks_unreadable_has_reason_check";
--> statement-breakpoint
ALTER TABLE "source_checks" DROP CONSTRAINT IF EXISTS "source_checks_status_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "source_checks";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0014 state as well, otherwise
-- `db:migrate` would skip 0014 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0014_source_monitoring.sql';
