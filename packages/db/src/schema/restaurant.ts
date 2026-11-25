import { boolean, check, index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, tenantRef, timestamps } from "./core";

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
