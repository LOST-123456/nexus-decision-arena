-- Reverse of 0021. Only this migration's own table is dropped; nothing else
-- references it, and no source row is touched.
DROP INDEX IF EXISTS "notification_reads_user_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "notification_reads_user_item_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "notification_reads";
