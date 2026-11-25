CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"channel" text NOT NULL,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"party_size" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"notes" text,
	"seated_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"cancelled_by" text,
	"created_by" text DEFAULT 'bot' NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reservations_status_valid" CHECK ("reservations"."status" in ('confirmed', 'seated', 'completed', 'cancelled', 'no_show')),
	CONSTRAINT "reservations_party_range" CHECK ("reservations"."party_size" between 1 and 100),
	CONSTRAINT "reservations_interval_valid" CHECK ("reservations"."ends_at" > "reservations"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "voice_settings" ADD COLUMN "allow_reservations" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "reservations_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "reservations_capacity" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "reservations_stay_minutes" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "reservations_slot_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "reservations_max_party" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "reservations_min_notice_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "reservations_max_days_ahead" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "reservations_last_seating_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_tenant_number_uq" ON "reservations" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "reservations_tenant_starts_idx" ON "reservations" USING btree ("tenant_id","starts_at");--> statement-breakpoint
CREATE INDEX "reservations_contact_idx" ON "reservations" USING btree ("contact_id");--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_reservations_range" CHECK ("restaurant_settings"."reservations_capacity" between 1 and 2000 and "restaurant_settings"."reservations_stay_minutes" between 30 and 480 and "restaurant_settings"."reservations_slot_minutes" in (15, 30, 60) and "restaurant_settings"."reservations_max_party" between 1 and 100 and "restaurant_settings"."reservations_min_notice_minutes" between 0 and 10080 and "restaurant_settings"."reservations_max_days_ahead" between 1 and 365 and "restaurant_settings"."reservations_last_seating_minutes" between 0 and 480);
--> statement-breakpoint
-- Aislamiento por negocio.
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON reservations
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON reservations TO empleado_app;
