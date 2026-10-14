-- Inverse of 0018_source_library.sql.
--
-- Undo only 0018. Any migration added after 0018 must be rolled back first,
-- newest going first. Drops only what 0018 introduced; rows written by
-- earlier prompts are not touched.

DROP INDEX IF EXISTS "sources_session_created_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "source_copies";
--> statement-breakpoint
DROP TABLE IF EXISTS "source_share_grants";
--> statement-breakpoint
ALTER TABLE "decision_sessions" DROP COLUMN IF EXISTS "owner_user_id";
--> statement-breakpoint
DELETE FROM schema_migrations WHERE filename = '0018_source_library.sql';
