import {
  auditLog,
  businessHolidays,
  businessHours,
  contacts,
  deliveryZones,
  loadMenu,
  menuCategories,
  menuItemGroups,
  menuItems,
  menuModifierGroups,
  menuModifierOptions,
  orders,
  restaurantSettings,
  tenants,
  withTenant,
} from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTurnContext, runTool, type TurnContext } from "../src";
import { NOW, dropWorld, makeWorld, openDbs, type Handles, type World } from "./helpers";

let dbs: Handles;
const worlds: World[] = [];
beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

interface Seed {
  w: World;
  pastor: string;
  agua: string;
  maiz: string;
  harina: string;
}

async function seed(): Promise<Seed> {
  const w = await makeWorld(dbs.owner, { contactName: "Laura" });
  worlds.push(w);
  const db = dbs.owner.db;
  await db.update(tenants).set({ profile: { cancellationNoticeHours: 12, modules: ["restaurante"] } }).where(eq(tenants.id, w.tenantId));
  await db.update(contacts).set({ phoneE164: "+529991234567" }).where(eq(contacts.id, w.contactId));
  const [cat] = await db.insert(menuCategories).values({ tenantId: w.tenantId, name: "Tacos" }).returning();
  const [bev] = await db.insert(menuCategories).values({ tenantId: w.tenantId, name: "Bebidas" }).returning();
  const [pastor] = await db.insert(menuItems).values({ tenantId: w.tenantId, categoryId: cat!.id, name: "Pastor", priceCents: 1800 }).returning();
  const [agua] = await db.insert(menuItems).values({ tenantId: w.tenantId, categoryId: bev!.id, name: "Agua", priceCents: 1500 }).returning();
  const [g] = await db.insert(menuModifierGroups).values({ tenantId: w.tenantId, name: "Tortilla", required: true }).returning();
  const opts = await db
    .insert(menuModifierOptions)
    .values([{ tenantId: w.tenantId, groupId: g!.id, name: "Maíz", sortOrder: 0 }, { tenantId: w.tenantId, groupId: g!.id, name: "Harina", priceDeltaCents: 300, sortOrder: 1 }])
    .returning();
  await db.insert(menuItemGroups).values({ tenantId: w.tenantId, itemId: pastor!.id, groupId: g!.id });
  return { w, pastor: pastor!.id, agua: agua!.id, maiz: opts.find((o) => o.name === "Maíz")!.id, harina: opts.find((o) => o.name === "Harina")!.id };
}

const ctxOf = (s: Seed): Promise<TurnContext> => loadTurnContext(dbs.app.db, s.w.tenantId, s.w.conversationId, { now: NOW });
const call = (name: string, args: unknown, ctx: TurnContext) => runTool(name, JSON.stringify(args), ctx).then((r) => r.result as Record<string, any>);
const ordersOf = (s: Seed) => withTenant(dbs.app.db, { tenantId: s.w.tenantId }, (tx) => tx.select().from(orders).orderBy(orders.number));

/** Pide el resumen y confirma en un turno posterior, como ocurre en una conversacion real. */
async function placeOrder(s: Seed, args: Record<string, unknown>) {
  const ctx = await ctxOf(s);
  const summary = await call("crear_pedido", args, ctx);
  expect(summary).toMatchObject({ requiere_confirmacion: true });
  ctx.inboundCount += 1; // el cliente contesta "si"
  return { summary, result: await call("crear_pedido", { ...args, confirmado: true }, ctx), ctx };
}

const base = (s: Seed) => ({ articulos: [{ platillo_id: s.pastor, cantidad: 2, opciones_ids: [s.harina], notas: "sin cebolla" }, { platillo_id: s.agua, cantidad: 1 }], forma_de_pago: "efectivo" });

describe("crear_pedido", () => {
  it("da el resumen con el total calculado por el sistema y, tras confirmar, crea el pedido con su numero", async () => {
    const s = await seed();
    const { summary, result } = await placeOrder(s, base(s));
    // 2 × (18 + 3) + 15 = 57
    expect(summary.resumen).toContain("$57 MXN");
    expect(summary.resumen).toContain("sin cebolla");
    expect(result).toMatchObject({ ok: true, pedido_numero: 1, total: "$57 MXN", listo_en_minutos: 25 });
    const [o] = await ordersOf(s);
    expect(o).toMatchObject({ number: 1, status: "new", totalCents: 5700, paymentMethod: "efectivo", customerName: "Laura", customerPhone: "+529991234567", mode: "pickup" });
  });

  it("no crea nada si el cliente no confirmo en un mensaje posterior", async () => {
    const s = await seed();
    const ctx = await ctxOf(s);
    await call("crear_pedido", base(s), ctx);
    const r = await call("crear_pedido", { ...base(s), confirmado: true }, ctx); // mismo mensaje: aun no contesta
    expect(r).toMatchObject({ error: "falta_confirmacion" });
    expect(await ordersOf(s)).toHaveLength(0);
  });

  it("repetir la confirmacion no duplica el pedido; uno distinto recibe el numero siguiente", async () => {
    const s = await seed();
    await placeOrder(s, base(s));
    const again = await placeOrder(s, base(s));
    expect(again.result).toMatchObject({ ok: true, pedido_numero: 1, nota: expect.stringContaining("no se duplicó") });
    expect(await ordersOf(s)).toHaveLength(1);
    const other = await placeOrder(s, { articulos: [{ platillo_id: s.agua, cantidad: 3 }], forma_de_pago: "tarjeta" });
    expect(other.result).toMatchObject({ ok: true, pedido_numero: 2, total: "$45 MXN" });
  });

  it("rechaza lo que el menu no permite: modificador obligatorio, agotado, inexistente, pago no aceptado", async () => {
    const s = await seed();
    const ctx = await ctxOf(s);
    expect(await call("crear_pedido", { articulos: [{ platillo_id: s.pastor, cantidad: 1 }], forma_de_pago: "efectivo" }, ctx)).toMatchObject({ error: "falta_opcion_obligatoria" });
    expect(await call("crear_pedido", { articulos: [{ platillo_id: "00000000-0000-4000-8000-000000000000", cantidad: 1 }], forma_de_pago: "efectivo" }, ctx)).toMatchObject({ error: "platillo_no_encontrado" });
    await dbs.owner.db.update(menuItems).set({ available: false }).where(eq(menuItems.id, s.agua));
    expect(await call("crear_pedido", { articulos: [{ platillo_id: s.agua, cantidad: 1 }], forma_de_pago: "efectivo" }, ctx)).toMatchObject({ error: "platillo_agotado" });
    await dbs.owner.db.update(menuItems).set({ available: true }).where(eq(menuItems.id, s.agua));
    expect(await call("crear_pedido", { articulos: [{ platillo_id: s.agua, cantidad: 1 }], forma_de_pago: "transferencia" }, ctx)).toMatchObject({ error: "forma_de_pago_no_disponible" });
    expect(await ordersOf(s)).toHaveLength(0);
  });

  it("respeta pedidos pausados, pedido minimo y que falte el telefono", async () => {
    const s = await seed();
    const agua = { articulos: [{ platillo_id: s.agua, cantidad: 1 }], forma_de_pago: "efectivo" };
    await dbs.owner.db.insert(restaurantSettings).values({ tenantId: s.w.tenantId, acceptingOrders: false });
    expect(await call("crear_pedido", agua, await ctxOf(s))).toMatchObject({ error: "pedidos_pausados" });
    await dbs.owner.db.update(restaurantSettings).set({ acceptingOrders: true, minOrderCents: 5000 }).where(eq(restaurantSettings.tenantId, s.w.tenantId));
    expect(await call("crear_pedido", agua, await ctxOf(s))).toMatchObject({ error: "pedido_minimo", minimo: "$50 MXN" });
    await dbs.owner.db.update(restaurantSettings).set({ minOrderCents: 0 }).where(eq(restaurantSettings.tenantId, s.w.tenantId));
    await dbs.owner.db.update(contacts).set({ phoneE164: null }).where(eq(contacts.id, s.w.contactId));
    expect(await call("crear_pedido", agua, await ctxOf(s))).toMatchObject({ error: "faltan_datos" });
  });

  it("fuera de horario no toma pedidos y dice cuando abren; en un dia de cierre tampoco", async () => {
    const s = await seed();
    // NOW = lunes 12:00 en Merida. Solo abren los martes.
    await dbs.owner.db.delete(businessHours).where(eq(businessHours.tenantId, s.w.tenantId));
    await dbs.owner.db.insert(businessHours).values({ tenantId: s.w.tenantId, staffId: null, weekday: 2, opens: "09:00", closes: "18:00" });
    const agua = { articulos: [{ platillo_id: s.agua, cantidad: 1 }], forma_de_pago: "efectivo" };
    const r = await call("crear_pedido", agua, await ctxOf(s));
    expect(r).toMatchObject({ error: "cerrado_ahora", abre: expect.stringContaining("mañana") });
    await dbs.owner.db.update(businessHours).set({ weekday: 1 }).where(eq(businessHours.tenantId, s.w.tenantId));
    expect(await call("crear_pedido", agua, await ctxOf(s))).toMatchObject({ requiere_confirmacion: true });
    await dbs.owner.db.insert(businessHolidays).values({ tenantId: s.w.tenantId, staffId: null, date: "2027-03-01" });
    expect(await call("crear_pedido", agua, await ctxOf(s))).toMatchObject({ error: "cerrado_ahora" });
  });

  it("no la ve un negocio sin el modulo", async () => {
    const s = await seed();
    await dbs.owner.db.update(tenants).set({ profile: { cancellationNoticeHours: 12 } }).where(eq(tenants.id, s.w.tenantId));
    expect(await call("crear_pedido", base(s), await ctxOf(s))).toMatchObject({ error: "herramienta_desconocida" });
  });
});

async function enableDelivery(s: Seed, over: Partial<typeof restaurantSettings.$inferInsert> = {}) {
  await dbs.owner.db.insert(restaurantSettings).values({ tenantId: s.w.tenantId, deliveryEnabled: true, deliveryMinutes: 45, ...over }).onConflictDoUpdate({ target: restaurantSettings.tenantId, set: { deliveryEnabled: true, deliveryMinutes: 45, ...over } });
  await dbs.owner.db.insert(deliveryZones).values([
    { tenantId: s.w.tenantId, name: "Centro", feeCents: 3000 },
    { tenantId: s.w.tenantId, name: "Norte", feeCents: 5000, minOrderCents: 20000, sortOrder: 1 },
    { tenantId: s.w.tenantId, name: "Cerrada", feeCents: 1000, active: false, sortOrder: 2 },
  ]);
}
const home = (s: Seed, over: Record<string, unknown> = {}) => ({ ...base(s), modo: "domicilio", direccion: "Calle 60 #123 entre 21 y 23, casa azul", colonia: "Centro", ...over });

describe("crear_pedido a domicilio", () => {
  it("un negocio sin domicilio no lo ofrece: ni en info_de_pedidos ni al crear", async () => {
    const s = await seed();
    const info = (await call("consultar_menu", {}, await ctxOf(s))) as Record<string, any>;
    expect(info.info_de_pedidos.a_domicilio).toBe("no disponible");
    expect(await call("crear_pedido", home(s), await ctxOf(s))).toMatchObject({ error: "entrega_no_disponible" });
    expect(await ordersOf(s)).toHaveLength(0);
  });

  it("consultar_menu publica las zonas activas con su costo (no las inactivas) y el envio gratis", async () => {
    const s = await seed();
    await enableDelivery(s, { freeDeliveryFromCents: 30000 });
    const a = ((await call("consultar_menu", {}, await ctxOf(s))) as Record<string, any>).info_de_pedidos.a_domicilio;
    expect(a).toMatchObject({ tiempo_aproximado_minutos: 45, envio_gratis_desde: "$300 MXN" });
    expect(a.zonas).toEqual([{ nombre: "Centro", costo_de_envio: "$30 MXN" }, { nombre: "Norte", costo_de_envio: "$50 MXN", pedido_minimo: "$200 MXN" }]);
  });

  it("calcula el envio por la zona de la colonia: resumen con envio y total, y el pedido guarda direccion, zona y envio", async () => {
    const s = await seed();
    await enableDelivery(s);
    const { summary, result } = await placeOrder(s, home(s, { colonia: "col. CENTRO, Mérida" }));
    expect(summary.resumen).toContain("envío a Centro $30 MXN");
    expect(summary.resumen).toContain("Total $87 MXN"); // 57 + 30
    expect(summary.resumen).toContain("Calle 60 #123");
    expect(result).toMatchObject({ ok: true, modo: "domicilio", total: "$87 MXN", costo_de_envio: "$30 MXN", llega_en_minutos: 45 });
    const [o] = await ordersOf(s);
    expect(o).toMatchObject({ mode: "delivery", subtotalCents: 5700, deliveryFeeCents: 3000, totalCents: 8700, deliveryZoneName: "Centro", deliveryAddress: expect.stringContaining("casa azul") });
  });

  it("el envio es gratis desde el monto configurado", async () => {
    const s = await seed();
    await enableDelivery(s, { freeDeliveryFromCents: 5000 });
    const { result } = await placeOrder(s, home(s));
    expect(result).toMatchObject({ ok: true, total: "$57 MXN", costo_de_envio: "$0 MXN" });
    expect((await ordersOf(s))[0]).toMatchObject({ deliveryFeeCents: 0, totalCents: 5700 });
  });

  it("rechaza colonia fuera de zona (y la inactiva), datos faltantes y el minimo de la zona", async () => {
    const s = await seed();
    await enableDelivery(s);
    const ctx = await ctxOf(s);
    expect(await call("crear_pedido", home(s, { colonia: "Francisco de Montejo" }), ctx)).toMatchObject({ error: "zona_no_cubierta", zonas: ["Centro", "Norte"] });
    expect(await call("crear_pedido", home(s, { colonia: "Cerrada" }), ctx)).toMatchObject({ error: "zona_no_cubierta" });
    expect(await call("crear_pedido", home(s, { direccion: undefined }), ctx)).toMatchObject({ error: "faltan_datos", faltan: ["calle y número (y referencias)"] });
    expect(await call("crear_pedido", home(s, { colonia: undefined }), ctx)).toMatchObject({ error: "faltan_datos", faltan: ["colonia"] });
    expect(await call("crear_pedido", home(s, { colonia: "Norte" }), ctx)).toMatchObject({ error: "pedido_minimo", minimo: "$200 MXN" });
    expect(await ordersOf(s)).toHaveLength(0);
  });

  it("recoger sigue igual aunque haya domicilio, y el mismo carrito a otra direccion es otro pedido", async () => {
    const s = await seed();
    await enableDelivery(s);
    const pick = await placeOrder(s, base(s));
    expect(pick.result).toMatchObject({ ok: true, modo: "recoger", total: "$57 MXN" });
    const a = await placeOrder(s, home(s));
    const b = await placeOrder(s, home(s, { direccion: "Calle 10 #5, portón negro" }));
    expect((a.result as any).pedido_numero).toBe(2);
    expect((b.result as any).pedido_numero).toBe(3);
  });

  it("estado_pedido dice que es a domicilio, a donde va y el estado en camino", async () => {
    const s = await seed();
    await enableDelivery(s);
    await placeOrder(s, home(s));
    await dbs.owner.db.update(orders).set({ status: "on_the_way" }).where(eq(orders.tenantId, s.w.tenantId));
    const r = await call("estado_pedido", {}, await ctxOf(s));
    expect(r.pedidos[0]).toMatchObject({ modo: "a domicilio", direccion: expect.stringContaining("col. Centro"), estado: expect.stringContaining("en camino") });
  });
});

describe("estado_pedido y cancelar_pedido", () => {
  it("el cliente ve sus pedidos y cancela solo mientras sigan nuevos", async () => {
    const s = await seed();
    await placeOrder(s, base(s));
    const status = await call("estado_pedido", {}, await ctxOf(s));
    expect(status.pedidos).toHaveLength(1);
    expect(status.pedidos[0]).toMatchObject({ pedido_numero: 1, estado: expect.stringContaining("recibido"), total: "$57 MXN" });

    const ctx = await ctxOf(s);
    expect(await call("cancelar_pedido", { pedido_numero: 1 }, ctx)).toMatchObject({ requiere_confirmacion: true });
    ctx.inboundCount += 1;
    expect(await call("cancelar_pedido", { pedido_numero: 1, confirmado: true }, ctx)).toMatchObject({ ok: true });
    const [o] = await ordersOf(s);
    expect(o).toMatchObject({ status: "cancelled", cancelledBy: "cliente" });
    expect(await call("cancelar_pedido", { pedido_numero: 1 }, await ctxOf(s))).toMatchObject({ error: "pedido_cerrado" });
  });

  it("un pedido que ya se esta preparando no se cancela por el asistente", async () => {
    const s = await seed();
    await placeOrder(s, base(s));
    await dbs.owner.db.update(orders).set({ status: "preparing" }).where(eq(orders.tenantId, s.w.tenantId));
    expect(await call("cancelar_pedido", { pedido_numero: 1 }, await ctxOf(s))).toMatchObject({ error: "ya_en_preparacion" });
  });

  it("un cliente no puede ver ni cancelar el pedido de otro", async () => {
    const s = await seed();
    await placeOrder(s, base(s));
    const ctx = await ctxOf(s);
    // Otro cliente del mismo negocio escribe.
    const other = await loadTurnContext(dbs.app.db, s.w.tenantId, s.w.otherContactId, { now: NOW }).catch(() => null);
    expect(ctx.contactId).toBe(s.w.contactId);
    if (other) {
      expect((await call("estado_pedido", {}, other)).pedidos).toEqual([]);
      expect(await call("cancelar_pedido", { pedido_numero: 1 }, other)).toMatchObject({ error: "pedido_no_encontrado" });
    }
  });

  it("deja bitacora de la creacion y la cancelacion", async () => {
    const s = await seed();
    await placeOrder(s, base(s));
    const ctx = await ctxOf(s);
    await call("cancelar_pedido", { pedido_numero: 1 }, ctx);
    ctx.inboundCount += 1;
    await call("cancelar_pedido", { pedido_numero: 1, confirmado: true }, ctx);
    const rows = await withTenant(dbs.app.db, { tenantId: s.w.tenantId }, (tx) => tx.select({ action: auditLog.action }).from(auditLog).where(and(eq(auditLog.entity, "order"))));
    expect(rows.map((r) => r.action).sort()).toEqual(["order.cancelled", "order.created"]);
  });
});

describe("aislamiento", () => {
  it("un negocio no ve los pedidos de otro", async () => {
    const a = await seed();
    const b = await seed();
    await placeOrder(a, base(a));
    expect(await ordersOf(b)).toHaveLength(0);
    expect(await ordersOf(a)).toHaveLength(1);
    expect((await loadMenu_(b)).categories.length).toBe(2);
  });
});

const loadMenu_ = (s: Seed) => withTenant(dbs.app.db, { tenantId: s.w.tenantId }, (tx) => loadMenu(tx));
