-- Team collaboration & human review workflow for a research session.
--
-- Rollback: see migrations/rollback/0019_team_collaboration.down.sql
--
-- Five invariants this migration is built around:
--   1. The session boundary is sacred. Every table here is keyed by
--      `session_id` and cascades on the session. A row never leaks across the
--      session boundary: the session-scoped read paths answer 404 for any id
--      that does not belong to the caller's session, by the same rule as the
--      rest of the repository layer.
--   2. A grant is a row, not a hope — and so is a membership. Exactly one
--      live membership (status `pending` or `active`) may exist per
--      (session, user); the partial unique index below enforces it. Inviting
--      someone is creating a `pending` membership; accepting promotes it to
--      `active`; declining or removing keeps the row as the audit trail.
--   3. Closed sets in the database. Every status-like column carries a CHECK
--      so the DB rejects values the domain does not allow (fail-closed). The
--      role/status/decision columns are all enumerated here.
--   4. Attribution is server-side and unforgeable. `invited_by`, `created_by`,
--      `author_user_id`, `requested_by`, `decided_by` are written by the
--      service from the login identity (or the implicit operator) and never
--      taken from the request body, so a caller cannot author a comment or a
--      decision as someone else.
--   5. Optimistic concurrency. Every mutable row carries a `version` column;
--      an UPDATE that does not match the expected version affects zero rows
--      and is reported as a 409 conflict rather than silently overwriting
--      another writer's change.
ALTER TABLE "decision_sessions" ADD COLUMN IF NOT EXISTS "owner_user_id" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "research_memberships" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "user_id" text NOT NULL,
  "role" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "invited_by" text NOT NULL,
  "invited_at" timestamp with time zone NOT NULL DEFAULT now(),
  "joined_at" timestamp with time zone,
  "status_changed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "removed_by" text,
  "remove_reason" text,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "research_memberships" ADD CONSTRAINT "research_memberships_role_check" CHECK ("role" IN ('owner', 'editor', 'reviewer', 'viewer'));
--> statement-breakpoint
ALTER TABLE "research_memberships" ADD CONSTRAINT "research_memberships_status_check" CHECK ("status" IN ('pending', 'active', 'declined', 'removed'));
--> statement-breakpoint
-- A membership that has actually joined (status `active`, or `removed` after
-- having been active) records when it joined; a `pending` or `declined` one has
-- not. Allowing `joined_at` on a row that never joined would let a
-- not-yet-joined member look established, while a removed member keeps the
-- audit trail of when they joined.
ALTER TABLE "research_memberships" ADD CONSTRAINT "research_memberships_active_has_joined_check" CHECK (("joined_at" IS NULL) OR ("status" IN ('active', 'removed')));
--> statement-breakpoint
-- A removal must name who did it and why — an anonymous removal is not
-- auditable, and a removal that forgot its reason is one a later reader cannot
-- trust.
ALTER TABLE "research_memberships" ADD CONSTRAINT "research_memberships_removed_attributed_check" CHECK ("status" <> 'removed' OR ("removed_by" IS NOT NULL AND "remove_reason" IS NOT NULL));
--> statement-breakpoint
-- At most one live membership per user in a session: a second pending or
-- active row for the same person would mean two simultaneous, contradictory
-- invitations that the domain refuses anyway.
CREATE UNIQUE INDEX IF NOT EXISTS "research_memberships_live_idx" ON "research_memberships" USING btree ("session_id", "user_id") WHERE "status" IN ('pending', 'active');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_memberships_session_role_idx" ON "research_memberships" USING btree ("session_id", "role") WHERE "status" = 'active';
--> statement-breakpoint
-- List the sessions a user is active in without scanning every membership.
CREATE INDEX IF NOT EXISTS "research_memberships_user_idx" ON "research_memberships" USING btree ("user_id") WHERE "status" = 'active';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "research_work_items" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "title" text NOT NULL,
  "description" text,
  "status" text NOT NULL DEFAULT 'open',
  "assignee_user_id" text,
  "target_type" text,
  "target_id" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "due_at" timestamp with time zone,
  "version" integer NOT NULL DEFAULT 1
);
--> statement-breakpoint

ALTER TABLE "research_work_items" ADD CONSTRAINT "research_work_items_status_check" CHECK ("status" IN ('open', 'in_progress', 'in_review', 'completed', 'cancelled'));
--> statement-breakpoint
-- A work item is either a free-form task or a pointer at an existing research
-- artifact (a plan item, a revalidation task, an evidence gap, a source
-- monitoring task, or an agent run). This keeps the collaboration layer from
-- duplicating the existing task systems: it assigns and tracks, it does not
-- re-model the work itself.
ALTER TABLE "research_work_items" ADD CONSTRAINT "research_work_items_target_type_check" CHECK ("target_type" IS NULL OR "target_type" IN ('plan_item', 'revalidation_task', 'evidence_gap', 'source_monitor_task', 'agent_run', 'work_item'));
--> statement-breakpoint
-- `completed` must carry the moment it completed; anything else must not
-- pretend to know when it finished.
ALTER TABLE "research_work_items" ADD CONSTRAINT "research_work_items_completed_attributed_check" CHECK (("status" = 'completed') = ("completed_at" IS NOT NULL));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_work_items_session_status_idx" ON "research_work_items" USING btree ("session_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_work_items_assignee_idx" ON "research_work_items" USING btree ("assignee_user_id") WHERE "assignee_user_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "research_comments" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "author_user_id" text NOT NULL,
  "body" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "parent_comment_id" text,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
--> statement-breakpoint

ALTER TABLE "research_comments" ADD CONSTRAINT "research_comments_target_type_check" CHECK ("target_type" IN ('claim', 'evidence', 'source', 'conflict', 'challenge', 'plan_item', 'revalidation_task', 'report_snapshot', 'work_item'));
--> statement-breakpoint
-- An empty comment is noise; an unbounded one is an abuse vector. The length
-- cap is enforced here too, so a body the application failed to trim cannot
-- land.
ALTER TABLE "research_comments" ADD CONSTRAINT "research_comments_body_check" CHECK (char_length("body") > 0 AND char_length("body") <= 5000);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_comments_target_idx" ON "research_comments" USING btree ("session_id", "target_type", "target_id") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
-- Threading lookup: a reply's parent, without a foreign key so a soft-deleted
-- parent does not cascade away the conversation.
CREATE INDEX IF NOT EXISTS "research_comments_parent_idx" ON "research_comments" USING btree ("parent_comment_id") WHERE "parent_comment_id" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "research_review_requests" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "public"."decision_sessions"("id") ON DELETE cascade ON UPDATE no action,
  "request_type" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "requested_by" text NOT NULL,
  "requested_reviewer_user_id" text,
  "status" text NOT NULL DEFAULT 'open',
  "assigned_reviewer_user_id" text,
  "decision" text,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "version" integer NOT NULL DEFAULT 1
);
--> statement-breakpoint

ALTER TABLE "research_review_requests" ADD CONSTRAINT "research_review_requests_request_type_check" CHECK ("request_type" IN ('claim_review', 'source_review', 'report_review', 'conflict_review'));
--> statement-breakpoint
ALTER TABLE "research_review_requests" ADD CONSTRAINT "research_review_requests_target_type_check" CHECK ("target_type" IN ('claim', 'evidence', 'source', 'conflict', 'report_snapshot'));
--> statement-breakpoint
ALTER TABLE "research_review_requests" ADD CONSTRAINT "research_review_requests_status_check" CHECK ("status" IN ('open', 'in_review', 'completed', 'cancelled'));
--> statement-breakpoint
ALTER TABLE "research_review_requests" ADD CONSTRAINT "research_review_requests_decision_check" CHECK ("decision" IS NULL OR "decision" IN ('approved', 'rejected'));
--> statement-breakpoint
-- An open request has no reviewer yet; an in_review request has exactly one.
-- Keeping these in lock-step prevents a request that is both unassigned and
-- "in review", which would be a review that is happening with nobody doing it.
ALTER TABLE "research_review_requests" ADD CONSTRAINT "research_review_requests_assignment_check" CHECK (
  ("status" = 'open' AND "assigned_reviewer_user_id" IS NULL)
  OR ("status" = 'in_review' AND "assigned_reviewer_user_id" IS NOT NULL)
  OR ("status" IN ('completed', 'cancelled'))
);
--> statement-breakpoint
-- A completed request records its decision and who made it; anything not
-- completed records nothing. A `decision` on a still-open request would be a
-- verdict rendered before anyone reviewed.
ALTER TABLE "research_review_requests" ADD CONSTRAINT "research_review_requests_decision_attributed_check" CHECK (
  ("status" = 'completed') = ("decision" IS NOT NULL AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_review_requests_session_status_idx" ON "research_review_requests" USING btree ("session_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_review_requests_requested_reviewer_idx" ON "research_review_requests" USING btree ("requested_reviewer_user_id") WHERE "requested_reviewer_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "research_review_requests_assigned_idx" ON "research_review_requests" USING btree ("assigned_reviewer_user_id") WHERE "assigned_reviewer_user_id" IS NOT NULL;
