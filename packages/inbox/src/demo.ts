import { auditLog, businessHours, deliveryZones, isOperator, restaurantSettings, tenants, withTenant, type Database } from "@empleado/db";
import { hasModule, modulesFor } from "@empleado/shared";
import { eq, isNull, sql } from "drizzle-orm";
import { applyStarterMenu } from "./starter";
import { fail, type Failure, type Success } from "./types";

/**
 * «Preparar demostración» (solo operador): deja un negocio de restaurante listo para ensenarlo a un prospecto, llenando SOLO lo
 * que falta (nunca pisa lo que el negocio ya configuro): menu de ejemplo, horario general, zonas de entrega con envio, pedidos
 * y reservaciones. Es idempotente: correrlo dos veces no cambia nada la segunda vez.
 */

export type DemoResult = {
  menu: boolean;
  hours: boolean;
  zones: number;
  settings: boolean;
};

/** Horario de demostracion: todos los dias de 13:00 a 23:00. */
const DEMO_HOURS = { opens: "13:00", closes: "23:00" };
const DEMO_ZONES = [
  { name: "Centro", feeCents: 3000, minOrderCents: 0 },
  { name: "Norte", feeCents: 4500, minOrderCents: 15000 },
  { name: "Sur", feeCents: 4500, minOrderCents: 15000 },
];

export async function operatorPrepareDemo(db: Database, userId: string, tenantId: string): Promise<Success<DemoResult> | Failure<"forbidden" | "not_found" | "module_off">> {
  if (!(await isOperator(db, userId))) return fail("forbidden");

  const info = await withTenant(db, { tenantId }, async (tx) => {
    const [t] = await tx.select({ vertical: tenants.vertical, profile: tenants.profile }).from(tenants).where(eq(tenants.id, tenantId));
    return t ?? null;
  });
  if (!info) return fail("not_found");
  if (!hasModule(modulesFor(info.vertical, info.profile?.modules), "restaurante")) return fail("module_off");

  const menu = (await applyStarterMenu(db, tenantId, info.vertical)).applied;

  return withTenant(db, { tenantId }, async (tx) => {
    const [h] = await tx.select({ n: sql<number>`count(*)::int` }).from(businessHours).where(isNull(businessHours.staffId));
    const hours = Number(h?.n ?? 0) === 0;
    if (hours) await tx.insert(businessHours).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ tenantId, weekday, ...DEMO_HOURS })));

    const [z] = await tx.select({ n: sql<number>`count(*)::int` }).from(deliveryZones);
    const zones = Number(z?.n ?? 0) === 0 ? DEMO_ZONES.length : 0;
    if (zones > 0) await tx.insert(deliveryZones).values(DEMO_ZONES.map((zone, i) => ({ tenantId, ...zone, sortOrder: i })));

    // Ajustes de pedidos: solo si el negocio todavia no los guardo (y ahi se encienden domicilio y reservaciones).
    const inserted = await tx
      .insert(restaurantSettings)
      .values({ tenantId, deliveryEnabled: true, deliveryMinutes: 40, freeDeliveryFromCents: 30000, reservationsEnabled: true, reservationsCapacity: 30 })
      .onConflictDoNothing()
      .returning({ id: restaurantSettings.id });
    const settings = inserted.length > 0;

    if (menu || hours || zones > 0 || settings) {
      await tx.insert(auditLog).values({ tenantId, userId, action: "operator.demo_prepared", entity: "tenant", entityId: tenantId, diff: { menu, hours, zones, settings } as never });
    }
    return { ok: true as const, menu, hours, zones, settings };
  });
}
