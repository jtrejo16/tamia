CREATE TABLE "delivery_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"min_order_cents" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_zones_amounts_nonneg" CHECK ("delivery_zones"."fee_cents" >= 0 and "delivery_zones"."min_order_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_status_valid";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_totals_nonneg";--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_address" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_zone_name" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "on_the_way_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "delivery_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "delivery_minutes" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD COLUMN "free_delivery_from_cents" integer;--> statement-breakpoint
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_zones_tenant_name_uq" ON "delivery_zones" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_mode_valid" CHECK ("orders"."mode" in ('pickup', 'delivery'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_valid" CHECK ("orders"."status" in ('new', 'preparing', 'ready', 'on_the_way', 'delivered', 'cancelled'));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_totals_nonneg" CHECK ("orders"."subtotal_cents" >= 0 and "orders"."total_cents" >= 0 and "orders"."delivery_fee_cents" >= 0);--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_delivery_range" CHECK ("restaurant_settings"."delivery_minutes" between 10 and 240);
--> statement-breakpoint
-- Aislamiento por negocio.
ALTER TABLE delivery_zones ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE delivery_zones FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON delivery_zones
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_zones TO empleado_app;
