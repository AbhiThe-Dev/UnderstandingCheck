CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"estimated_cost" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clarifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"local_id" text NOT NULL,
	"discrepancy_local_id" text NOT NULL,
	"question" text NOT NULL,
	"format" text NOT NULL,
	"purpose" text NOT NULL,
	"targeted_participant_local_id" text,
	"response" jsonb NOT NULL,
	"resolution" text,
	"confirmation_status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_symbols" (
	"id" text PRIMARY KEY NOT NULL,
	"repository_id" uuid NOT NULL,
	"commit_sha" text NOT NULL,
	"file_path" text NOT NULL,
	"symbol_name" text NOT NULL,
	"symbol_type" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"signature" text NOT NULL,
	"content" text NOT NULL,
	"calls" jsonb NOT NULL,
	"effects" jsonb NOT NULL,
	"imports" jsonb NOT NULL,
	"is_test" boolean NOT NULL,
	"language" text NOT NULL,
	"name_terms" text NOT NULL,
	"path_terms" text NOT NULL,
	"body_terms" text NOT NULL,
	"searchable_content" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', name_terms), 'A') || setweight(to_tsvector('english', path_terms), 'B') || setweight(to_tsvector('english', body_terms), 'C')) STORED
);
--> statement-breakpoint
CREATE TABLE "discrepancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"local_id" text NOT NULL,
	"key" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"interpretations" jsonb NOT NULL,
	"impact_score" real NOT NULL,
	"confidence" real NOT NULL,
	"status" text NOT NULL,
	"visibility" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid,
	"title" text NOT NULL,
	"github_issue_reference" text,
	"feature_description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"analyzer" text NOT NULL,
	"commit_sha" text,
	"consent_confirmed_at" timestamp with time zone,
	"state" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"local_id" text NOT NULL,
	"display_name" text NOT NULL,
	"participant_role" text NOT NULL,
	"ambiguous" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"sample_key" text,
	"github_installation_id" text,
	"github_repository_id" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"indexed_commit_sha" text,
	"indexing_status" text DEFAULT 'pending' NOT NULL,
	"indexing_error" text,
	"indexing_progress" jsonb,
	"symbol_count" integer DEFAULT 0 NOT NULL,
	"indexed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"local_id" text NOT NULL,
	"lineage_id" text NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL,
	"confirmation" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"confirmed_by" jsonb NOT NULL,
	"version" integer NOT NULL,
	"supersedes" text,
	"discrepancy_local_id" text,
	"acceptance_criteria" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"local_id" text NOT NULL,
	"participant_local_id" text NOT NULL,
	"idx" integer NOT NULL,
	"timestamp_ms" integer NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"auth_provider" text,
	"auth_subject" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"transcript_retention_days" integer,
	"monthly_budget_usd" real DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_session_id_meeting_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clarifications" ADD CONSTRAINT "clarifications_session_id_meeting_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_symbols" ADD CONSTRAINT "code_symbols_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discrepancies" ADD CONSTRAINT "discrepancies_session_id_meeting_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD CONSTRAINT "meeting_sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_session_id_meeting_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_session_id_meeting_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_segments" ADD CONSTRAINT "transcript_segments_session_id_meeting_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_workspace_created" ON "ai_usage" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clarifications_session_local" ON "clarifications" USING btree ("session_id","local_id");--> statement-breakpoint
CREATE INDEX "code_symbols_repo_sha_name" ON "code_symbols" USING btree ("repository_id","commit_sha","symbol_name");--> statement-breakpoint
CREATE INDEX "code_symbols_search" ON "code_symbols" USING gin ("searchable_content");--> statement-breakpoint
CREATE UNIQUE INDEX "discrepancies_session_local" ON "discrepancies" USING btree ("session_id","local_id");--> statement-breakpoint
CREATE INDEX "discrepancies_status" ON "discrepancies" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "sessions_workspace_started" ON "meeting_sessions" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_session_local" ON "participants" USING btree ("session_id","local_id");--> statement-breakpoint
CREATE INDEX "repositories_workspace" ON "repositories" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirements_session_local" ON "requirements" USING btree ("session_id","local_id");--> statement-breakpoint
CREATE UNIQUE INDEX "segments_session_local" ON "transcript_segments" USING btree ("session_id","local_id");--> statement-breakpoint
CREATE INDEX "segments_session_idx" ON "transcript_segments" USING btree ("session_id","idx");--> statement-breakpoint
CREATE UNIQUE INDEX "users_workspace_email" ON "users" USING btree ("workspace_id","email");