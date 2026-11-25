import { conversations, deliveryZones, messages, orderItemModifiers, orderItems, orders, tenants, withTenant } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countNewOrders, getRestaurantSettings, listOrders, saveRestaurantSettings, setOrderStatus } from "../src";
import { NOW, dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

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

async function restaurant(withModule = true) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  if (withModule) await dbs.owner.db.update(tenants).set({ profile: { cancellationNoticeHours: 12, modules: ["restaurante"] } }).where(eq(tenants.id, w.tenantId));
  return w;
}

async function newOrder(w: World, number = 1, delivery = false) {
  const [o] = await dbs.owner.db
    .insert(orders)
    .values({
      tenantId: w.tenantId,
      number,
      contactId: w.contactId,
      conversationId: w.conversationId,
      channel: "whatsapp",
      customerName: "Laura",
      customerPhone: "+529991234567",
      paymentMethod: "efectivo",
      subtotalCents: 5700,
      totalCents: delivery ? 8700 : 5700,
      ...(delivery ? { mode: "delivery" as const, deliveryFeeCents: 3000, deliveryAddress: "Calle 60 #123", deliveryZoneName: "Centro" } : {}),
    })
    .returning();
  const [line] = await dbs.owner.db.insert(orderItems).values({ tenantId: w.tenantId, orderId: o!.id, name: "Pastor", unitPriceCents: 1800, quantity: 2, lineTotalCents: 4200, notes: "sin cebolla" }).returning();
  await dbs.owner.db.insert(orderItemModifiers).values({ tenantId: w.tenantId, orderItemId: line!.id, groupName: "Tortilla", optionName: "Harina", priceDeltaCents: 300 });
  return o!;
}

const noop = async () => {};
const queued = () => {
  const jobs: string[] = [];
  return { jobs, enqueue: async (j: { messageId: string }) => void jobs.push(j.messageId) };
};
const ok = <T>(r: T): Extract<T, { ok: true }> => {
  expect(r).toMatchObject({ ok: true });
  return r as Extract<T, { ok: true }>;
};

describe("tablero de pedidos", () => {
  it("lista lo activo con sus partidas y modificadores, y cuenta los nuevos", async () => {
    const w = await restaurant();
    await newOrder(w);
    const list = ok(await listOrders(dbs.app.db, w.viewer, "active", NOW));
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]).toMatchObject({ number: 1, status: "new", totalCents: 5700, lines: [{ name: "Pastor", quantity: 2, notes: "sin cebolla", modifiers: [{ groupName: "Tortilla", optionName: "Harina" }] }] });
    expect(await countNewOrders(dbs.app.db, w.viewer)).toBe(1);
    expect(ok(await listOrders(dbs.app.db, w.viewer, "history", NOW)).orders).toHaveLength(0);
  });

  it("un negocio sin el modulo no tiene pedidos", async () => {
    const w = await restaurant(false);
    expect(await listOrders(dbs.app.db, w.owner, "active")).toEqual({ ok: false, error: "module_off" });
    expect(await setOrderStatus(dbs.app.db, w.owner, "00000000-0000-4000-8000-000000000000", "preparing", {}, noop)).toEqual({ ok: false, error: "module_off" });
  });

  it("el lector no cambia estados; la recepcion si", async () => {
    const w = await restaurant();
    const o = await newOrder(w);
    expect(await setOrderStatus(dbs.app.db, w.viewer, o.id, "preparing", {}, noop)).toEqual({ ok: false, error: "forbidden" });
    ok(await setOrderStatus(dbs.app.db, w.agent, o.id, "preparing", {}, noop));
  });

  it("sigue el orden nuevo → preparando → listo → entregado y no regresa", async () => {
    const w = await restaurant();
    const o = await newOrder(w);
    ok(await setOrderStatus(dbs.app.db, w.owner, o.id, "preparing", {}, noop, NOW));
    expect(await setOrderStatus(dbs.app.db, w.owner, o.id, "new" as never, {}, noop)).toEqual({ ok: false, error: "invalid_transition" });
    ok(await setOrderStatus(dbs.app.db, w.owner, o.id, "ready", {}, noop, NOW));
    ok(await setOrderStatus(dbs.app.db, w.owner, o.id, "delivered", {}, noop, NOW));
    expect(await setOrderStatus(dbs.app.db, w.owner, o.id, "cancelled", {}, noop)).toEqual({ ok: false, error: "invalid_transition" });
    const [row] = await dbs.owner.db.select().from(orders).where(eq(orders.id, o.id));
    expect(row).toMatchObject({ status: "delivered" });
    expect(row!.preparingAt).not.toBeNull();
    expect(row!.readyAt).not.toBeNull();
    expect(row!.deliveredAt).not.toBeNull();
    expect(ok(await listOrders(dbs.app.db, w.owner, "history")).orders).toHaveLength(1);
  });

  it("al quedar listo se le escribe al cliente por la misma conversacion", async () => {
    const w = await restaurant();
    const o = await newOrder(w);
    await dbs.owner.db.update(conversations).set({ lastInboundAt: NOW }).where(eq(conversations.id, w.conversationId));
    const q = queued();
    const r = ok(await setOrderStatus(dbs.app.db, w.owner, o.id, "ready", {}, q.enqueue, NOW));
    expect(r.notice).toBe("sent");
    expect(q.jobs).toHaveLength(1);
    const [m] = await withTenant(dbs.app.db, { tenantId: w.tenantId }, (tx) => tx.select().from(messages).where(eq(messages.id, q.jobs[0]!)));
    expect(m).toMatchObject({ direction: "out", status: "queued" });
    expect(m!.body).toContain("#1");
    expect(m!.body).toContain("listo para recoger");
  });

  it("cancelar guarda el motivo, avisa al cliente y deja fuera de la ventana el aviso sin perder el cambio", async () => {
    const w = await restaurant();
    const o = await newOrder(w);
    const q = queued();
    // Sin mensaje del cliente en 24 h: el cambio se guarda, pero no se puede escribir.
    await dbs.owner.db.update(conversations).set({ lastInboundAt: new Date(NOW.getTime() - 30 * 3_600_000) }).where(eq(conversations.id, w.conversationId));
    const r = ok(await setOrderStatus(dbs.app.db, w.owner, o.id, "cancelled", { reason: "Se acabó el pastor" }, q.enqueue, NOW));
    expect(r.notice).toBe("window_closed");
    expect(q.jobs).toHaveLength(0);
    const [row] = await dbs.owner.db.select().from(orders).where(eq(orders.id, o.id));
    expect(row).toMatchObject({ status: "cancelled", cancelledBy: "equipo", cancelReason: "Se acabó el pastor" });
  });

  it("un pedido de otro negocio no existe", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const o = await newOrder(a);
    expect(await setOrderStatus(dbs.app.db, b.owner, o.id, "preparing", {}, noop)).toEqual({ ok: false, error: "not_found" });
    expect(ok(await listOrders(dbs.app.db, b.owner, "active")).orders).toHaveLength(0);
    expect(await countNewOrders(dbs.app.db, b.owner)).toBe(0);
  });
});

describe("ajustes del restaurante", () => {
  it("valen los de por defecto hasta que se guardan; se guardan y se leen", async () => {
    const w = await restaurant();
    expect(ok(await getRestaurantSettings(dbs.app.db, w.owner)).settings).toMatchObject({ acceptingOrders: true, prepMinutes: 25, minOrderCents: 0, paymentMethods: ["efectivo", "tarjeta"] });
    const saved = ok(await saveRestaurantSettings(dbs.app.db, w.agent, { acceptingOrders: false, prepMinutes: 40, minOrderPesos: 80.5, paymentMethods: ["efectivo", "transferencia"], transferInfo: "CLABE 012345678901234567 · Taquería" }));
    expect(saved.settings).toMatchObject({ acceptingOrders: false, prepMinutes: 40, minOrderCents: 8050, paymentMethods: ["efectivo", "transferencia"], transferInfo: expect.stringContaining("CLABE") });
    // Guardar otra vez actualiza (no duplica).
    ok(await saveRestaurantSettings(dbs.app.db, w.owner, { acceptingOrders: true, prepMinutes: 30, minOrderPesos: 0, paymentMethods: ["tarjeta"] }));
    expect(ok(await getRestaurantSettings(dbs.app.db, w.owner)).settings).toMatchObject({ acceptingOrders: true, prepMinutes: 30, paymentMethods: ["tarjeta"], transferInfo: null });
  });

  it("valida tiempo, pagos y datos de transferencia; el lector no cambia nada", async () => {
    const w = await restaurant();
    const good = { prepMinutes: 25, minOrderPesos: 0, paymentMethods: ["efectivo"] };
    expect(await saveRestaurantSettings(dbs.app.db, w.owner, { ...good, prepMinutes: 2 })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveRestaurantSettings(dbs.app.db, w.owner, { ...good, paymentMethods: [] })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveRestaurantSettings(dbs.app.db, w.owner, { ...good, paymentMethods: ["bitcoin"] })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveRestaurantSettings(dbs.app.db, w.owner, { ...good, paymentMethods: ["transferencia"] })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveRestaurantSettings(dbs.app.db, w.viewer, good)).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("pedidos a domicilio en el tablero", () => {
  const sent = async (w: World, id: string, to: "preparing" | "ready" | "on_the_way" | "delivered" | "cancelled") => {
    const q = queued();
    await dbs.owner.db.update(conversations).set({ lastInboundAt: NOW }).where(eq(conversations.id, w.conversationId));
    const r = ok(await setOrderStatus(dbs.app.db, w.owner, id, to, {}, q.enqueue, NOW));
    return { r, q };
  };

  it("lista el domicilio y lo en camino; pasa por listo → en camino → entregado y avisa al salir", async () => {
    const w = await restaurant();
    const o = await newOrder(w, 1, true);
    expect(ok(await listOrders(dbs.app.db, w.viewer, "active", NOW)).orders[0]).toMatchObject({ mode: "delivery", deliveryAddress: "Calle 60 #123", deliveryZoneName: "Centro", deliveryFeeCents: 3000, totalCents: 8700 });
    await sent(w, o.id, "preparing");
    const ready = await sent(w, o.id, "ready");
    expect(ready.r.notice).toBe("not_needed"); // a domicilio no se avisa "listo para recoger"
    expect(ready.q.jobs).toHaveLength(0);
    const way = await sent(w, o.id, "on_the_way");
    expect(way.r.notice).toBe("sent");
    const [m] = await withTenant(dbs.app.db, { tenantId: w.tenantId }, (tx) => tx.select().from(messages).where(eq(messages.id, way.q.jobs[0]!)));
    expect(m!.body).toContain("va en camino");
    expect(m!.body).toContain("$87 MXN");
    expect(ok(await listOrders(dbs.app.db, w.owner, "active", NOW)).orders[0]!.status).toBe("on_the_way");
    await sent(w, o.id, "delivered");
    const [row] = await dbs.owner.db.select().from(orders).where(eq(orders.id, o.id));
    expect(row!.onTheWayAt).not.toBeNull();
    expect(row!.deliveredAt).not.toBeNull();
  });

  it("«en camino» solo existe en domicilio; en un pedido para recoger no es una transicion valida", async () => {
    const w = await restaurant();
    const pick = await newOrder(w, 1, false);
    ok(await setOrderStatus(dbs.app.db, w.owner, pick.id, "ready", {}, noop, NOW));
    expect(await setOrderStatus(dbs.app.db, w.owner, pick.id, "on_the_way", {}, noop)).toEqual({ ok: false, error: "invalid_transition" });
    // Y un pedido en camino no regresa a listo.
    const del = await newOrder(w, 2, true);
    ok(await setOrderStatus(dbs.app.db, w.owner, del.id, "ready", {}, noop, NOW));
    ok(await setOrderStatus(dbs.app.db, w.owner, del.id, "on_the_way", {}, noop, NOW));
    expect(await setOrderStatus(dbs.app.db, w.owner, del.id, "ready", {}, noop)).toEqual({ ok: false, error: "invalid_transition" });
    ok(await setOrderStatus(dbs.app.db, w.owner, del.id, "cancelled", { reason: "No se encontró la dirección" }, noop, NOW));
  });
});

describe("zonas de entrega y ajustes de domicilio", () => {
  const settings = { prepMinutes: 25, minOrderPesos: 0, paymentMethods: ["efectivo"] };
  const zonesOf = (w: World) => withTenant(dbs.app.db, { tenantId: w.tenantId }, (tx) => tx.select().from(deliveryZones).orderBy(deliveryZones.sortOrder));

  it("guarda ajustes y zonas, las lee en orden y actualiza sin duplicar", async () => {
    const w = await restaurant();
    const saved = ok(await saveRestaurantSettings(dbs.app.db, w.agent, { ...settings, deliveryEnabled: true, deliveryMinutes: 50, freeDeliveryFromPesos: "300", zones: [{ name: "Centro", feePesos: "30" }, { name: "Norte", feePesos: 45.5, minOrderPesos: "200", active: false }] }));
    expect(saved.settings).toMatchObject({ deliveryEnabled: true, deliveryMinutes: 50, freeDeliveryFromCents: 30000 });
    expect(saved.zones.map((z) => [z.name, z.feeCents, z.minOrderCents, z.active])).toEqual([["Centro", 3000, 0, true], ["Norte", 4550, 20000, false]]);
    // Reenviar con ids actualiza; la que ya no viene se borra; una nueva se agrega.
    const [c, n] = saved.zones;
    const again = ok(await saveRestaurantSettings(dbs.app.db, w.owner, { ...settings, deliveryEnabled: true, deliveryMinutes: 50, zones: [{ id: c!.id, name: "Centro", feePesos: "35" }, { name: "Sur", feePesos: "40" }] }));
    expect(again.zones.map((z) => [z.name, z.feeCents])).toEqual([["Centro", 3500], ["Sur", 4000]]);
    expect(again.zones[0]!.id).toBe(c!.id);
    expect(again.zones.some((z) => z.id === n!.id)).toBe(false);
    expect(again.settings.freeDeliveryFromCents).toBeNull();
    expect(await zonesOf(w)).toHaveLength(2);
  });

  it("dos zonas pueden intercambiar nombres en un mismo guardado", async () => {
    const w = await restaurant();
    const a = ok(await saveRestaurantSettings(dbs.app.db, w.owner, { ...settings, zones: [{ name: "Centro", feePesos: 20 }, { name: "Norte", feePesos: 40 }] }));
    const [c, n] = a.zones;
    const swapped = ok(await saveRestaurantSettings(dbs.app.db, w.owner, { ...settings, zones: [{ id: c!.id, name: "Norte", feePesos: 20 }, { id: n!.id, name: "Centro", feePesos: 40 }] }));
    expect(swapped.zones.map((z) => [z.name, z.feeCents])).toEqual([["Norte", 2000], ["Centro", 4000]]);
  });

  it("sin zonas activas no se puede ofrecer domicilio; sin mandar zonas no se tocan las que hay", async () => {
    const w = await restaurant();
    expect(await saveRestaurantSettings(dbs.app.db, w.owner, { ...settings, deliveryEnabled: true })).toMatchObject({ ok: false, error: "invalid", details: [expect.stringContaining("al menos una zona")] });
    expect(await saveRestaurantSettings(dbs.app.db, w.owner, { ...settings, deliveryEnabled: true, zones: [{ name: "Centro", feePesos: 10, active: false }] })).toMatchObject({ ok: false, error: "invalid" });
    ok(await saveRestaurantSettings(dbs.app.db, w.owner, { ...settings, zones: [{ name: "Centro", feePesos: 10 }] }));
    ok(await saveRestaurantSettings(dbs.app.db, w.owner, { ...settings, zones: [{ name: "Centro", feePesos: "", minOrderPesos: "" }] })); // montos vacios = 0
    expect((await zonesOf(w))[0]).toMatchObject({ feeCents: 0, minOrderCents: 0 });
    ok(await saveRestaurantSettings(dbs.app.db, w.owner, { ...settings, deliveryEnabled: true })); // sin "zones": se quedan las que ya habia
    expect(await zonesOf(w)).toHaveLength(1);
  });

  it("valida nombres, repetidos, montos y tiempo de entrega; el lector no cambia nada", async () => {
    const w = await restaurant();
    const bad = async (extra: Record<string, unknown>) => expect(await saveRestaurantSettings(dbs.app.db, w.owner, { ...settings, ...extra })).toMatchObject({ ok: false, error: "invalid" });
    await bad({ zones: [{ name: "", feePesos: 10 }] });
    await bad({ zones: [{ name: "Centro", feePesos: 10 }, { name: "CÉNTRO", feePesos: 20 }] });
    await bad({ zones: [{ name: "Centro", feePesos: -5 }] });
    await bad({ zones: [{ name: "Centro", feePesos: 99999 }] });
    await bad({ zones: [{ name: "Centro", feePesos: "abc" }] });
    await bad({ deliveryMinutes: 3 });
    await bad({ freeDeliveryFromPesos: "mucho" });
    expect(await saveRestaurantSettings(dbs.app.db, w.viewer, { ...settings, zones: [] })).toEqual({ ok: false, error: "forbidden" });
    expect(await zonesOf(w)).toHaveLength(0);
  });

  it("las zonas de un negocio no se ven ni se tocan desde otro", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const saved = ok(await saveRestaurantSettings(dbs.app.db, a.owner, { ...settings, zones: [{ name: "Centro", feePesos: 10 }] }));
    expect(ok(await getRestaurantSettings(dbs.app.db, b.owner)).zones).toEqual([]);
    // Un id de otro negocio se trata como zona nueva (no actualiza la ajena).
    ok(await saveRestaurantSettings(dbs.app.db, b.owner, { ...settings, zones: [{ id: saved.zones[0]!.id, name: "Mía", feePesos: 5 }] }));
    expect((await zonesOf(a))[0]).toMatchObject({ name: "Centro", feeCents: 1000 });
    expect((await zonesOf(b))[0]).toMatchObject({ name: "Mía", feeCents: 500 });
  });
});
