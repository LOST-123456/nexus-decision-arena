ALTER TABLE "decision_sessions" ADD COLUMN "supplement_round" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_roles_key_idx" ON "agent_roles" USING btree ("key");
--> statement-breakpoint
CREATE TABLE "final_reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"project_name" text NOT NULL,
	"executive_summary" text NOT NULL,
	"initial_conclusion" text NOT NULL,
	"post_challenge_conclusion" text NOT NULL,
	"human_action" text NOT NULL,
	"final_conclusion" text NOT NULL,
	"decision_explanation" text NOT NULL,
	"required_next_actions" jsonb NOT NULL,
	"decisive_challenge_ids" jsonb NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"human_decision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "final_reports" ADD CONSTRAINT "final_reports_session_id_decision_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "final_reports" ADD CONSTRAINT "final_reports_human_decision_id_human_decisions_id_fk" FOREIGN KEY ("human_decision_id") REFERENCES "public"."human_decisions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "final_reports_session_id_idx" ON "final_reports" USING btree ("session_id");
