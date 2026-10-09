-- Evidence-first fact checking: citable sources, multi-claim evidence links,
-- verification audit fields, human-authored research claims.
--
-- Rollback: see migrations/rollback/0005_evidence_sources.down.sql
CREATE TABLE IF NOT EXISTS "sources" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action,
  "title" text NOT NULL,
  "kind" text NOT NULL,
  "url" text,
  "publisher" text,
  "author" text,
  "published_at" timestamp with time zone,
  "note" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sources_session_title_idx" ON "sources" USING btree ("session_id", "title");
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "claim_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
UPDATE "evidence"
SET "claim_ids" = jsonb_build_array("claim_id")
WHERE "claim_id" IS NOT NULL
  AND ("claim_ids" IS NULL OR jsonb_array_length("claim_ids") = 0);
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "source_id" uuid;
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "locator" text;
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "verified_by" text;
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "verification_note" text;
--> statement-breakpoint
-- The inspector view selects evidence.claim_id, so it has to go away before the
-- column is dropped; it is recreated at the end of this migration against
-- evidence.claim_ids.
DROP VIEW IF EXISTS "claim_inspector_view";
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_claim_id_claims_id_fk";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "claim_id";
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_sessions" ADD COLUMN IF NOT EXISTS "research_question" text;
--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "agent_run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "role_id" DROP NOT NULL;
--> statement-breakpoint
CREATE VIEW "claim_inspector_view" AS
SELECT
  c.id AS claim_id,
  to_jsonb(c) AS claim,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(e) ORDER BY e.reliability DESC)
      FROM evidence e
      WHERE e.claim_ids ? c.id::text
    ),
    '[]'::jsonb
  ) AS evidence,
  COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'challenge', to_jsonb(ch),
          'responseClaim', to_jsonb(rc)
        )
        ORDER BY ch.created_at
      )
      FROM challenges ch
      LEFT JOIN claims rc ON rc.id = ch.response_claim_id
      WHERE ch.target_claim_id = c.id
         OR ch.response_claim_id = c.id
    ),
    '[]'::jsonb
  ) AS challenges,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(cf) ORDER BY cf.severity DESC)
      FROM conflicts cf
      WHERE cf.claim_ids ? c.id::text
    ),
    '[]'::jsonb
  ) AS conflicts
FROM claims c;
