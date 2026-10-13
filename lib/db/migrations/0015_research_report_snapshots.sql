-- Immutable snapshots of the fact-check report, one row per saved version.
--
-- Rollback: see migrations/rollback/0015_research_report_snapshots.down.sql
--
-- Six rules this migration is built around:
--   1. A snapshot is a document, not a fingerprint. `materials_fingerprint`
--      says two reports were built from identical rows; this table keeps the
--      report itself — payload, cited source versions, verdicts, rulings and
--      monitoring risks — frozen at save time, so reading an old version can
--      never quietly re-derive it from newer rows.
--   2. Versions are numbered per session and never reused. The unique index
--      on (session_id, version) is what makes a concurrent double-save fail
--      loudly instead of silently producing two "version 3"s.
--   3. Saving writes nothing else. No claim status, no verification status,
--      no review, no capture is created or edited here: the only write is the
--      snapshot row and its audit event.
--   4. A version is attributed. `created_by` comes from the server's own
--      session and the DB refuses an empty one — history nobody owns is
--      history nobody can be asked about.
--   5. Cited captures are referenced, not owned. `source_references` records
--      the capture each conclusion was drawn from without a foreign key: a
--      capture may be cleaned up later, and the version must then say the
--      capture is gone rather than pretend it is still there.
--   6. The payload is typed by its own version. `report_schema_version`
--      travels with the row so a future format change can tell an old
--      payload from a new one instead of guessing.
CREATE TABLE IF NOT EXISTS "research_report_snapshots" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_by" text NOT NULL,
  "research_question" text,
  "report_schema_version" integer NOT NULL DEFAULT 1,
  "materials_fingerprint" text NOT NULL,
  "snapshot_hash" text NOT NULL,
  "report_payload" jsonb NOT NULL,
  "source_references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "evidence_references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "claim_references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "review_references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "monitoring_references" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "change_reason" text,
  "idempotency_key" text
);
--> statement-breakpoint
-- Version numbers start at 1 and only go up; a 0 or negative version is a
-- row that was never really numbered.
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_version_check" CHECK ("version" > 0);
--> statement-breakpoint
-- A saved version is somebody's decision. The server fills this from the
-- authenticated account; the column refuses to hold an anonymous save.
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_created_by_check" CHECK (length(btrim("created_by")) > 0);
--> statement-breakpoint
-- The payload format is declared, not implied.
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_schema_version_check" CHECK ("report_schema_version" > 0);
--> statement-breakpoint
-- The fingerprint is the 16-hex material fingerprint the report already
-- computes; the snapshot hash is a full sha256 over the canonical payload.
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_fingerprint_check" CHECK (length("materials_fingerprint") = 16);
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_hash_check" CHECK (length("snapshot_hash") = 64);
--> statement-breakpoint
-- The payload is a report object, never a scalar or an array: a version that
-- held anything else could not be rendered or diffed at all.
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_payload_object_check" CHECK (jsonb_typeof("report_payload") = 'object');
--> statement-breakpoint
-- The reference sets are identifier lists, not free text: a malformed array
-- would make a version point at rows that may not exist.
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_source_references_array_check" CHECK (jsonb_typeof("source_references") = 'array');
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_evidence_references_array_check" CHECK (jsonb_typeof("evidence_references") = 'array');
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_claim_references_array_check" CHECK (jsonb_typeof("claim_references") = 'array');
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_review_references_array_check" CHECK (jsonb_typeof("review_references") = 'array');
--> statement-breakpoint
ALTER TABLE "research_report_snapshots" ADD CONSTRAINT "research_report_snapshots_monitoring_references_array_check" CHECK (jsonb_typeof("monitoring_references") = 'array');
--> statement-breakpoint
-- One version number per session. A second row with the same number is a
-- concurrency bug, and the database refuses it rather than letting two
-- histories claim the same label.
CREATE UNIQUE INDEX IF NOT EXISTS "research_report_snapshots_session_version_idx" ON "research_report_snapshots" USING btree ("session_id", "version");
--> statement-breakpoint
-- One snapshot per idempotency key per session: a double-submitted save is
-- the same version, not a second one. The key is optional, so the index is
-- partial and ordinary saves are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS "research_report_snapshots_session_idempotency_idx" ON "research_report_snapshots" USING btree ("session_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
--> statement-breakpoint
-- History is read newest first, per session.
CREATE INDEX IF NOT EXISTS "research_report_snapshots_session_created_idx" ON "research_report_snapshots" USING btree ("session_id", "created_at" DESC);
