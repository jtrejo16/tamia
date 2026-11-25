CREATE TABLE "order_item_modifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"group_name" text NOT NULL,
	"option_name" text NOT NULL,
	"price_delta_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"menu_item_id" uuid,
	"name" text NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_cents" integer NOT NULL,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "order_items_quantity_range" CHECK ("order_items"."quantity" between 1 and 50)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"contact_id" uuid NOT NULL,
	"conversation_id" uuid,
	"channel" text NOT NULL,
	"mode" text DEFAULT 'pickup' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text,
	"notes" text,
	"payment_method" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"estimated_ready_at" timestamp with time zone,
	"preparing_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"cancelled_by" text,
	"idempotency_key" text,
	"notified_at" timestamp with time zone,
	"notify_attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_status_valid" CHECK ("orders"."status" in ('new', 'preparing', 'ready', 'delivered', 'cancelled')),
	CONSTRAINT "orders_totals_nonneg" CHECK ("orders"."subtotal_cents" >= 0 and "orders"."total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "restaurant_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"accepting_orders" boolean DEFAULT true NOT NULL,
	"prep_minutes" integer DEFAULT 25 NOT NULL,
	"min_order_cents" integer DEFAULT 0 NOT NULL,
	"payment_methods" text[] DEFAULT '{"efectivo","tarjeta"}' NOT NULL,
	"transfer_info" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "restaurant_settings_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "restaurant_settings_prep_range" CHECK ("restaurant_settings"."prep_minutes" between 5 and 240),
	CONSTRAINT "restaurant_settings_min_nonneg" CHECK ("restaurant_settings"."min_order_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restaurant_settings" ADD CONSTRAINT "restaurant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_item_modifiers_item_idx" ON "order_item_modifiers" USING btree ("order_item_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_number_uq" ON "orders" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "orders_tenant_status_idx" ON "orders" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "orders_contact_idx" ON "orders" USING btree ("contact_id");
--> statement-breakpoint

-- Aislamiento por negocio.
ALTER TABLE restaurant_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE restaurant_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON restaurant_settings
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON order_items
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
ALTER TABLE order_item_modifiers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE order_item_modifiers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON order_item_modifiers
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON restaurant_settings, orders, order_items, order_item_modifiers TO empleado_app;
--> statement-breakpoint

-- Pedidos nuevos de los que toca avisar al equipo por correo: de negocios activos con avisos encendidos y al menos un
-- destinatario de correo. Cruza negocios (SECURITY DEFINER) pero solo devuelve ids; el worker trabaja cada negocio bajo su aislamiento.
CREATE FUNCTION orders_to_notify(p_limit integer)
RETURNS TABLE (tenant_id uuid, order_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT o.tenant_id, o.id
  FROM orders o
  JOIN notification_settings n ON n.tenant_id = o.tenant_id AND n.enabled
  JOIN tenants t ON t.id = o.tenant_id AND t.status = 'active'
  WHERE o.notified_at IS NULL AND o.status = 'new' AND o.notify_attempts < 5
    AND o.created_at > now() - interval '1 day'
    AND jsonb_path_exists(n.recipients, '$[*] ? (@.kind == "email" && @.enabled == true)')
  ORDER BY o.created_at
  LIMIT p_limit
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION orders_to_notify(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION orders_to_notify(integer) TO empleado_app;
