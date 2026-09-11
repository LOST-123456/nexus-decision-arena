CREATE TABLE "agent_roles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"perspective" text NOT NULL,
	"evaluation_criteria" jsonb NOT NULL,
	"evidence_required" jsonb NOT NULL,
	"conflict_preference" jsonb NOT NULL,
	"lenses" jsonb NOT NULL,
	"prompt_version_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"prompt_version_id" uuid NOT NULL,
	"status" text NOT NULL,
	"correlation_id" uuid,
	"trace_id" text,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"target_claim_id" uuid NOT NULL,
	"challenger_run_id" uuid NOT NULL,
	"challenger_role_id" uuid NOT NULL,
	"type" text NOT NULL,
	"question" text NOT NULL,
	"context" jsonb NOT NULL,
	"required_evidence" jsonb NOT NULL,
	"severity" integer NOT NULL,
	"resolution_strategy" text NOT NULL,
	"status" text NOT NULL,
	"response_claim_id" uuid,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"agent_run_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"lens" text NOT NULL,
	"statement" text NOT NULL,
	"type" text NOT NULL,
	"stance" text NOT NULL,
	"importance" integer NOT NULL,
	"confidence" double precision NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"status" text NOT NULL,
	"root_claim_id" uuid NOT NULL,
	"revision_of_claim_id" uuid,
	"revision" integer NOT NULL,
	"relations" jsonb NOT NULL,
	"responds_to_challenge_id" uuid,
	"disposition" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflicts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"claim_ids" jsonb NOT NULL,
	"challenge_ids" jsonb NOT NULL,
	"type" text NOT NULL,
	"summary" text NOT NULL,
	"severity" integer NOT NULL,
	"status" text NOT NULL,
	"human_decision_required" boolean NOT NULL,
	"resolution_suggestion" text NOT NULL,
	"impact_scope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"locale" text NOT NULL,
	"phase" text NOT NULL,
	"operational_status" text NOT NULL,
	"current_conclusion" text,
	"next_event_sequence" integer DEFAULT 1 NOT NULL,
	"pause_reason" text,
	"resume_phase" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"description" text NOT NULL,
	"source_ref" text,
	"direction" text NOT NULL,
	"reliability" double precision NOT NULL,
	"verification_status" text NOT NULL,
	"validity_period" jsonb,
	"retrieved_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"agent_run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "execution_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"correlation_id" uuid NOT NULL,
	"trace_id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"prompt_version_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"conflict_id" uuid NOT NULL,
	"action" text NOT NULL,
	"rationale" text NOT NULL,
	"affected_claim_ids" jsonb NOT NULL,
	"affected_agent_role_ids" jsonb NOT NULL,
	"previous_conclusion" text NOT NULL,
	"new_conclusion" text NOT NULL,
	"operator_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"input" jsonb NOT NULL,
	"locale" text DEFAULT 'zh-CN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_roles" ADD CONSTRAINT "agent_roles_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_decision_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_role_id_agent_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."agent_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_session_id_decision_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_target_claim_id_claims_id_fk" FOREIGN KEY ("target_claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_challenger_run_id_agent_runs_id_fk" FOREIGN KEY ("challenger_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_challenger_role_id_agent_roles_id_fk" FOREIGN KEY ("challenger_role_id") REFERENCES "public"."agent_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "challenges" ADD CONSTRAINT "challenges_response_claim_id_claims_id_fk" FOREIGN KEY ("response_claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_session_id_decision_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_role_id_agent_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."agent_roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_root_claim_id_claims_id_fk" FOREIGN KEY ("root_claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_revision_of_claim_id_claims_id_fk" FOREIGN KEY ("revision_of_claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_responds_to_challenge_id_challenges_id_fk" FOREIGN KEY ("responds_to_challenge_id") REFERENCES "public"."challenges"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_session_id_decision_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_sessions" ADD CONSTRAINT "decision_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_session_id_decision_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_session_id_decision_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_events" ADD CONSTRAINT "execution_events_prompt_version_id_prompt_versions_id_fk" FOREIGN KEY ("prompt_version_id") REFERENCES "public"."prompt_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_session_id_decision_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."decision_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_decisions" ADD CONSTRAINT "human_decisions_conflict_id_conflicts_id_fk" FOREIGN KEY ("conflict_id") REFERENCES "public"."conflicts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_events_session_sequence_idx" ON "execution_events" USING btree ("session_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_versions_name_version_idx" ON "prompt_versions" USING btree ("name","version");
