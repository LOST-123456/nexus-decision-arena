-- Inverse of 0019_team_collaboration.sql.
--
-- Undo only 0019. Any migration added after 0019 must be rolled back first,
-- newest going first. Drops only what 0019 introduced; rows written by
-- earlier prompts are not touched.

DROP INDEX IF EXISTS "research_review_requests_assigned_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_review_requests_requested_reviewer_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_review_requests_session_status_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "research_review_requests";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_comments_parent_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_comments_target_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "research_comments";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_work_items_assignee_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_work_items_session_status_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "research_work_items";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_memberships_user_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_memberships_session_role_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "research_memberships_live_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "research_memberships";
--> statement-breakpoint
DELETE FROM schema_migrations WHERE filename = '0019_team_collaboration.sql';
