-- Research plan: what a person decided to go and do about a diagnosed gap.
--
-- Rollback: see migrations/rollback/0011_research_plan.down.sql
--
-- Six rules this migration is built around:
--   1. Gaps are derived, plans are decided. `evidence-gaps.ts` recomputes gaps
--      from persisted state on every read, so a gap needs no table. What needs
--      one is the decision a person made about it, and who made it.
--   2. One current item per gap, per session. Enforced by a partial unique
--      index rather than by the calling code remembering to clear the old row,
--      so pressing "加入研究计划" twice cannot create two tasks.
--   3. Append-only. A revision inserts a NEW row pointing at the one it
--      replaced (`supersedes_id`); the earlier row keeps its author, reason and
--      timestamp. `is_current` is a pointer, never a rewrite.
--   4. Execution is recorded, not implied. `status` starts at 'queued' and the
--      CHECK constraints below make it impossible to record 'completed'
--      without an `outcome`, or 'failed' without a `failure_reason`. A row can
--      therefore never say "done" while holding no result.
--   5. Closing is an auditable act. 'closed' and 'not_applicable' both require
--      a reason AND a decider, so "we decided not to pursue this" cannot be
--      stored anonymously.
--   6. Nothing here is a verdict. No column feeds `deriveClaimVerdicts()` or
--      `diagnoseEvidenceGaps()`, and no write path reaches
--      `evidence.verification_status`. A completed research task says material
--      was found, never that it was verified.
CREATE TABLE IF NOT EXISTS "research_plan_items" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "claim_id" uuid NOT NULL REFERENCES "public"."claims"("id") ON DELETE cascade ON UPDATE no action,
  "gap_id" text NOT NULL,
  "gap_kind" text NOT NULL,
  "severity" text NOT NULL,
  "priority" integer NOT NULL,
  "title" text NOT NULL,
  "question" text NOT NULL,
  "why_insufficient" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "query" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "outcome" jsonb,
  "decision_reason" text,
  "decided_by" text,
  "failure_reason" text,
  "supersedes_id" uuid REFERENCES "public"."research_plan_items"("id") ON DELETE set null ON UPDATE no action,
  "is_current" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "research_plan_items" ADD CONSTRAINT "research_plan_items_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'needs_human', 'not_applicable', 'closed'));
--> statement-breakpoint
ALTER TABLE "research_plan_items" ADD CONSTRAINT "research_plan_items_kind_check" CHECK ("gap_kind" IN ('no_verified_support', 'unverified_material', 'no_counter_check', 'missing_primary_source', 'source_expired', 'source_not_yet_effective', 'unknown_publication_date', 'source_independence_unverified', 'excerpt_not_locatable', 'unresolved_dispute', 'unmapped_reference', 'review_requires_more_evidence', 'overbroad_claim', 'insufficient_time_or_scope_evidence'));
--> statement-breakpoint
ALTER TABLE "research_plan_items" ADD CONSTRAINT "research_plan_items_severity_check" CHECK ("severity" IN ('blocking', 'important', 'advisory'));
--> statement-breakpoint
ALTER TABLE "research_plan_items" ADD CONSTRAINT "research_plan_items_priority_check" CHECK ("priority" BETWEEN 1 AND 5);
--> statement-breakpoint
-- "Done" must carry a result. Without this a row could be marked completed
-- while holding nothing, which is exactly the kind of unearned progress the
-- plan exists to prevent.
ALTER TABLE "research_plan_items" ADD CONSTRAINT "research_plan_items_completed_has_outcome_check" CHECK ("status" <> 'completed' OR "outcome" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "research_plan_items" ADD CONSTRAINT "research_plan_items_failed_has_reason_check" CHECK ("status" <> 'failed' OR "failure_reason" IS NOT NULL);
--> statement-breakpoint
-- Closing or dismissing is a decision, so it needs a reason and a name.
ALTER TABLE "research_plan_items" ADD CONSTRAINT "research_plan_items_decision_check" CHECK ("status" NOT IN ('not_applicable', 'closed') OR ("decision_reason" IS NOT NULL AND "decided_by" IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "research_plan_items_current_idx" ON "research_plan_items" USING btree ("session_id", "gap_id") WHERE ("is_current");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_plan_items_session_status_idx" ON "research_plan_items" USING btree ("session_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_plan_items_claim_idx" ON "research_plan_items" USING btree ("claim_id");
