-- Where one account stopped reading.
--
-- The notification centre derives every item it shows from rows that already
-- exist: a pending invitation in `research_memberships`, a failed run in
-- `agent_runs`. There is deliberately no `notifications` table. A stored copy
-- of a derived item is a second version of the truth, and the two drift the
-- moment either side changes its rules — the invitation is withdrawn and the
-- notification stays, a run is retried and succeeds while the "failed" card
-- remains. Deriving means a notification cannot outlive or contradict the
-- thing it is about.
--
-- What cannot be derived is what this table holds: which items an account has
-- already seen. A read marker for an item that no longer exists renders
-- nothing and counts toward nothing, so no cleanup job is required for
-- correctness.
--
-- Rollback: see migrations/rollback/0021_notification_reads.down.sql
--
-- Red lines honoured here:
--   * No notification content is stored. No title, body, or rendered text.
--   * No existing table is touched; this migration is purely additive.
--   * The read marker is per account and per item, and repeating the write is
--     a no-op thanks to the unique index.
CREATE TABLE IF NOT EXISTS "notification_reads" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "item_key" text NOT NULL,
  "read_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_reads_user_item_idx"
  ON "notification_reads" ("user_id", "item_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_reads_user_idx"
  ON "notification_reads" ("user_id", "read_at");
