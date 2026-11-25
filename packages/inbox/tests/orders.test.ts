import { conversations, messages, orderItemModifiers, orderItems, orders, tenants, withTenant } from "@empleado/db";
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

async function newOrder(w: World, number = 1) {
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
      totalCents: 5700,
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
