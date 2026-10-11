-- Inverse of 0010_source_independence.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0010.
--
-- Both tables are dropped wholesale. They hold human assertions and overrides,
-- never domain records: `sources`, `evidence` and `claims` rows are untouched.
-- What is lost is the audit trail of who declared which relation and which
-- profile was corrected — and nothing else. In particular no source,
-- no snapshot, no verification status and no verdict is stored here.
--
-- This script undoes 0010 only. It must not assume anything about migrations
-- added after 0010 — roll any newer ones back first, newest going first.
DROP INDEX IF EXISTS "source_profile_overrides_session_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "source_profile_overrides_current_idx";
--> statement-breakpoint
ALTER TABLE "source_profile_overrides" DROP CONSTRAINT IF EXISTS "source_profile_overrides_origin_check";
--> statement-breakpoint
ALTER TABLE "source_profile_overrides" DROP CONSTRAINT IF EXISTS "source_profile_overrides_kind_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "source_profile_overrides";
--> statement-breakpoint
DROP INDEX IF EXISTS "source_relations_session_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "source_relations_current_idx";
--> statement-breakpoint
ALTER TABLE "source_relations" DROP CONSTRAINT IF EXISTS "source_relations_distinct_check";
--> statement-breakpoint
ALTER TABLE "source_relations" DROP CONSTRAINT IF EXISTS "source_relations_origin_check";
--> statement-breakpoint
ALTER TABLE "source_relations" DROP CONSTRAINT IF EXISTS "source_relations_basis_check";
--> statement-breakpoint
ALTER TABLE "source_relations" DROP CONSTRAINT IF EXISTS "source_relations_kind_check";
--> statement-breakpoint
DROP TABLE IF EXISTS "source_relations";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0010 state as well, otherwise
-- `db:migrate` would skip 0010 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0010_source_independence.sql';
