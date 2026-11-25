import { businessHours, deliveryZones, loadMenu, restaurantSettings, tenants, users, withTenant } from "@empleado/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getOnboarding, operatorPrepareDemo, saveRestaurantSettings } from "../src";
import { dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

let dbs: Dbs;
const worlds: World[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

async function operator() {
  const op = await makeWorld(dbs.owner);
  worlds.push(op);
  await dbs.owner.db.update(users).set({ isOperator: true }).where(eq(users.id, op.ownerId));
  return op;
}

/** Un negocio de restaurante sin nada configurado (ni horario: el mundo de prueba trae uno y se quita). */
async function bareRestaurant(vertical = "taqueria") {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  await dbs.owner.db.update(tenants).set({ vertical, profile: {} }).where(eq(tenants.id, w.tenantId));
  await dbs.owner.db.delete(businessHours).where(eq(businessHours.tenantId, w.tenantId));
  return w;
}

describe("preparar demostracion (operador)", () => {
  it("deja el restaurante listo: menu de ejemplo, horario, zonas y pedidos/reservaciones encendidos", async () => {
    const op = await operator();
    const w = await bareRestaurant();
    const r = await operatorPrepareDemo(dbs.app.db, op.ownerId, w.tenantId);
    expect(r).toEqual({ ok: true, menu: true, hours: true, zones: 3, settings: true });

    const menu = await withTenant(dbs.app.db, { tenantId: w.tenantId }, (tx) => loadMenu(tx));
    expect(menu.categories.map((c) => c.name)).toEqual(["Tacos", "Especialidades", "Bebidas"]);
    const hours = await dbs.owner.db.select().from(businessHours).where(and(eq(businessHours.tenantId, w.tenantId), isNull(businessHours.staffId)));
    expect(hours).toHaveLength(7);
    expect(hours.every((h) => h.opens.startsWith("13:00") && h.closes.startsWith("23:00"))).toBe(true);
    const zones = await dbs.owner.db.select().from(deliveryZones).where(eq(deliveryZones.tenantId, w.tenantId));
    expect(zones.map((z) => [z.name, z.feeCents, z.minOrderCents]).sort()).toEqual([["Centro", 3000, 0], ["Norte", 4500, 15000], ["Sur", 4500, 15000]]);
    const [s] = await dbs.owner.db.select().from(restaurantSettings).where(eq(restaurantSettings.tenantId, w.tenantId));
    expect(s).toMatchObject({ deliveryEnabled: true, reservationsEnabled: true, reservationsCapacity: 30, freeDeliveryFromCents: 30000 });
  });

  it("es idempotente: la segunda vez no cambia nada", async () => {
    const op = await operator();
    const w = await bareRestaurant("pizzeria");
    await operatorPrepareDemo(dbs.app.db, op.ownerId, w.tenantId);
    expect(await operatorPrepareDemo(dbs.app.db, op.ownerId, w.tenantId)).toEqual({ ok: true, menu: false, hours: false, zones: 0, settings: false });
    expect(await dbs.owner.db.select().from(businessHours).where(eq(businessHours.tenantId, w.tenantId))).toHaveLength(7);
    expect(await dbs.owner.db.select().from(deliveryZones).where(eq(deliveryZones.tenantId, w.tenantId))).toHaveLength(3);
  });

  it("nunca pisa lo que el negocio ya configuro", async () => {
    const op = await operator();
    const w = await bareRestaurant();
    // El dueno ya tiene su horario, sus ajustes (sin domicilio ni reservaciones) y una zona propia.
    await dbs.owner.db.insert(businessHours).values({ tenantId: w.tenantId, weekday: 1, opens: "09:00", closes: "15:00" });
    await dbs.owner.db.insert(deliveryZones).values({ tenantId: w.tenantId, name: "Mi colonia", feeCents: 2000 });
    const ctx = { tenantId: w.tenantId, userId: w.ownerId, role: "owner" as const };
    expect(await saveRestaurantSettings(dbs.app.db, ctx, { prepMinutes: 35, paymentMethods: ["efectivo"] })).toMatchObject({ ok: true });

    const r = await operatorPrepareDemo(dbs.app.db, op.ownerId, w.tenantId);
    expect(r).toEqual({ ok: true, menu: true, hours: false, zones: 0, settings: false });
    const [s] = await dbs.owner.db.select().from(restaurantSettings).where(eq(restaurantSettings.tenantId, w.tenantId));
    expect(s).toMatchObject({ prepMinutes: 35, deliveryEnabled: false, reservationsEnabled: false });
    expect((await dbs.owner.db.select().from(businessHours).where(eq(businessHours.tenantId, w.tenantId))).map((h) => h.opens)).toEqual(["09:00:00"]);
    expect((await dbs.owner.db.select().from(deliveryZones).where(eq(deliveryZones.tenantId, w.tenantId))).map((z) => z.name)).toEqual(["Mi colonia"]);
  });

  it("solo el operador, y solo para negocios de restaurante que existen", async () => {
    const op = await operator();
    const w = await bareRestaurant();
    expect(await operatorPrepareDemo(dbs.app.db, w.ownerId, w.tenantId)).toEqual({ ok: false, error: "forbidden" }); // el dueno del negocio no es operador
    expect(await operatorPrepareDemo(dbs.app.db, op.ownerId, "00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, error: "not_found" });
    const dental = await makeWorld(dbs.owner);
    worlds.push(dental);
    expect(await operatorPrepareDemo(dbs.app.db, op.ownerId, dental.tenantId)).toEqual({ ok: false, error: "module_off" });
    expect(await dbs.owner.db.select().from(deliveryZones).where(eq(deliveryZones.tenantId, dental.tenantId))).toHaveLength(0);
  });

  it("despues de preparar, Primeros pasos queda casi completo (falta lo que es del dueno)", async () => {
    const op = await operator();
    const w = await bareRestaurant();
    await operatorPrepareDemo(dbs.app.db, op.ownerId, w.tenantId);
    const v = await getOnboarding(dbs.app.db, { tenantId: w.tenantId, userId: w.ownerId, role: "owner" });
    const done = (id: string) => v.steps.find((s) => s.id === id)!.done;
    expect(done("hours")).toBe(true);
    expect(done("menu")).toBe(true);
    expect(done("delivery")).toBe(true);
    expect(done("reservations")).toBe(true);
    expect(done("business")).toBe(false);
  });
});
