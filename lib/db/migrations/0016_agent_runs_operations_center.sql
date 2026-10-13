-- Agent Operations Center: richer run records, no parallel run system.
--
-- This migration only *widens* the single `agent_runs` table that cross-review
-- already writes to. It adds columns the operations center needs to show why a
-- run failed, what model ran it, how many tokens it used, and (for retries)
-- which run it came from. Every new column is nullable or carries a default so
-- the runs already written by cross-review keep validating.
--
-- Rollback: see migrations/rollback/0016_agent_runs_operations_center.down.sql
--
-- Red lines honoured here:
--   * No second run table. The center reads and cancels/retries rows in this
--     one table; it never creates a competing execution ledger.
--   * `parent_run_id` is a self-reference, not a new entity: a retry is a new
--     row that points back at the run it re-attempted.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "task_type" text NOT NULL DEFAULT 'unknown';
--> statement-breakpoint
-- A coarse bucket ("analysis" / "cross_review") is the run's purpose; this is
-- the fine one. Older rows default to 'unknown' and the UI says so rather than
-- inventing a label.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "error_code" text;
--> statement-breakpoint
-- A closed set of failure categories. `NULL` keeps meaning "the executor did
-- not record a code", so we must not force it; the check only constrains the
-- values that are present.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_error_code_check" CHECK (
  "error_code" IS NULL OR "error_code" IN (
    'provider_timeout',
    'provider_unavailable',
    'provider_rate_limited',
    'invalid_model_output',
    'schema_validation_failed',
    'persistence_failed',
    'cancelled_by_user',
    'internal_error'
  )
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "provider" text;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "model" text;
--> statement-breakpoint
-- 1-based attempt. The first run of a piece of work is attempt 1; each retry
-- opens a new row with a higher attempt and a `parent_run_id` pointer.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "attempt" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_attempt_check" CHECK ("attempt" > 0);
--> statement-breakpoint
-- A retry points back at the run it re-attempted. Self-referential by design;
-- deleting a parent is blocked by the FK so history cannot be orphaned.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "parent_run_id" uuid REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Real token accounting, when the executor reported it. `NULL` means the
-- executor did not provide usage, and the center shows "未提供" rather than a
-- fabricated number.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "token_usage" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_token_usage_object_check" CHECK (
  "token_usage" IS NULL OR jsonb_typeof("token_usage") = 'object'
);
--> statement-breakpoint
-- When the run was created (queued). Distinct from `started_at`, which is when
-- execution actually began. Existing rows get the moment of migration.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone NOT NULL DEFAULT now();
--> statement-breakpoint
-- Wall-clock duration in milliseconds, filled in only when the run finishes.
-- `NULL` means the run is still going or never recorded a finish.
ALTER TABLE "agent_runs" ADD COLUMN IF NOT EXISTS "duration_ms" integer;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_duration_ms_check" CHECK (
  "duration_ms" IS NULL OR "duration_ms" >= 0
);
--> statement-breakpoint
-- The operations center reads runs newest-first per session; this index keeps
-- that scan cheap without changing how cross-review writes.
CREATE INDEX IF NOT EXISTS "agent_runs_session_created_idx" ON "agent_runs" USING btree ("session_id", "created_at" DESC);
