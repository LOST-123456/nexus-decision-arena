-- Controlled research search: tasks and the candidates they surface.
--
-- Rollback: see migrations/rollback/0012_research_search_tasks.down.sql
--
-- Six rules this migration is built around:
--   1. A search task is a *request*, never a result. It starts 'queued' and the
--      only thing the system may do on its own is move it to 'searching' and
--      then 'completed' or 'failed'. It never becomes evidence.
--   2. Candidates are leads, not sources. They live in a separate table so the
--      line between "the search suggested this" and "a person registered this
--      as provenance" is a column (registered_source_id), not a hope.
--   3. Approval is a transfer, not a promotion. Approving a task copies each
--      candidate into `sources` and stamps registered_source_id; it does NOT
--      write `evidence`. Evidence is a separate, human-driven step that cites an
--      already-registered source. Nothing here touches evidence.verification_status.
--   4. Every candidate must already carry the provenance a Source needs (url,
--      title, publisher, retrieved_at, source_type), so the transfer is pure
--      and the system never silently fabricates metadata.
--   5. A failed search must explain itself: 'failed' requires failure_reason,
--      the same honesty constraint the research plan enforces.
--   6. Rejecting is a recorded decision, not a silent drop. rejected_at /
--      rejected_by keep "we looked and chose not to register these" auditable.
CREATE TABLE IF NOT EXISTS "research_search_tasks" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "plan_item_id" uuid NOT NULL REFERENCES "public"."research_plan_items"("id") ON DELETE cascade ON UPDATE no action,
  "query" text NOT NULL,
  "purpose" text NOT NULL,
  "keywords" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'queued',
  "failure_reason" text,
  "rejected_at" timestamp with time zone,
  "rejected_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "research_search_tasks" ADD CONSTRAINT "research_search_tasks_status_check" CHECK ("status" IN ('queued', 'searching', 'completed', 'failed', 'cancelled'));
--> statement-breakpoint
-- A failed search says what went wrong, or it does not get to be 'failed'.
ALTER TABLE "research_search_tasks" ADD CONSTRAINT "research_search_tasks_failed_has_reason_check" CHECK ("status" <> 'failed' OR "failure_reason" IS NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_search_tasks_session_idx" ON "research_search_tasks" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_search_tasks_plan_item_idx" ON "research_search_tasks" USING btree ("session_id", "plan_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_search_tasks_session_status_idx" ON "research_search_tasks" USING btree ("session_id", "status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "search_candidates" (
  "id" uuid PRIMARY KEY,
  "task_id" uuid NOT NULL REFERENCES "public"."research_search_tasks"("id") ON DELETE cascade ON UPDATE no action,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "url" text NOT NULL,
  "title" text NOT NULL,
  "publisher" text NOT NULL,
  "retrieved_at" timestamp with time zone NOT NULL,
  "source_type" text NOT NULL,
  "note" text,
  "approved_at" timestamp with time zone,
  "registered_source_id" uuid REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- The candidate's kind must be a real Source kind, so the transfer to `sources`
-- never has to invent a value the schema would reject.
ALTER TABLE "search_candidates" ADD CONSTRAINT "search_candidates_source_type_check" CHECK ("source_type" IN ('url', 'document', 'dataset', 'manual'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_candidates_task_idx" ON "search_candidates" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_candidates_session_idx" ON "search_candidates" USING btree ("session_id");
