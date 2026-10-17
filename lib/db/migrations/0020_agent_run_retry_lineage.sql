-- Retry lineage integrity: a retry's parent must live in the same session.
--
-- Nothing here changes how existing rows are read or written. Both objects are
-- satisfied by every row already in the table: a run's own `session_id` always
-- matches itself, and rows written before retries existed have a NULL
-- `parent_run_id`, which a composite foreign key does not check.
--
-- Why the database needs a say at all: `parentRunId` is derived server-side
-- from a session-scoped lookup, so the service cannot be tricked into pointing
-- at another session's run. But "the service happens to do this" is not a
-- guarantee — a future caller, a migration fix-up script, or a manual repair
-- could still write a cross-session pointer, and no reader would notice. The
-- composite key makes the association impossible at the storage layer, which is
-- the only layer that cannot be bypassed.
--
-- Rollback: see migrations/rollback/0020_agent_run_retry_lineage.down.sql
--
-- Red lines honoured here:
--   * No new table, no new entity. A retry is still a row in `agent_runs`.
--   * No history is rewritten and no existing row is deleted; every constraint
--     is additive and already true of the rows on disk.
--   * `id` stays the primary key. The extra unique key exists only so the
--     composite foreign key has something to reference.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_run_key" UNIQUE ("session_id", "id");
--> statement-breakpoint
-- A parent pointer that crosses sessions would let one research task's run
-- claim another task's attempt as its ancestor — a lineage lie that no
-- application-level check could prove later.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_same_session_fk"
  FOREIGN KEY ("parent_run_id", "session_id")
  REFERENCES "public"."agent_runs" ("id", "session_id")
  ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- A run cannot be its own ancestor. One hop is checked here; longer cycles are
-- impossible because a row can only name a parent that already exists.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_parent_not_self_check"
  CHECK ("parent_run_id" IS NULL OR "parent_run_id" <> "id");
--> statement-breakpoint
-- Retry lineage is read by walking `parent_run_id`; the operations center also
-- asks "does this run already have a retry child?" on every retry request.
CREATE INDEX IF NOT EXISTS "agent_runs_parent_run_idx" ON "agent_runs" USING btree ("parent_run_id");
