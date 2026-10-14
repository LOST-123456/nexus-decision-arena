-- Multilingual research & cross-language evidence verification.
--
-- Adds language metadata to source snapshots and three new tables:
--   * source_snapshots.source_language  (nullable, so older immutable captures
--     keep validating)
--   * translations          — auxiliary, per-snapshot-version, never a fact
--   * translation_reviews   — append-only human review log
--   * terminology           — session-scoped glossary
--
-- Red lines honoured here:
--   * Translations are derived and keyed to a snapshot version; they never alter
--     the original snapshot text and never write an Evidence verification.
--   * Every closed-set status/action column carries a CHECK so the database
--     rejects values the domain does not allow (fail-closed).
--   * No historical migration is modified; this only appends.
--   * The earlier `language_detection` idea was dropped before commit: no code
--     reads it, so it is not shipped here and the down script has nothing to
--     undo for it. Detection lives in the application, not the capture row.
-- Rollback: see migrations/rollback/0017_multilingual_translations.down.sql

ALTER TABLE "source_snapshots" ADD COLUMN IF NOT EXISTS "source_language" text;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "translations" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "decision_sessions" ("id"),
  "source_snapshot_id" uuid NOT NULL REFERENCES "source_snapshots" ("id") ON DELETE cascade,
  "source_language" text NOT NULL,
  "target_language" text NOT NULL,
  "text_hash" text NOT NULL,
  "translated_text" text NOT NULL,
  "segment_mappings" jsonb NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL DEFAULT 'n/a',
  "status" text NOT NULL,
  "failure_reason" text,
  "failure_code" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- A translation target is always one of the supported languages.
ALTER TABLE "translations" ADD CONSTRAINT "translations_target_language_check" CHECK (
  "target_language" IN ('zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es')
);
--> statement-breakpoint

-- Closed set of translation lifecycle states.
ALTER TABLE "translations" ADD CONSTRAINT "translations_status_check" CHECK (
  "status" IN ('pending', 'completed', 'failed', 'unavailable')
);
--> statement-breakpoint

-- Cache / dedup key: snapshot version + languages + text hash + provider + model.
CREATE UNIQUE INDEX IF NOT EXISTS "translations_dedup_idx" ON "translations" USING btree (
  "source_snapshot_id", "source_language", "target_language", "text_hash", "provider", "model"
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "translations_session_idx" ON "translations" USING btree ("session_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "translation_reviews" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "decision_sessions" ("id"),
  "translation_id" uuid NOT NULL REFERENCES "translations" ("id") ON DELETE cascade,
  "reviewed_by" text NOT NULL,
  "action" text NOT NULL,
  "review_status" text NOT NULL,
  "correction_text" text,
  "note" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

ALTER TABLE "translation_reviews" ADD CONSTRAINT "translation_reviews_action_check" CHECK (
  "action" IN ('approve', 'flag', 'request-retranslation', 'add-correction')
);
--> statement-breakpoint

ALTER TABLE "translation_reviews" ADD CONSTRAINT "translation_reviews_review_status_check" CHECK (
  "review_status" IN ('pending', 'approved', 'flagged', 'needs-retranslation', 'corrected')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "translation_reviews_translation_idx" ON "translation_reviews" USING btree ("translation_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "terminology" (
  "id" uuid PRIMARY KEY,
  "session_id" uuid NOT NULL REFERENCES "decision_sessions" ("id"),
  "source_term" text NOT NULL,
  "suggested_translation" text,
  "confirmed_translation" text,
  "language" text NOT NULL,
  "context" text,
  "reviewed_at" timestamp with time zone,
  "reviewed_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "terminology_session_term_idx" ON "terminology" USING btree ("session_id", "source_term");
