-- Inverse of 0016_agent_runs_operations_center.sql.
--
-- Undo only 0016. It must not assume anything about migrations added after
-- 0016 — roll any newer ones back first, newest going first.
--
-- This drops only the columns and constraints 0016 added. It does not touch
-- the rows cross-review already wrote (their original columns stay), and it
-- does not erase anything from `execution_events`.
DROP INDEX IF EXISTS "agent_runs_session_created_idx";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_duration_ms_check";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "duration_ms";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "created_at";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_token_usage_object_check";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "token_usage";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "parent_run_id";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_attempt_check";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "attempt";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "model";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "provider";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_error_code_check";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "error_code";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP COLUMN IF EXISTS "task_type";
--> statement-breakpoint
DELETE FROM schema_migrations WHERE filename = '0016_agent_runs_operations_center.sql';
