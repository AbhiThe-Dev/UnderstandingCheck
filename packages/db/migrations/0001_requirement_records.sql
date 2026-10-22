CREATE TABLE "requirement_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" uuid,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"retired_reason" text,
	"current_version" integer DEFAULT 1 NOT NULL,
	"reaffirmations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirement_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"record_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"description" text NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"code_refs" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_redacted" boolean DEFAULT false NOT NULL,
	"confirmed_by" jsonb NOT NULL,
	"confirmation" text NOT NULL,
	"concern" text,
	"origin" text NOT NULL,
	"revised_in_meeting" boolean DEFAULT false NOT NULL,
	"session_id" uuid,
	"session_title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "records_published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requirement_records" ADD CONSTRAINT "requirement_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_records" ADD CONSTRAINT "requirement_records_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_versions" ADD CONSTRAINT "requirement_versions_record_id_requirement_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."requirement_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_versions" ADD CONSTRAINT "requirement_versions_session_id_meeting_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."meeting_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "records_workspace_number" ON "requirement_records" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE INDEX "records_workspace_repo" ON "requirement_records" USING btree ("workspace_id","repository_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_record_version" ON "requirement_versions" USING btree ("record_id","version");--> statement-breakpoint
CREATE INDEX "versions_session" ON "requirement_versions" USING btree ("session_id");