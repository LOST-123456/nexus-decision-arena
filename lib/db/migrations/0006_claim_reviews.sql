-- Human fact-check rulings, one claim at a time.
--
-- These are NOT conflict-level `human_decisions`: those resolve a dispute
-- between competing claims and are anchored to a conflict id. A claim review
-- rules on what can be concluded about a single claim, so it needs its own
-- anchor and its own audit record.
--
-- Append-only by design: a later ruling never rewrites an earlier one, so the
-- history of who concluded what, when, and against which derived verdict
-- survives every subsequent decision.
--
-- Rollback: see migrations/rollback/0006_claim_reviews.down.sql
CREATE TABLE IF NOT EXISTS "claim_reviews" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action,
  "claim_id" uuid NOT NULL REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action,
  "outcome" text NOT NULL,
  "rationale" text NOT NULL,
  "reviewer" text NOT NULL,
  "evidence_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "source_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "verdict_status_at_review" text NOT NULL,
  "verdict_confidence_at_review" double precision NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_reviews_claim_idx" ON "claim_reviews" USING btree ("claim_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "claim_reviews_session_idx" ON "claim_reviews" USING btree ("session_id", "created_at");
