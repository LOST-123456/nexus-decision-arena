-- Inverse of 0015_research_report_snapshots.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0015.
--
-- This drops the saved report versions only. It does not touch claims,
-- evidence, sources, captures, reviews or the monitoring ledger: a snapshot
-- is a copy of what those rows said at one moment, so deleting it removes
-- the frozen document and nothing that the document was about. The audit
-- event that recorded the save stays in `execution_events` — the ledger is
-- append-only by design and is not this table's to erase.
--
-- This script undoes 0015 only. It must not assume anything about migrations
-- added after 0015 — roll any newer ones back first, newest going first.
DROP INDEX IF EXISTS "research_report_snapshots_session_created_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_report_snapshots_session_idempotency_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_report_snapshots_session_version_idx";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_monitoring_references_array_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_review_references_array_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_claim_references_array_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_evidence_references_array_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_source_references_array_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_payload_object_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_hash_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_fingerprint_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_schema_version_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_created_by_check";
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" DROP CONSTRAINT IF EXISTS "research_report_snapshots_version_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "research_report_snapshots";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0015 state as well, otherwise
-- `db:migrate` would skip 0015 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0015_research_report_snapshots.sql';
