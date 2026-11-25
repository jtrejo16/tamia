import { asc } from "drizzle-orm";
import type { Tx } from "./client";
import { deliveryZones, menuCategories, menuItemGroups, menuItems, menuModifierGroups, menuModifierOptions, restaurantSettings } from "./schema";

/**
 * El menu de un negocio leido completo (modulo "restaurante"). Un menu cabe en memoria (decenas o pocos cientos de
 * platillos), asi que se lee entero y se arma aqui. Lo usan el panel y el agente: UNA sola forma de leerlo.
 * Debe llamarse dentro de withTenant: el aislamiento por negocio lo pone la base de datos (RLS).
 */

export interface MenuOptionRow {
  id: string;
  name: string;
  priceDeltaCents: number;
  available: boolean;
}

export interface MenuGroupRow {
  id: string;
  name: string;
  required: boolean;
  multiple: boolean;
  maxChoices: number | null;
  options: MenuOptionRow[];
}

export interface MenuItemRow {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  priceCents: number;
  available: boolean;
  /** Ids de los grupos de modificadores del platillo, en el orden en que se le muestran al cliente. */
  groupIds: string[];
}

export interface MenuCategoryRow {
  id: string;
  name: string;
  items: MenuItemRow[];
}

export interface MenuData {
  categories: MenuCategoryRow[];
  groups: MenuGroupRow[];
}

export async function loadMenu(tx: Tx): Promise<MenuData> {
  const [cats, items, groups, options, links] = await Promise.all([
    tx.select().from(menuCategories).orderBy(asc(menuCategories.sortOrder), asc(menuCategories.name)),
    tx.select().from(menuItems).orderBy(asc(menuItems.sortOrder), asc(menuItems.name)),
    tx.select().from(menuModifierGroups).orderBy(asc(menuModifierGroups.name)),
    tx.select().from(menuModifierOptions).orderBy(asc(menuModifierOptions.sortOrder), asc(menuModifierOptions.name)),
    tx.select().from(menuItemGroups).orderBy(asc(menuItemGroups.sortOrder)),
  ]);

  const linksBy = new Map<string, string[]>();
  for (const l of links) (linksBy.get(l.itemId) ?? linksBy.set(l.itemId, []).get(l.itemId)!).push(l.groupId);

  const optionsBy = new Map<string, MenuOptionRow[]>();
  for (const o of options) {
    const row: MenuOptionRow = { id: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents, available: o.available };
    (optionsBy.get(o.groupId) ?? optionsBy.set(o.groupId, []).get(o.groupId)!).push(row);
  }

  const itemsBy = new Map<string, MenuItemRow[]>();
  for (const i of items) {
    const row: MenuItemRow = {
      id: i.id,
      categoryId: i.categoryId,
      name: i.name,
      description: i.description,
      priceCents: i.priceCents,
      available: i.available,
      groupIds: linksBy.get(i.id) ?? [],
    };
    (itemsBy.get(i.categoryId) ?? itemsBy.set(i.categoryId, []).get(i.categoryId)!).push(row);
  }

  return {
    categories: cats.map((c) => ({ id: c.id, name: c.name, items: itemsBy.get(c.id) ?? [] })),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      required: g.required,
      multiple: g.multiple,
      maxChoices: g.maxChoices,
      options: optionsBy.get(g.id) ?? [],
    })),
  };
}

/** Ajustes de pedidos del restaurante. Si el negocio nunca los guardo, valen estos. */
export interface RestaurantSettingsRow {
  acceptingOrders: boolean;
  prepMinutes: number;
  minOrderCents: number;
  paymentMethods: string[];
  transferInfo: string | null;
  deliveryEnabled: boolean;
  deliveryMinutes: number;
  /** Envio gratis desde este subtotal (null = nunca). */
  freeDeliveryFromCents: number | null;
  reservationsEnabled: boolean;
  /** Comensales que caben al mismo tiempo. */
  reservationsCapacity: number;
  reservationsStayMinutes: number;
  reservationsSlotMinutes: number;
  reservationsMaxParty: number;
  reservationsMinNoticeMinutes: number;
  reservationsMaxDaysAhead: number;
  reservationsLastSeatingMinutes: number;
}

export const DEFAULT_RESTAURANT_SETTINGS: RestaurantSettingsRow = {
  acceptingOrders: true,
  prepMinutes: 25,
  minOrderCents: 0,
  paymentMethods: ["efectivo", "tarjeta"],
  transferInfo: null,
  deliveryEnabled: false,
  deliveryMinutes: 40,
  freeDeliveryFromCents: null,
  reservationsEnabled: false,
  reservationsCapacity: 40,
  reservationsStayMinutes: 90,
  reservationsSlotMinutes: 30,
  reservationsMaxParty: 10,
  reservationsMinNoticeMinutes: 60,
  reservationsMaxDaysAhead: 30,
  reservationsLastSeatingMinutes: 60,
};

export async function loadRestaurantSettings(tx: Tx): Promise<RestaurantSettingsRow> {
  const [row] = await tx.select().from(restaurantSettings).limit(1);
  if (!row) return { ...DEFAULT_RESTAURANT_SETTINGS };
  return {
    acceptingOrders: row.acceptingOrders,
    prepMinutes: row.prepMinutes,
    minOrderCents: row.minOrderCents,
    paymentMethods: row.paymentMethods,
    transferInfo: row.transferInfo,
    deliveryEnabled: row.deliveryEnabled,
    deliveryMinutes: row.deliveryMinutes,
    freeDeliveryFromCents: row.freeDeliveryFromCents,
    reservationsEnabled: row.reservationsEnabled,
    reservationsCapacity: row.reservationsCapacity,
    reservationsStayMinutes: row.reservationsStayMinutes,
    reservationsSlotMinutes: row.reservationsSlotMinutes,
    reservationsMaxParty: row.reservationsMaxParty,
    reservationsMinNoticeMinutes: row.reservationsMinNoticeMinutes,
    reservationsMaxDaysAhead: row.reservationsMaxDaysAhead,
    reservationsLastSeatingMinutes: row.reservationsLastSeatingMinutes,
  };
}

export interface DeliveryZoneRow {
  id: string;
  name: string;
  feeCents: number;
  /** Pedido minimo propio de la zona (0 = vale el general). */
  minOrderCents: number;
  active: boolean;
}

export async function loadDeliveryZones(tx: Tx): Promise<DeliveryZoneRow[]> {
  const rows = await tx.select().from(deliveryZones).orderBy(asc(deliveryZones.sortOrder), asc(deliveryZones.name));
  return rows.map((z) => ({ id: z.id, name: z.name, feeCents: z.feeCents, minOrderCents: z.minOrderCents, active: z.active }));
}
