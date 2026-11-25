import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, tenantRef, timestamps } from "./core";
import { contacts, conversations } from "./channels";

/**
 * Modulo "restaurante": el menu. Los precios van en centavos de peso mexicano (MXN).
 *
 * Categoria → Platillo. Los MODIFICADORES (tamano, masa, tortilla, extras, "sin cebolla"...) son grupos que se
 * definen UNA vez y se pegan a varios platillos: cambiar el precio de "Queso extra" se hace en un solo lugar.
 * Los nombres no distinguen mayusculas (indice unico sobre lower(nombre)).
 */

export const menuCategories = pgTable(
  "menu_categories",
  {
    id: pk(),
    tenantId: tenantRef(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("menu_categories_tenant_name_uq").on(t.tenantId, sql`lower(${t.name})`)],
);

export const menuItems = pgTable(
  "menu_items",
  {
    id: pk(),
    tenantId: tenantRef(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => menuCategories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Precio base en centavos. Las opciones de los modificadores suman encima. */
    priceCents: integer("price_cents").notNull(),
    /** false = agotado: el agente no lo ofrece, pero sigue en el menu. */
    available: boolean("available").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("menu_items_category_name_uq").on(t.categoryId, sql`lower(${t.name})`),
    index("menu_items_tenant_category_idx").on(t.tenantId, t.categoryId),
    check("menu_items_price_nonneg", sql`${t.priceCents} >= 0`),
  ],
);

export const menuModifierGroups = pgTable(
  "menu_modifier_groups",
  {
    id: pk(),
    tenantId: tenantRef(),
    name: text("name").notNull(),
    /** El cliente debe elegir al menos una opcion (por ejemplo el tamano de la pizza). */
    required: boolean("required").notNull().default(false),
    /** Puede elegir varias (extras). Si no, solo una. */
    multiple: boolean("multiple").notNull().default(false),
    /** Tope de opciones cuando es multiple; null = sin tope. */
    maxChoices: integer("max_choices"),
    ...timestamps,
  },
  (t) => [uniqueIndex("menu_modifier_groups_tenant_name_uq").on(t.tenantId, sql`lower(${t.name})`)],
);

export const menuModifierOptions = pgTable(
  "menu_modifier_options",
  {
    id: pk(),
    tenantId: tenantRef(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => menuModifierGroups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Lo que suma al precio del platillo (0 = sin costo). */
    priceDeltaCents: integer("price_delta_cents").notNull().default(0),
    available: boolean("available").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("menu_modifier_options_group_name_uq").on(t.groupId, sql`lower(${t.name})`),
    index("menu_modifier_options_tenant_group_idx").on(t.tenantId, t.groupId),
    check("menu_modifier_options_delta_nonneg", sql`${t.priceDeltaCents} >= 0`),
  ],
);

/** Que grupos de modificadores tiene cada platillo, y en que orden se le muestran al cliente. */
export const menuItemGroups = pgTable(
  "menu_item_groups",
  {
    id: pk(),
    tenantId: tenantRef(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => menuItems.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => menuModifierGroups.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("menu_item_groups_uq").on(t.itemId, t.groupId), index("menu_item_groups_tenant_idx").on(t.tenantId, t.groupId)],
);

// ------------------------------------------------------------------------------------------ pedidos

/**
 * Estados de un pedido: nuevo → preparando → listo → entregado (o cancelado en cualquier punto antes de entregar).
 * Los pedidos a domicilio pasan ademas por "en camino" entre listo y entregado.
 */
export const ORDER_STATUSES = ["new", "preparing", "ready", "on_the_way", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const PAYMENT_METHODS = ["efectivo", "tarjeta", "transferencia"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Ajustes del restaurante para pedidos (uno por negocio). Si no hay fila, valen los de por defecto. */
export const restaurantSettings = pgTable(
  "restaurant_settings",
  {
    id: pk(),
    tenantId: tenantRef().unique(),
    /** false = pedidos pausados (la cocina esta saturada): el asistente no toma pedidos nuevos. */
    acceptingOrders: boolean("accepting_orders").notNull().default(true),
    /** Minutos que se le dicen al cliente que tardara su pedido. */
    prepMinutes: integer("prep_minutes").notNull().default(25),
    minOrderCents: integer("min_order_cents").notNull().default(0),
    paymentMethods: text("payment_methods").array().notNull().default(["efectivo", "tarjeta"]),
    /** Datos para pagar por transferencia (CLABE, titular), si se acepta. */
    transferInfo: text("transfer_info"),
    /** Entrega a domicilio: solo a las zonas dadas de alta (delivery_zones). */
    deliveryEnabled: boolean("delivery_enabled").notNull().default(false),
    /** Minutos que se le dicen al cliente que tardara un pedido a domicilio. */
    deliveryMinutes: integer("delivery_minutes").notNull().default(40),
    /** Envio gratis desde este subtotal (null = nunca es gratis). */
    freeDeliveryFromCents: integer("free_delivery_from_cents"),
    ...timestamps,
  },
  (t) => [
    check("restaurant_settings_prep_range", sql`${t.prepMinutes} between 5 and 240`),
    check("restaurant_settings_delivery_range", sql`${t.deliveryMinutes} between 10 and 240`),
    check("restaurant_settings_min_nonneg", sql`${t.minOrderCents} >= 0`),
  ],
);

/** Zonas de entrega a domicilio (colonias o sectores) con su costo de envio. */
export const deliveryZones = pgTable(
  "delivery_zones",
  {
    id: pk(),
    tenantId: tenantRef(),
    name: text("name").notNull(),
    feeCents: integer("fee_cents").notNull().default(0),
    /** Pedido minimo para esta zona (0 = el general). */
    minOrderCents: integer("min_order_cents").notNull().default(0),
    active: boolean("active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("delivery_zones_tenant_name_uq").on(t.tenantId, sql`lower(${t.name})`),
    check("delivery_zones_amounts_nonneg", sql`${t.feeCents} >= 0 and ${t.minOrderCents} >= 0`),
  ],
);

/** Un pedido, venga del canal que venga (WhatsApp, Messenger, Instagram, llamada o panel). */
export const orders = pgTable(
  "orders",
  {
    id: pk(),
    tenantId: tenantRef(),
    /** Numero corto y consecutivo por negocio: "Pedido #12". */
    number: integer("number").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** whatsapp | messenger | instagram | voice | panel */
    channel: text("channel").notNull(),
    /** pickup (recoger en el local) | delivery (a domicilio). */
    mode: text("mode").$type<"pickup" | "delivery">().notNull().default("pickup"),
    status: text("status").$type<OrderStatus>().notNull().default("new"),
    /** Datos del cliente al momento de pedir (el contacto puede cambiar despues). */
    customerName: text("customer_name").notNull(),
    customerPhone: text("customer_phone"),
    notes: text("notes"),
    paymentMethod: text("payment_method").$type<PaymentMethod>().notNull(),
    subtotalCents: integer("subtotal_cents").notNull(),
    /** Costo de envio (0 en pedidos para recoger). El total ya lo incluye. */
    deliveryFeeCents: integer("delivery_fee_cents").notNull().default(0),
    /** Direccion de entrega tal como la dio el cliente (calle, numero, referencias). */
    deliveryAddress: text("delivery_address"),
    /** Zona de entrega al momento de pedir (el nombre se conserva aunque la zona cambie). */
    deliveryZoneName: text("delivery_zone_name"),
    totalCents: integer("total_cents").notNull(),
    estimatedReadyAt: timestamp("estimated_ready_at", { withTimezone: true }),
    preparingAt: timestamp("preparing_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    onTheWayAt: timestamp("on_the_way_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    /** cliente | equipo */
    cancelledBy: text("cancelled_by"),
    /** Huella del carrito: evita crear dos veces el mismo pedido si se repite la confirmacion. */
    idempotencyKey: text("idempotency_key"),
    /** Cuando se le aviso al equipo (correo) de este pedido nuevo. */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notifyAttempts: integer("notify_attempts").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("orders_tenant_number_uq").on(t.tenantId, t.number),
    index("orders_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
    index("orders_contact_idx").on(t.contactId),
    check("orders_status_valid", sql`${t.status} in ('new', 'preparing', 'ready', 'on_the_way', 'delivered', 'cancelled')`),
    check("orders_mode_valid", sql`${t.mode} in ('pickup', 'delivery')`),
    check("orders_totals_nonneg", sql`${t.subtotalCents} >= 0 and ${t.totalCents} >= 0 and ${t.deliveryFeeCents} >= 0`),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: pk(),
    tenantId: tenantRef(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** El platillo del menu (null si despues se borra del menu: el pedido conserva su nombre y precio). */
    menuItemId: uuid("menu_item_id").references(() => menuItems.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull(),
    /** Precio de esta partida: (precio base + modificadores) × cantidad. */
    lineTotalCents: integer("line_total_cents").notNull(),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("order_items_order_idx").on(t.orderId), check("order_items_quantity_range", sql`${t.quantity} between 1 and 50`)],
);

export const orderItemModifiers = pgTable(
  "order_item_modifiers",
  {
    id: pk(),
    tenantId: tenantRef(),
    orderItemId: uuid("order_item_id")
      .notNull()
      .references(() => orderItems.id, { onDelete: "cascade" }),
    groupName: text("group_name").notNull(),
    optionName: text("option_name").notNull(),
    priceDeltaCents: integer("price_delta_cents").notNull().default(0),
  },
  (t) => [index("order_item_modifiers_item_idx").on(t.orderItemId)],
);
