-- Inverse of 0017_multilingual_translations.sql.
--
-- Undo only 0017. Any migration added after 0017 must be rolled back first,
-- newest going first. This drops only the tables, constraints, indexes and
-- columns 0017 introduced; it does not touch rows written by earlier prompts.

DROP TABLE IF EXISTS "terminology";
--> statement-breakpoint
DROP TABLE IF EXISTS "translation_reviews";
--> statement-breakpoint
DROP TABLE IF EXISTS "translations";
--> statement-breakpoint
ALTER TABLE "source_snapshots" DROP COLUMN IF EXISTS "source_language";
--> statement-breakpoint
DELETE FROM schema_migrations WHERE filename = '0017_multilingual_translations.sql';
