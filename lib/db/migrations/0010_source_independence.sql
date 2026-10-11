-- Source independence: human-asserted relations between sources, and human
-- overrides of a source's provenance kind.
--
-- Rollback: see migrations/rollback/0010_source_independence.down.sql
--
-- Five rules this migration is built around:
--   1. Detection is computed, assertions are stored. Which pages share a
--      normalized url or an identical content hash is derived from the source
--      rows on every read, so it can never go stale and needs no table. What a
--      table is needed for is the part a machine cannot derive: a person's
--      ruling about a pair, including "these two are NOT the same".
--   2. Two different grains, two tables. A relation is about a PAIR of sources;
--      a profile override is about ONE source. Folding them together would make
--      "this source is a reprint" and "this source is first-hand" the same row.
--   3. Records are append-only. A correction inserts a NEW row pointing back at
--      what it replaced (`supersedes_id`); the earlier statement, its author and
--      its timestamp are never edited. `is_current` is a pointer, not a rewrite.
--   4. The pair is unordered but stored canonically, and only one current
--      statement per pair is allowed — enforced by a partial unique index
--      rather than by the calling code remembering to clear the old row.
--   5. Nothing here is a verdict. No column feeds `deriveClaimVerdicts()` or
--      `diagnoseEvidenceGaps()`, and no write path reaches
--      `evidence.verification_status`. Independence informs a reader; it never
--      promotes an excerpt.
CREATE TABLE IF NOT EXISTS "source_relations" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "from_source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  "to_source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  "kind" text NOT NULL,
  "basis" text NOT NULL,
  "similarity" numeric(4, 3),
  "reason" text NOT NULL,
  "origin" text NOT NULL,
  "actor" text NOT NULL,
  "supersedes_id" uuid REFERENCES "public"."source_relations"("id") ON DELETE set null ON UPDATE no action,
  "is_current" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_kind_check" CHECK ("kind" IN ('same_page', 'duplicate', 'reprint', 'quotes', 'same_origin', 'near_duplicate', 'unrelated'));
--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_basis_check" CHECK ("basis" IN ('canonical_url', 'content_hash', 'text_similarity', 'explicit_citation', 'human_assertion'));
--> statement-breakpoint
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_origin_check" CHECK ("origin" IN ('system', 'human'));
--> statement-breakpoint
-- A source cannot be related to itself; a self-link would create a cluster of
-- one that looks like a finding.
ALTER TABLE "source_relations" ADD CONSTRAINT "source_relations_distinct_check" CHECK ("from_source_id" <> "to_source_id");
--> statement-breakpoint
-- One current statement per pair. The index is over the UNORDERED pair, so
-- asserting "b reprints a" after "a reprints b" updates the same statement
-- rather than adding a contradictory second one — while the row itself keeps
-- its direction, which is what makes a reprint/quote chain readable.
CREATE UNIQUE INDEX IF NOT EXISTS "source_relations_current_idx" ON "source_relations" USING btree (LEAST("from_source_id", "to_source_id"), GREATEST("from_source_id", "to_source_id")) WHERE ("is_current");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_relations_session_idx" ON "source_relations" USING btree ("session_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_profile_overrides" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  "provenance_kind" text NOT NULL,
  "note" text NOT NULL,
  "origin" text NOT NULL,
  "actor" text NOT NULL,
  "supersedes_id" uuid REFERENCES "public"."source_profile_overrides"("id") ON DELETE set null ON UPDATE no action,
  "is_current" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "source_profile_overrides" ADD CONSTRAINT "source_profile_overrides_kind_check" CHECK ("provenance_kind" IN ('primary', 'secondary', 'commentary', 'official_notice', 'dataset', 'unknown'));
--> statement-breakpoint
ALTER TABLE "source_profile_overrides" ADD CONSTRAINT "source_profile_overrides_origin_check" CHECK ("origin" IN ('system', 'human'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_profile_overrides_current_idx" ON "source_profile_overrides" USING btree ("source_id") WHERE ("is_current");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_profile_overrides_session_idx" ON "source_profile_overrides" USING btree ("session_id", "created_at");
