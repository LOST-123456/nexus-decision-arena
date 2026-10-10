-- Claim-candidate extraction over a saved page capture.
--
-- Rollback: see migrations/rollback/0008_claim_candidate_extraction.down.sql
--
-- Three rules this migration is built around:
--   1. Candidates are *not* domain records. They live in their own tables, so
--      `deriveClaimVerdicts()`, `diagnoseEvidenceGaps()` and the fact-check
--      report — which read `claims` and `evidence` — cannot see them. A
--      suggestion therefore cannot move a verdict before a person accepts it
--      and then verifies it through the existing human workflow.
--   2. The locator state of a candidate excerpt is decided by the server
--      against the stored capture, never reported by the model. A quotation
--      the model invented cannot resolve, and arrives marked `missing`.
--   3. An analysis task is idempotent per input fingerprint. Two requests
--      asking the same question of the same capture return the earlier answer
--      instead of writing a second copy of the same candidates.
CREATE TABLE IF NOT EXISTS "claim_extraction_runs" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action,
  "source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  "snapshot_id" uuid NOT NULL REFERENCES "public"."source_snapshots"("id") ON DELETE cascade ON UPDATE no action,
  "status" text NOT NULL,
  "failure_code" text,
  "failure_message" text,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "input_hash" text NOT NULL,
  "prompt_version" text NOT NULL,
  "segmentation_version" text NOT NULL,
  "char_count" integer NOT NULL DEFAULT 0,
  "segment_count" integer NOT NULL DEFAULT 0,
  "candidate_claim_count" integer NOT NULL DEFAULT 0,
  "candidate_evidence_count" integer NOT NULL DEFAULT 0,
  "anchor_matched" integer NOT NULL DEFAULT 0,
  "anchor_missing" integer NOT NULL DEFAULT 0,
  "attempt" integer NOT NULL DEFAULT 1,
  "correlation_id" uuid NOT NULL,
  "created_by" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "claim_extraction_runs" ADD CONSTRAINT "claim_extraction_runs_status_check" CHECK ("status" IN ('pending', 'running', 'succeeded', 'failed'));
--> statement-breakpoint
ALTER TABLE "claim_extraction_runs" ADD CONSTRAINT "claim_extraction_runs_failure_code_check" CHECK ("failure_code" IS NULL OR "failure_code" IN ('no_snapshot', 'empty_content', 'provider_unavailable', 'timeout', 'aborted', 'refused', 'empty_output', 'invalid_json', 'schema_rejected', 'storage_unavailable'));
--> statement-breakpoint
-- One answer per question: re-running the same analysis reuses this row.
CREATE UNIQUE INDEX IF NOT EXISTS "claim_extraction_runs_input_idx" ON "claim_extraction_runs" USING btree ("session_id", "source_id", "snapshot_id", "input_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_extraction_runs_source_idx" ON "claim_extraction_runs" USING btree ("session_id", "source_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim_candidates" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action,
  "run_id" uuid NOT NULL REFERENCES "public"."claim_extraction_runs"("id") ON DELETE cascade ON UPDATE no action,
  "source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  "snapshot_id" uuid NOT NULL REFERENCES "public"."source_snapshots"("id") ON DELETE cascade ON UPDATE no action,
  -- Which slice of the capture this came from, so a long page stays traceable.
  "segment_index" integer NOT NULL,
  "statement" text NOT NULL,
  "type" text NOT NULL,
  "context" text,
  "qualifiers" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "uncertainty" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "rationale" text NOT NULL,
  "suggested_importance" integer NOT NULL DEFAULT 3,
  "status" text NOT NULL DEFAULT 'proposed',
  -- Filled only on acceptance, pointing at the real claim it produced.
  "created_claim_id" uuid REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action,
  "reject_reason" text,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "claim_candidates" ADD CONSTRAINT "claim_candidates_type_check" CHECK ("type" IN ('fact', 'causal', 'prediction', 'opinion'));
--> statement-breakpoint
ALTER TABLE "claim_candidates" ADD CONSTRAINT "claim_candidates_status_check" CHECK ("status" IN ('proposed', 'accepted', 'rejected'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_candidates_run_idx" ON "claim_candidates" USING btree ("run_id", "segment_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_candidates_source_idx" ON "claim_candidates" USING btree ("session_id", "source_id", "status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evidence_candidates" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action,
  "run_id" uuid NOT NULL REFERENCES "public"."claim_extraction_runs"("id") ON DELETE cascade ON UPDATE no action,
  "source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  "snapshot_id" uuid NOT NULL REFERENCES "public"."source_snapshots"("id") ON DELETE cascade ON UPDATE no action,
  "segment_index" integer NOT NULL,
  "claim_candidate_id" uuid NOT NULL REFERENCES "public"."claim_candidates"("id") ON DELETE cascade ON UPDATE no action,
  "excerpt" text NOT NULL,
  "title" text NOT NULL,
  "direction" text NOT NULL,
  "locator_kind" text NOT NULL,
  -- Decided by the server against the capture; a fabricated quotation lands here.
  "locator_status" text NOT NULL,
  "locator" text,
  "anchor_text" text,
  "source_content_hash" text,
  "suggested_reliability" double precision NOT NULL DEFAULT 0.5,
  "rationale" text NOT NULL,
  "uncertainty" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'proposed',
  -- Filled only on acceptance, pointing at the real evidence row it produced.
  "created_evidence_id" uuid REFERENCES "public"."evidence"("id") ON DELETE set null ON UPDATE no action,
  "reject_reason" text,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "evidence_candidates" ADD CONSTRAINT "evidence_candidates_direction_check" CHECK ("direction" IN ('supports', 'opposes', 'context'));
--> statement-breakpoint
ALTER TABLE "evidence_candidates" ADD CONSTRAINT "evidence_candidates_locator_status_check" CHECK ("locator_status" IN ('unanchored', 'anchored', 'missing'));
--> statement-breakpoint
ALTER TABLE "evidence_candidates" ADD CONSTRAINT "evidence_candidates_locator_kind_check" CHECK ("locator_kind" IN ('quote', 'heading', 'paragraph', 'page', 'timestamp', 'manual'));
--> statement-breakpoint
ALTER TABLE "evidence_candidates" ADD CONSTRAINT "evidence_candidates_status_check" CHECK ("status" IN ('proposed', 'accepted', 'rejected'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_candidates_claim_candidate_idx" ON "evidence_candidates" USING btree ("claim_candidate_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "evidence_candidates_run_idx" ON "evidence_candidates" USING btree ("run_id", "segment_index");
