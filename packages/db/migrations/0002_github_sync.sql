CREATE TABLE "repository_files" (
	"repository_id" uuid NOT NULL,
	"path" text NOT NULL,
	"blob_sha" text NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "repository_files_repository_id_path_pk" PRIMARY KEY("repository_id","path")
);
--> statement-breakpoint
ALTER TABLE "meeting_sessions" ADD COLUMN "github_issue" jsonb;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "github_owner" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "github_name" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "html_url" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "last_sync" jsonb;--> statement-breakpoint
ALTER TABLE "repository_files" ADD CONSTRAINT "repository_files_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_workspace_github" ON "repositories" USING btree ("workspace_id","github_repository_id");