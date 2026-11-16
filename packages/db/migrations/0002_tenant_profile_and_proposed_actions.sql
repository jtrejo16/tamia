ALTER TABLE "tenants" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "proposed_actions" jsonb DEFAULT '[]'::jsonb NOT NULL;