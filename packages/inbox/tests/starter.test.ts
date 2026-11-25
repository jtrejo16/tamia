import { loadTurnContext, runTool } from "@empleado/agent";
import { agentConfigs, auditLog, businessHours, channels, deliveryZones, loadMenu, menuCategories, menuItems, notificationSettings, restaurantSettings, tenants, users, withTenant } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modulesFor } from "@empleado/shared";
import { applyStarterMenu, getOnboarding, importMenuCsv, saveCategory, saveRestaurantSettings, saveItem, signup, type PanelContext } from "../src";
import { operatorChangeVertical } from "../src";
import { NOW, dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

let dbs: Dbs;
const tenantIds: string[] = [];
const userIds: string[] = [];
const worlds: World[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const id of tenantIds) await dbs.owner.db.delete(tenants).where(eq(tenants.id, id));
  for (const id of userIds) await dbs.owner.db.delete(users).where(eq(users.id, id));
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

const unique = () => Math.random().toString(36).slice(2, 10);
const PASS = "Una-contraseña-larga-2027";

async function register(vertical: string): Promise<{ ctx: PanelContext; tenantId: string }> {
  const res = await signup(dbs.app.db, { businessName: `Prueba ${vertical}`, vertical, ownerName: "Ana Pérez", email: `st-${unique()}@test.local`, password: PASS });
  if (!res.ok) throw new Error(`signup fallo: ${JSON.stringify(res)}`);
  tenantIds.push(res.tenantId);
  userIds.push(res.userId);
  return { ctx: { tenantId: res.tenantId, userId: res.userId, role: "owner" }, tenantId: res.tenantId };
}

const menuOf = (tenantId: string) => withTenant(dbs.app.db, { tenantId }, (tx) => loadMenu(tx));
const profileOf = async (tenantId: string) => (await dbs.owner.db.select().from(tenants).where(eq(tenants.id, tenantId)))[0]!.profile;

describe("alta de un giro de restaurante", () => {
  it("una taqueria nace con el modulo de restaurante, su pack y un menu de ejemplo completo", async () => {
    const { tenantId } = await register("taqueria");
    const [tenant] = await dbs.owner.db.select().from(tenants).where(eq(tenants.id, tenantId));
    const [config] = await dbs.owner.db.select().from(agentConfigs).where(eq(agentConfigs.tenantId, tenantId));
    expect(tenant).toMatchObject({ vertical: "taqueria", status: "pending" });
    expect(config).toMatchObject({ packSlug: "taqueria" });
    expect(modulesFor(tenant!.vertical, tenant!.profile.modules)).toEqual(["restaurante"]);

    const menu = await menuOf(tenantId);
    expect(menu.categories.map((c) => c.name)).toEqual(["Tacos", "Especialidades", "Bebidas"]);
    const pastor = menu.categories[0]!.items.find((i) => i.name === "Taco al pastor")!;
    expect(pastor).toMatchObject({ priceCents: 2200, available: true });
    // Sus modificadores quedaron pegados y con precio: tortilla (harina +$3) y extras (hasta 3).
    const groups = pastor.groupIds.map((id) => menu.groups.find((g) => g.id === id)!);
    expect(groups.map((g) => g.name)).toEqual(["Tortilla", "Extras"]);
    expect(groups[0]!.options.map((o) => [o.name, o.priceDeltaCents])).toEqual([["Maíz", 0], ["Harina", 300]]);
    expect(groups[1]).toMatchObject({ multiple: true, maxChoices: 3 });
    // La bebida tiene tamaño obligatorio.
    const horchata = menu.categories[2]!.items.find((i) => i.name === "Agua de horchata")!;
    expect(menu.groups.find((g) => g.id === horchata.groupIds[0])).toMatchObject({ name: "Tamaño de la bebida", required: true });
    expect((await profileOf(tenantId)).starterMenu).toEqual({ template: "taqueria", reviewed: false });
  });

  it("una pizzeria y un restaurante traen su propio menu; los demas giros no traen nada", async () => {
    const pizza = await register("pizzeria");
    const menu = await menuOf(pizza.tenantId);
    expect(menu.categories.map((c) => c.name)).toEqual(["Pizzas", "Complementos", "Bebidas", "Postres"]);
    const hawaiana = menu.categories[0]!.items.find((i) => i.name === "Hawaiana")!;
    const size = menu.groups.find((g) => g.id === hawaiana.groupIds[0])!;
    expect(size).toMatchObject({ name: "Tamaño", required: true });
    expect(size.options.map((o) => o.priceDeltaCents)).toEqual([0, 4000, 8000, 13000]);

    const rest = await register("restaurante");
    expect((await menuOf(rest.tenantId)).categories.map((c) => c.name)).toEqual(["Entradas", "Platos fuertes", "Bebidas", "Postres"]);

    const dental = await register("dental");
    expect((await menuOf(dental.tenantId)).categories).toEqual([]);
    expect((await profileOf(dental.tenantId)).starterMenu).toBeUndefined();
    expect(await applyStarterMenu(dbs.app.db, dental.tenantId, "dental")).toEqual({ applied: false, reason: "no_template" });
  });

  it("el asistente ya contesta con ese menu y toma un pedido desde el primer minuto", async () => {
    const { tenantId } = await register("taqueria");
    // El alta no crea conversaciones: se usa un mundo de prueba al que se le pasa el menu de la taqueria.
    const w = await makeWorld(dbs.owner);
    worlds.push(w);
    await dbs.owner.db.update(tenants).set({ vertical: "taqueria", profile: {} }).where(eq(tenants.id, w.tenantId));
    expect(await applyStarterMenu(dbs.app.db, w.tenantId, "taqueria")).toMatchObject({ applied: true });
    const ctx = await loadTurnContext(dbs.app.db, w.tenantId, w.conversationId, { now: NOW });
    const r = (await runTool("consultar_menu", JSON.stringify({ busqueda: "pastor" }), ctx)).result as Record<string, any>;
    expect(r.resultados[0]).toMatchObject({ nombre: "Taco al pastor", precio: "$22 MXN" });
    expect(tenantId).not.toBe(w.tenantId);
  });
});

describe("aplicar el menu de ejemplo", () => {
  it("no pisa un menu que ya existe y solo se carga una vez", async () => {
    const { tenantId, ctx } = await register("taqueria");
    expect(await applyStarterMenu(dbs.app.db, tenantId, "taqueria")).toEqual({ applied: false, reason: "menu_not_empty" });
    expect((await menuOf(tenantId)).categories).toHaveLength(3);
    expect(ctx.tenantId).toBe(tenantId);

    const empty = await register("dental");
    expect(await applyStarterMenu(dbs.app.db, empty.tenantId, "pizzeria")).toMatchObject({ applied: true });
    expect(await applyStarterMenu(dbs.app.db, empty.tenantId, "pizzeria")).toEqual({ applied: false, reason: "menu_not_empty" });
    const cats = await dbs.owner.db.select().from(menuCategories).where(eq(menuCategories.tenantId, empty.tenantId));
    expect(cats).toHaveLength(4);
  });

  it("aislamiento: cada negocio tiene su propia copia", async () => {
    const a = await register("taqueria");
    const b = await register("taqueria");
    await dbs.owner.db.update(menuItems).set({ priceCents: 1 }).where(eq(menuItems.tenantId, a.tenantId));
    const itemsB = (await menuOf(b.tenantId)).categories.flatMap((c) => c.items);
    expect(itemsB.every((i) => i.priceCents > 1)).toBe(true);
  });

  it("el operador que cambia el giro a restaurante le carga el menu si no tiene; si ya tenia, no", async () => {
    const op = await makeWorld(dbs.owner);
    const client = await makeWorld(dbs.owner);
    worlds.push(op, client);
    await dbs.owner.db.update(users).set({ isOperator: true }).where(eq(users.id, op.ownerId));
    const r = await operatorChangeVertical(dbs.app.db, op.ownerId, client.tenantId, "pizzeria");
    expect(r).toMatchObject({ ok: true, previous: "dental", changed: true, starterApplied: true });
    expect((await menuOf(client.tenantId)).categories).toHaveLength(4);
    // Cambiarlo otra vez a otro giro de restaurante no pisa el menu.
    expect(await operatorChangeVertical(dbs.app.db, op.ownerId, client.tenantId, "taqueria")).toMatchObject({ ok: true, starterApplied: false });
    expect((await menuOf(client.tenantId)).categories).toHaveLength(4);
    // Un giro sin menu de ejemplo no carga nada.
    const other = await makeWorld(dbs.owner);
    worlds.push(other);
    expect(await operatorChangeVertical(dbs.app.db, op.ownerId, other.tenantId, "belleza")).toMatchObject({ ok: true, starterApplied: false });
    const [log] = await dbs.owner.db.select().from(auditLog).where(eq(auditLog.action, "menu.starter")).limit(1);
    expect(log).toBeDefined();
  });
});

describe("primeros pasos (lista de arranque)", () => {
  const step = (v: Awaited<ReturnType<typeof getOnboarding>>, id: string) => v.steps.find((s) => s.id === id);

  it("una taqueria recien creada: menu cargado, falta revisarlo y lo demas; el avance sube al completar cada paso", async () => {
    const { ctx, tenantId } = await register("taqueria");
    let v = await getOnboarding(dbs.app.db, ctx);
    expect(v.steps.map((s) => s.id)).toEqual(["business", "hours", "channel", "alerts", "menu", "menu_reviewed", "orders", "delivery", "reservations"]);
    expect(v.steps.map((s) => s.id)).not.toContain("services"); // sin modulo de citas
    expect(step(v, "menu")!.done).toBe(true);
    expect(step(v, "menu_reviewed")!.done).toBe(false);
    expect(step(v, "delivery")!.optional).toBe(true);
    expect(step(v, "reservations")!.optional).toBe(true);
    expect(v).toMatchObject({ doneCount: 1, total: 7, percent: 14, starterMenu: { template: "taqueria", reviewed: false } });

    // Revisar el menu (cambiar cualquier cosa) lo marca como revisado.
    const items = (await menuOf(tenantId)).categories[0]!.items;
    expect(await saveItem(dbs.app.db, ctx, { id: items[0]!.id, categoryId: items[0]!.categoryId, name: items[0]!.name, price: 25 })).toMatchObject({ ok: true });
    v = await getOnboarding(dbs.app.db, ctx);
    expect(step(v, "menu_reviewed")!.done).toBe(true);
    expect((await profileOf(tenantId)).starterMenu).toEqual({ template: "taqueria", reviewed: true });

    // Perfil, horario, canal, avisos y ajustes de pedidos.
    await dbs.owner.db.update(tenants).set({ profile: { ...(await profileOf(tenantId)), description: "Taquería de barrio", address: "Calle 60 #1" } }).where(eq(tenants.id, tenantId));
    await dbs.owner.db.insert(businessHours).values({ tenantId, weekday: 1, opens: "13:00", closes: "23:00" });
    await dbs.owner.db.insert(channels).values({ tenantId, type: "whatsapp", externalId: `st-${unique()}` });
    await dbs.owner.db.insert(notificationSettings).values({ tenantId, enabled: true, recipients: [{ id: "r1", kind: "email", address: "a@b.test", enabled: true }] });
    expect(await saveRestaurantSettings(dbs.app.db, ctx, { prepMinutes: 25, paymentMethods: ["efectivo"] })).toMatchObject({ ok: true });
    v = await getOnboarding(dbs.app.db, ctx);
    expect(v).toMatchObject({ doneCount: 7, total: 7, percent: 100 });
    expect(step(v, "delivery")!.done).toBe(false); // opcional: no cuenta
  });

  it("el domicilio opcional se marca al activarlo con una zona, sin cambiar el porcentaje", async () => {
    const { ctx, tenantId } = await register("pizzeria");
    const before = await getOnboarding(dbs.app.db, ctx);
    expect(await saveRestaurantSettings(dbs.app.db, ctx, { prepMinutes: 25, paymentMethods: ["efectivo"], deliveryEnabled: true, zones: [{ name: "Centro", feePesos: 30 }] })).toMatchObject({ ok: true });
    const after = await getOnboarding(dbs.app.db, ctx);
    expect(after.steps.find((s) => s.id === "delivery")!.done).toBe(true);
    expect(after.total).toBe(before.total);
    expect(await dbs.owner.db.select().from(deliveryZones).where(eq(deliveryZones.tenantId, tenantId))).toHaveLength(1);
    expect(await dbs.owner.db.select().from(restaurantSettings).where(eq(restaurantSettings.tenantId, tenantId))).toHaveLength(1);
  });

  it("un negocio de citas ve servicios y equipo, y nada de restaurante", async () => {
    const { ctx } = await register("dental");
    const v = await getOnboarding(dbs.app.db, ctx);
    expect(v.steps.map((s) => s.id)).toEqual(["business", "hours", "channel", "alerts", "services", "staff"]);
    expect(v).toMatchObject({ doneCount: 0, total: 6, percent: 0, starterMenu: null });
  });

  it("importar un CSV o agregar una categoria tambien cuenta como revisar el menu; un negocio sin ejemplo no tiene ese paso", async () => {
    const { ctx, tenantId } = await register("restaurante");
    expect(await saveCategory(dbs.app.db, ctx, { name: "Menú del día" })).toMatchObject({ ok: true });
    expect((await profileOf(tenantId)).starterMenu?.reviewed).toBe(true);

    const second = await register("taqueria");
    const dry = await importMenuCsv(dbs.app.db, second.ctx, "categoria,nombre,precio\nTacos,Taco nuevo,30", { dryRun: true });
    expect(dry).toMatchObject({ ok: true });
    expect((await profileOf(second.tenantId)).starterMenu?.reviewed).toBe(false); // la prueba no cambia nada
    expect(await importMenuCsv(dbs.app.db, second.ctx, "categoria,nombre,precio\nTacos,Taco nuevo,30")).toMatchObject({ ok: true });
    expect((await profileOf(second.tenantId)).starterMenu?.reviewed).toBe(true);
  });
});
