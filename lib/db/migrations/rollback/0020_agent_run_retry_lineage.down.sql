-- Inverse of 0020_agent_run_retry_lineage.sql.
--
-- Undo only 0020. It must not assume anything about migrations added after
-- 0020 — roll any newer ones back first, newest going first.
--
-- Dropping the composite foreign key and its unique key restores the single
-- `parent_run_id` foreign key from 0016, so lineage rows survive: only the
-- same-session guarantee goes away. No row is touched.
DROP INDEX IF EXISTS "agent_runs_parent_run_idx";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_parent_not_self_check";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_parent_same_session_fk";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_session_run_key";
--> statement-breakpoint
DELETE FROM schema_migrations WHERE filename = '0020_agent_run_retry_lineage.sql';
