-- Citation integrity checks and claim-evidence support assessments.
--
-- Rollback: see migrations/rollback/0009_citation_review.down.sql
--
-- Five rules this migration is built around:
--   1. Two different questions get two different tables, because they have two
--      different grains. Integrity is a fact about ONE excerpt and its
--      capture; support is a reading of ONE excerpt against ONE claim. A
--      single excerpt can be perfectly locatable and still say nothing about
--      the claim it is attached to, so neither table can hold both answers.
--   2. Neither table is a verdict. Nothing here feeds `deriveClaimVerdicts()`
--      or `diagnoseEvidenceGaps()`, and no write path reaches
--      `evidence.verification_status`. A support assessment is advice; only a
--      person can verify an excerpt.
--   3. Records are append-only. A human correction inserts a NEW row that
--      points back at what it replaced (`supersedes_id`); the earlier
--      conclusion, its author and its timestamp are never edited. History is
--      replayable, and `is_current` is only a pointer, never a rewrite.
--   4. The version is part of the answer. `expected_content_hash` is the
--      capture the excerpt was anchored against and `snapshot_content_hash`
--      is the one actually searched; when they differ the quote may still be
--      present, which is exactly why that is recorded as `stale` rather than
--      silently re-stamped as good.
--   5. An assessment's cited fragment is checked by the server
--      (`matched_excerpt_located`). A fragment the server cannot find in the
--      stored text is stored as unlocated and reported as such — it is never
--      presented as something the source actually said.
CREATE TABLE IF NOT EXISTS "citation_integrity_checks" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "evidence_id" uuid NOT NULL REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action,
  "source_id" uuid REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action,
  "snapshot_id" uuid REFERENCES "public"."source_snapshots"("id") ON DELETE set null ON UPDATE no action,
  "status" text NOT NULL,
  "match_kind" text,
  "anchor_text" text,
  "expected_content_hash" text,
  "snapshot_content_hash" text,
  "matched_text" text,
  "context_text" text,
  "reason" text NOT NULL,
  "origin" text NOT NULL,
  "actor" text NOT NULL,
  "supersedes_id" uuid REFERENCES "public"."citation_integrity_checks"("id") ON DELETE set null ON UPDATE no action,
  "is_current" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "citation_integrity_checks" ADD CONSTRAINT "citation_integrity_checks_status_check" CHECK ("status" IN ('anchored', 'stale', 'partial', 'missing', 'unmapped', 'unanchored'));
--> statement-breakpoint
ALTER TABLE "citation_integrity_checks" ADD CONSTRAINT "citation_integrity_checks_match_kind_check" CHECK ("match_kind" IS NULL OR "match_kind" IN ('exact', 'normalized', 'elided'));
--> statement-breakpoint
ALTER TABLE "citation_integrity_checks" ADD CONSTRAINT "citation_integrity_checks_origin_check" CHECK ("origin" IN ('system', 'human'));
--> statement-breakpoint
-- One current conclusion per excerpt, enforced rather than agreed: a second
-- "current" row for the same excerpt cannot be inserted.
CREATE UNIQUE INDEX IF NOT EXISTS "citation_integrity_checks_current_idx" ON "citation_integrity_checks" USING btree ("evidence_id") WHERE ("is_current");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "citation_integrity_checks_session_idx" ON "citation_integrity_checks" USING btree ("session_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "claim_support_assessments" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "claim_id" uuid NOT NULL REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action,
  "evidence_id" uuid NOT NULL REFERENCES "public"."evidence"("id") ON DELETE cascade ON UPDATE no action,
  "status" text NOT NULL,
  "confidence" numeric(4, 3),
  "rationale" text NOT NULL,
  "matched_excerpt" text,
  "matched_excerpt_located" boolean NOT NULL DEFAULT false,
  "signals" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "provider" text,
  "model" text,
  "prompt_version" text NOT NULL,
  "origin" text NOT NULL,
  "actor" text NOT NULL,
  "supersedes_id" uuid REFERENCES "public"."claim_support_assessments"("id") ON DELETE set null ON UPDATE no action,
  "is_current" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "claim_support_assessments" ADD CONSTRAINT "claim_support_assessments_status_check" CHECK ("status" IN ('support', 'oppose', 'context', 'insufficient', 'ambiguous'));
--> statement-breakpoint
ALTER TABLE "claim_support_assessments" ADD CONSTRAINT "claim_support_assessments_origin_check" CHECK ("origin" IN ('model', 'human'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "claim_support_assessments_current_idx" ON "claim_support_assessments" USING btree ("claim_id", "evidence_id") WHERE ("is_current");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_support_assessments_claim_idx" ON "claim_support_assessments" USING btree ("session_id", "claim_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_support_assessments_evidence_idx" ON "claim_support_assessments" USING btree ("session_id", "evidence_id", "created_at");
