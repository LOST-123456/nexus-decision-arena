-- Cross-research library & evidence reuse: who may see a research's material,
-- and the lineage of a source that was copied into another research.
--
-- Rollback: see migrations/rollback/0018_source_library.down.sql
--
-- Six rules this migration is built around:
--   1. Material belongs to the session it was collected in. Nothing here
--      removes the per-session boundary: session-scoped APIs keep answering
--      404 for foreign ids. Cross-session visibility exists only where an
--      explicit grant row says so.
--   2. Ownership is recorded, never guessed. `decision_sessions.owner_user_id`
--      is written by the server from the login identity at creation time and
--      is NULL for sessions created before this migration. NULL means
--      "legacy workspace session": its existing behaviour is unchanged, and
--      administering its grants is restricted to the `owner` role so no
--      reviewer can share away a session whose real owner is unknown.
--   3. A grant is a row, not a hope. One live grant per
--      (session, subject, scope); revocation keeps the row with who revoked
--      it and why — an audit trail that forgets is not one.
--   4. A copy keeps its origin. `source_copies` records the origin session,
--      origin source, the snapshot hash it was copied from, who copied it and
--      when. The copied content lands in the target session as its own
--      immutable snapshot, so the copy is self-contained and the target can
--      re-locate excerpts without reading across the session boundary. The
--      origin columns are deliberately not foreign keys: that record is
--      history and must outlive the research it came from, so removing an
--      origin never deletes another research's audit trail and never blocks a
--      deletion. A *reference* copy (metadata only, no captured text) leaves
--      the origin snapshot columns null — there is no version to point at, and
--      claiming otherwise would be inventing one.
--   5. Only material travels. No evidence, claim, verification or review row
--      is ever copied; the target session re-decides everything, and every
--      new evidence still starts `unverified` through the existing controlled
--      path. `fork_state` records the copy's own drift; the origin's drift is
--      derived on read and deliberately not stored as history.
--   6. Closed sets in the database. Every status-like column carries a CHECK
--      so the DB rejects values the domain does not allow (fail-closed).
ALTER TABLE "decision_sessions" ADD COLUMN IF NOT EXISTS "owner_user_id" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "source_share_grants" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "scope" text NOT NULL,
  "granted_by" text NOT NULL,
  "granted_at" timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at" timestamp with time zone,
  "revoked_by" text,
  "revoke_reason" text
);
--> statement-breakpoint

ALTER TABLE "source_share_grants" ADD CONSTRAINT "source_share_grants_subject_type_check" CHECK ("subject_type" IN ('user', 'role'));
--> statement-breakpoint
ALTER TABLE "source_share_grants" ADD CONSTRAINT "source_share_grants_scope_check" CHECK ("scope" IN ('read', 'copy'));
--> statement-breakpoint
-- A revocation must name who did it; an anonymous revocation is not auditable.
ALTER TABLE "source_share_grants" ADD CONSTRAINT "source_share_grants_revocation_attributed_check" CHECK ("revoked_at" IS NULL OR ("revoked_by" IS NOT NULL AND "revoke_reason" IS NOT NULL));
--> statement-breakpoint
-- One live grant per subject and scope: re-granting the same pair cannot
-- silently create a second, differently-dated authorization.
CREATE UNIQUE INDEX IF NOT EXISTS "source_share_grants_live_idx" ON "source_share_grants" USING btree (
  "session_id", "subject_type", "subject_id", "scope"
) WHERE "revoked_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_share_grants_subject_idx" ON "source_share_grants" USING btree ("subject_type", "subject_id") WHERE "revoked_at" IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "source_copies" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "source_id" uuid NOT NULL REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action,
  -- The origin reference is *history*, not a dependency: it records where the
  -- material came from and must outlive the research it came from. It is
  -- therefore deliberately not a foreign key — a cascade here would delete the
  -- target research's audit trail the moment the origin is removed, and a
  -- RESTRICT would let an old research block deletion forever. The ids stay
  -- meaningful even after the origin is gone; the copy itself is self-contained
  -- and its own session/source relations above still cascade normally.
  "origin_session_id" uuid NOT NULL,
  "origin_source_id" uuid NOT NULL,
  "origin_snapshot_id" uuid,
  "origin_snapshot_hash" text,
  "copied_by" text NOT NULL,
  "copied_at" timestamp with time zone NOT NULL DEFAULT now(),
  "fork_state" text NOT NULL DEFAULT 'synced',
  "forked_at" timestamp with time zone
);
--> statement-breakpoint

ALTER TABLE "source_copies" ADD CONSTRAINT "source_copies_fork_state_check" CHECK ("fork_state" IN ('synced', 'forked'));
--> statement-breakpoint
-- "Forked" must carry the moment it forked, or it is indistinguishable from
-- a copy that drifted silently at some unknown time.
ALTER TABLE "source_copies" ADD CONSTRAINT "source_copies_fork_has_timestamp_check" CHECK (("fork_state" = 'forked') = ("forked_at" IS NOT NULL));
--> statement-breakpoint
-- A source is copied into a session at most once; a second copy of the same
-- origin is a duplicate the domain already refuses (one canonical url per
-- session), so the lineage row is unique per (session, source).
CREATE UNIQUE INDEX IF NOT EXISTS "source_copies_session_source_idx" ON "source_copies" USING btree ("session_id", "source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "source_copies_origin_idx" ON "source_copies" USING btree ("origin_session_id", "origin_source_id");
--> statement-breakpoint
-- Library listing support: browse a session's material by recency.
CREATE INDEX IF NOT EXISTS "sources_session_created_idx" ON "sources" USING btree ("session_id", "created_at");
