-- Inverse of 0006_claim_reviews.sql.
--
-- The migration runner has no "down" command, so this file lives in
-- migrations/rollback/ (a subdirectory) to keep it out of the runner's
-- non-recursive scan. Apply it manually to undo 0006.
--
-- 0006 only adds a table, so nothing else in the schema depends on it and the
-- rollback is a plain drop. Dropping it discards recorded human rulings; that
-- is the documented cost of rolling the feature back.

DROP INDEX IF EXISTS "claim_reviews_session_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "claim_reviews_claim_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "claim_reviews";
--> statement-breakpoint
-- Leave the migration ledger in the pre-0006 state as well, otherwise
-- `db:migrate` would skip 0006 on the next run and the schema would silently
-- stay behind.
DELETE FROM schema_migrations WHERE filename = '0006_claim_reviews.sql';
