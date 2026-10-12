-- Source monitoring and revalidation: whether the pages a research relied on
-- have changed, and the re-check a person owes when they have.
--
-- Rollback: see migrations/rollback/0014_source_monitoring.down.sql
--
-- Seven rules this migration is built around:
--   1. Monitoring is its own axis. `source_checks.status` is not
--      `sources.retrieval_status` (could the page be read) and not
--      `evidence.verification_status` (did anyone stand behind an excerpt).
--      Nothing in this migration writes either of those.
--   2. A failed check is not a change. `unavailable` and `failed` must carry a
--      reason, and `changed` must carry both hashes — so a row can never claim
--      drift without a before and an after to point at.
--   3. A re-check is a person's work, persisted and attributed. Closing one
--      needs a name and a reason; the DB refuses an anonymous or reasonless
--      closure, the same honesty rule the research plan uses.
--   4. Re-checks are idempotent per version. One row per
--      (session, source, trigger hash) enforced by a unique index, so
--      re-running the same check cannot open a second reminder.
--   5. A task keeps its identity. `revalidation_tasks` holds the task; every
--      status change is appended to `revalidation_task_events`, so the id a
--      workspace is showing stays addressable while the full history of who
--      moved it, and why, survives.
--   6. Nothing here judges truth. No column feeds `deriveClaimVerdicts()` or
--      `diagnoseEvidenceGaps()`, and no write path reaches evidence. A
--      re-check says material moved, never that a conclusion is wrong.
--   7. Snapshots stay where they are. `source_snapshots` is already
--      append-only; this migration only *points* at its rows, so the older
--      capture is never overwritten and an old citation stays re-locatable.
CREATE TABLE IF NOT EXISTS "source_checks" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  "status" text NOT NULL,
  "reason_code" text,
  "message" text NOT NULL,
  "previous_snapshot_id" uuid REFERENCES "public"."source_snapshots"("id") ON DELETE set null ON UPDATE no action,
  "current_snapshot_id" uuid REFERENCES "public"."source_snapshots"("id") ON DELETE set null ON UPDATE no action,
  "previous_content_hash" text,
  "current_content_hash" text,
  "http_status" integer,
  "error_code" text,
  "error_message" text,
  "new_version_stored" boolean NOT NULL DEFAULT false,
  "checked_by" text NOT NULL,
  "checked_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "source_checks" ADD CONSTRAINT "source_checks_status_check" CHECK ("status" IN ('not_checked', 'checking', 'unchanged', 'changed', 'unavailable', 'failed'));
--> statement-breakpoint
-- "We could not read it" has to say why, or it is indistinguishable from
-- "we read it and it had not changed".
ALTER TABLE "source_checks" ADD CONSTRAINT "source_checks_unreadable_has_reason_check" CHECK ("status" NOT IN ('unavailable', 'failed') OR ("reason_code" IS NOT NULL AND "error_code" IS NOT NULL));
--> statement-breakpoint
-- Drift needs two versions. A row that says `changed` while holding only one
-- hash is claiming a comparison that never happened.
ALTER TABLE "source_checks" ADD CONSTRAINT "source_checks_changed_has_versions_check" CHECK ("status" <> 'changed' OR ("previous_content_hash" IS NOT NULL AND "current_content_hash" IS NOT NULL AND "current_snapshot_id" IS NOT NULL));
--> statement-breakpoint
-- A check that read nothing must not be recorded as having stored a version.
ALTER TABLE "source_checks" ADD CONSTRAINT "source_checks_new_version_requires_capture_check" CHECK ("new_version_stored" = false OR "current_snapshot_id" IS NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "revalidation_tasks" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  "source_title" text NOT NULL,
  "trigger_content_hash" text NOT NULL,
  "previous_snapshot_id" uuid REFERENCES "public"."source_snapshots"("id") ON DELETE set null ON UPDATE no action,
  "current_snapshot_id" uuid REFERENCES "public"."source_snapshots"("id") ON DELETE set null ON UPDATE no action,
  "affected_evidence_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "affected_claim_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "resolved_by" text,
  "resolution_note" text
);
--> statement-breakpoint
ALTER TABLE "revalidation_tasks" ADD CONSTRAINT "revalidation_tasks_status_check" CHECK ("status" IN ('open', 'in_review', 'resolved', 'dismissed'));
--> statement-breakpoint
-- Closing a re-check is a decision: it needs a reason and a name, so "we
-- looked again and it is fine" can never be stored anonymously.
ALTER TABLE "revalidation_tasks" ADD CONSTRAINT "revalidation_tasks_closed_has_reason_check" CHECK ("status" NOT IN ('resolved', 'dismissed') OR ("resolution_note" IS NOT NULL AND "resolved_by" IS NOT NULL AND "resolved_at" IS NOT NULL));
--> statement-breakpoint
-- The mirror image: an open task must not carry a closure it never had.
ALTER TABLE "revalidation_tasks" ADD CONSTRAINT "revalidation_tasks_open_has_no_closure_check" CHECK ("status" IN ('resolved', 'dismissed') OR ("resolution_note" IS NULL AND "resolved_by" IS NULL AND "resolved_at" IS NULL));
--> statement-breakpoint
-- The affected sets are identifiers, not free text: a malformed array would
-- make the workspace point at rows that may not exist.
ALTER TABLE "revalidation_tasks" ADD CONSTRAINT "revalidation_tasks_evidence_ids_array_check" CHECK (jsonb_typeof("affected_evidence_ids") = 'array');
--> statement-breakpoint
ALTER TABLE "revalidation_tasks" ADD CONSTRAINT "revalidation_tasks_claim_ids_array_check" CHECK (jsonb_typeof("affected_claim_ids") = 'array');
--> statement-breakpoint
-- The version fingerprint is a sha256, so a truncated or padded value can
-- never be used as a deduplication key.
ALTER TABLE "revalidation_tasks" ADD CONSTRAINT "revalidation_tasks_hash_length_check" CHECK (length("trigger_content_hash") = 64);
--> statement-breakpoint
-- One task per version of a source. Re-running the same check resolves to the
-- existing row instead of opening a second reminder.
CREATE UNIQUE INDEX IF NOT EXISTS "revalidation_tasks_current_idx" ON "revalidation_tasks" USING btree ("session_id", "source_id", "trigger_content_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revalidation_tasks_session_status_idx" ON "revalidation_tasks" USING btree ("session_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revalidation_tasks_source_idx" ON "revalidation_tasks" USING btree ("source_id");
--> statement-breakpoint
-- Every status change, appended. This is the history a researcher reads when
-- they ask "who closed this and on what grounds".
CREATE TABLE IF NOT EXISTS "revalidation_task_events" (
  "id" uuid PRIMARY KEY,
  "task_id" uuid NOT NULL REFERENCES "public"."revalidation_tasks"("id") ON DELETE cascade ON UPDATE no action,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "from_status" text,
  "to_status" text NOT NULL,
  "note" text,
  "actor" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "revalidation_task_events" ADD CONSTRAINT "revalidation_task_events_status_check" CHECK ("to_status" IN ('open', 'in_review', 'resolved', 'dismissed') AND ("from_status" IS NULL OR "from_status" IN ('open', 'in_review', 'resolved', 'dismissed')));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revalidation_task_events_task_idx" ON "revalidation_task_events" USING btree ("task_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revalidation_task_events_session_idx" ON "revalidation_task_events" USING btree ("session_id", "created_at" DESC);
--> statement-breakpoint
-- Checks are read per source (latest first) and per session (the monitoring
-- list), so both access paths are indexed rather than table-scanned.
CREATE INDEX IF NOT EXISTS "source_checks_source_checked_idx" ON "source_checks" USING btree ("source_id", "checked_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_checks_session_checked_idx" ON "source_checks" USING btree ("session_id", "checked_at" DESC);
