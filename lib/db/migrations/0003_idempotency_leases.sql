ALTER TABLE "idempotency_keys" ADD COLUMN "lease_token" text;
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "lease_expires_at" timestamp with time zone;
