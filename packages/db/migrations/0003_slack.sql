CREATE TABLE "slack_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"token_ciphertext" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"status_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_connections_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "slack_mode" text;--> statement-breakpoint
ALTER TABLE "requirement_versions" ADD COLUMN "slack_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;