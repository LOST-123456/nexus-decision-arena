-- Inverse of 0005_evidence_sources.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0005.
--
-- Ordering matters: `claim_inspector_view` selects the evidence claim link, so
-- the view is dropped first and recreated last, once `claim_id` exists again.
--
-- It restores the single-claim evidence shape. Links beyond the first claim on
-- each evidence row are lost, which is why 0005 records every claim id in
-- `claim_ids` rather than only a primary one.

DROP VIEW IF EXISTS "claim_inspector_view";
--> statement-breakpoint
ALTER TABLE "decision_sessions" DROP COLUMN IF EXISTS "research_question";
--> statement-breakpoint
ALTER TABLE "evidence" DROP CONSTRAINT IF EXISTS "evidence_source_id_sources_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "sources_session_title_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "sources";
--> statement-breakpoint
ALTER TABLE "evidence" ADD COLUMN IF NOT EXISTS "claim_id" uuid;
--> statement-breakpoint
UPDATE "evidence"
SET "claim_id" = NULLIF("claim_ids" ->> 0, '')::uuid
WHERE "claim_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Baseline 0001 declares claim_id NOT NULL. Restoring that constraint requires
-- every evidence row to carry at least one claim id, which the domain schema
-- (EvidenceSchema.claimIds min(1)) already enforces on every write path. The
-- same applies to claims.agent_run_id / role_id below: a rollback can only
-- succeed while no human-authored claim exists.
ALTER TABLE "evidence" ALTER COLUMN "claim_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "verification_note";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "verified_at";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "verified_by";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "locator";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "source_id";
--> statement-breakpoint
ALTER TABLE "evidence" DROP COLUMN IF EXISTS "claim_ids";
--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "agent_run_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "claims" ALTER COLUMN "role_id" SET NOT NULL;
--> statement-breakpoint
CREATE VIEW "claim_inspector_view" AS
SELECT
  c.id AS claim_id,
  to_jsonb(c) AS claim,
  COALESCE(
    (
      SELECT jsonb_agg(to_jsonb(e) ORDER BY e.reliability DESC)
      FROM evidence e
      WHERE e.claim_id = c.id
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
--> statement-breakpoint
-- Leave the migration ledger in the pre-0005 state as well, otherwise
-- `db:migrate` would skip 0005 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0005_evidence_sources.sql';
