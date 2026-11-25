import {
  auditLog,
  menuCategories,
  menuItemGroups,
  menuItems,
  menuModifierGroups,
  menuModifierOptions,
  tenants,
  withTenant,
  type Database,
  type Tx,
} from "@empleado/db";
import { starterMenuFor } from "@empleado/shared";
import { eq } from "drizzle-orm";

/**
 * Menu de arranque de los giros de restaurante (taqueria, pizzeria, restaurante). Se carga UNA vez, al dar de alta el negocio
 * (o cuando el operador le cambia el giro y su menu esta vacio), para que el asistente funcione desde el primer minuto.
 * Los datos son de EJEMPLO: el negocio queda marcado como «menu sin revisar» hasta que el dueno cambia algo del menu.
 */

export type StarterResult = { applied: true; items: number } | { applied: false; reason: "no_template" | "menu_not_empty" };

const cents = (pesos: number) => Math.round(pesos * 100);

export async function applyStarterMenu(db: Database, tenantId: string, vertical: string): Promise<StarterResult> {
  const template = starterMenuFor(vertical);
  if (!template) return { applied: false, reason: "no_template" };

  return withTenant(db, { tenantId }, async (tx) => {
    const existing = await tx.select({ id: menuCategories.id }).from(menuCategories).limit(1);
    if (existing.length > 0) return { applied: false as const, reason: "menu_not_empty" as const };

    const groupIds = new Map<string, string>();
    for (const g of template.groups) {
      const [row] = await tx
        .insert(menuModifierGroups)
        .values({ tenantId, name: g.name, required: g.required ?? false, multiple: g.multiple ?? false, maxChoices: g.multiple ? (g.maxChoices ?? null) : null })
        .returning({ id: menuModifierGroups.id });
      groupIds.set(g.key, row!.id);
      await tx.insert(menuModifierOptions).values(g.options.map((o, i) => ({ tenantId, groupId: row!.id, name: o.name, priceDeltaCents: cents(o.extra ?? 0), sortOrder: i })));
    }

    let items = 0;
    for (const [ci, c] of template.categories.entries()) {
      const [cat] = await tx.insert(menuCategories).values({ tenantId, name: c.name, sortOrder: ci }).returning({ id: menuCategories.id });
      for (const [ii, item] of c.items.entries()) {
        const [row] = await tx
          .insert(menuItems)
          .values({ tenantId, categoryId: cat!.id, name: item.name, description: item.description ?? null, priceCents: cents(item.price), sortOrder: ii })
          .returning({ id: menuItems.id });
        items++;
        const links = (item.groups ?? []).flatMap((key, i) => (groupIds.has(key) ? [{ tenantId, itemId: row!.id, groupId: groupIds.get(key)!, sortOrder: i }] : []));
        if (links.length > 0) await tx.insert(menuItemGroups).values(links);
      }
    }

    const [t] = await tx.select({ profile: tenants.profile }).from(tenants).where(eq(tenants.id, tenantId));
    await tx.update(tenants).set({ profile: { ...(t?.profile ?? {}), starterMenu: { template: template.id, reviewed: false } } }).where(eq(tenants.id, tenantId));
    await tx.insert(auditLog).values({ tenantId, action: "menu.starter", entity: "menu", entityId: null, diff: { template: template.id, items } });
    return { applied: true as const, items };
  });
}

/** El dueno cambio algo del menu: el menu de ejemplo ya cuenta como revisado. Se llama desde cada cambio del menu. */
export async function markStarterReviewed(tx: Tx, tenantId: string): Promise<void> {
  const [t] = await tx.select({ profile: tenants.profile }).from(tenants).where(eq(tenants.id, tenantId));
  const starter = t?.profile?.starterMenu;
  if (!starter || starter.reviewed) return;
  await tx.update(tenants).set({ profile: { ...t!.profile, starterMenu: { ...starter, reviewed: true } } }).where(eq(tenants.id, tenantId));
}
