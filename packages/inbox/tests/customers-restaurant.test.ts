import { contacts, orderItems, orders, reservations, tenants } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getCustomer, limitsFor, listCustomers, mergeContacts, segmentOf } from "../src";
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

const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

async function restaurant(modules: string[] | null = null) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  await dbs.owner.db.update(tenants).set({ vertical: "taqueria", profile: modules ? { modules } : {} }).where(eq(tenants.id, w.tenantId));
  return w;
}

let seq = 0;
async function person(w: World, name: string) {
  const [c] = await dbs.owner.db.insert(contacts).values({ tenantId: w.tenantId, displayName: name, phoneE164: `+52999${String(7000000 + ++seq)}` }).returning();
  return c!;
}

async function order(w: World, contactId: string, over: { days: number; status?: "new" | "preparing" | "ready" | "on_the_way" | "delivered" | "cancelled"; total?: number; items?: Array<[string, number]>; mode?: "pickup" | "delivery" }) {
  const at = ago(over.days);
  const [o] = await dbs.owner.db
    .insert(orders)
    .values({
      tenantId: w.tenantId,
      number: ++seq + 1000,
      contactId,
      channel: "whatsapp",
      customerName: "X",
      paymentMethod: "efectivo",
      subtotalCents: over.total ?? 5700,
      totalCents: over.total ?? 5700,
      status: over.status ?? "delivered",
      mode: over.mode ?? "pickup",
      createdAt: at,
      updatedAt: at,
      deliveredAt: (over.status ?? "delivered") === "delivered" ? at : null,
    })
    .returning();
  for (const [i, [name, quantity]] of (over.items ?? [["Taco al pastor", 3]]).entries()) {
    await dbs.owner.db.insert(orderItems).values({ tenantId: w.tenantId, orderId: o!.id, name, unitPriceCents: 1900, quantity, lineTotalCents: 1900 * quantity, sortOrder: i });
  }
  return o!;
}

async function reservation(w: World, contactId: string, over: { days: number; status?: "confirmed" | "seated" | "completed" | "cancelled" | "no_show"; party?: number }) {
  const startsAt = ago(over.days);
  const [r] = await dbs.owner.db
    .insert(reservations)
    .values({ tenantId: w.tenantId, number: ++seq + 2000, contactId, channel: "whatsapp", customerName: "X", partySize: over.party ?? 4, startsAt, endsAt: new Date(startsAt.getTime() + 90 * 60_000), status: over.status ?? "completed" })
    .returning();
  return r!;
}

const findRow = async (w: World, id: string) => (await listCustomers(dbs.app.db, w.owner, { now: NOW })).items.find((c) => c.id === id)!;

describe("plazos por tipo de negocio", () => {
  it("un restaurante se enfria antes (30 y 60 dias); con citas o con ambos modulos, lo de siempre (60 y 120)", () => {
    expect(limitsFor(["restaurante"])).toEqual({ risk: 30, lost: 60 });
    expect(limitsFor(["citas"])).toEqual({ risk: 60, lost: 120 });
    expect(limitsFor(["citas", "restaurante"])).toEqual({ risk: 60, lost: 120 });
    const f = { visits: 2, upcoming: 0, unclosed: 0 };
    expect(segmentOf({ ...f, lastVisit: ago(40) }, NOW, limitsFor(["restaurante"]))).toBe("en_riesgo");
    expect(segmentOf({ ...f, lastVisit: ago(70) }, NOW, limitsFor(["restaurante"]))).toBe("perdido");
    expect(segmentOf({ ...f, lastVisit: ago(40) }, NOW)).toBe("recurrente");
  });
});

describe("lista de clientes de un restaurante", () => {
  it("cuenta como visita cada pedido entregado y cada reservacion completada, con lo gastado", async () => {
    const w = await restaurant();
    const c = await person(w, "Laura");
    await order(w, c.id, { days: 3, total: 11200 });
    await order(w, c.id, { days: 10, total: 5000 });
    await order(w, c.id, { days: 8, status: "cancelled", total: 9999 }); // cancelado: no cuenta ni como gasto
    await reservation(w, c.id, { days: 20 });
    const row = await findRow(w, c.id);
    expect(row).toMatchObject({ visits: 3, orders: 2, reservations: 1, spendCents: 16200, cancelled: 1, noShows: 0, segment: "recurrente" });
    expect(row.lastVisitAt).toEqual(ago(3));
  });

  it("las reservaciones que no llegaron cuentan como inasistencia; una pasada sin cerrar queda por cerrar", async () => {
    const w = await restaurant();
    const c = await person(w, "Carlos");
    await reservation(w, c.id, { days: 5, status: "no_show" });
    await reservation(w, c.id, { days: 9, status: "no_show" });
    await reservation(w, c.id, { days: 2, status: "confirmed" }); // ya paso y nadie la cerro
    const row = await findRow(w, c.id);
    expect(row).toMatchObject({ noShows: 2, frequentNoShow: true, unclosed: 1, visits: 0 });
    const summary = (await listCustomers(dbs.app.db, w.owner, { now: NOW })).summary;
    expect(summary.noShowRate).toBe(1);
    expect(summary.toClose).toBe(1);
  });

  it("un pedido en curso o una reservacion proxima lo hacen cliente nuevo; la proxima reservacion se muestra", async () => {
    const w = await restaurant();
    const a = await person(w, "Ana");
    await order(w, a.id, { days: 0, status: "preparing" });
    expect((await findRow(w, a.id)).segment).toBe("nuevo");
    const b = await person(w, "Beto");
    const future = await reservation(w, b.id, { days: -2, status: "confirmed" });
    const row = await findRow(w, b.id);
    expect(row).toMatchObject({ segment: "nuevo", visits: 0 });
    expect(row.nextAppointmentAt).toEqual(future.startsAt);
    // Un pedido "nuevo" olvidado de hace una semana no cuenta como en curso.
    const c = await person(w, "Cris");
    await order(w, c.id, { days: 7, status: "new" });
    expect((await findRow(w, c.id)).segment).toBe("prospecto");
  });

  it("en un restaurante, 45 dias sin venir ya es «en riesgo» y 70 «perdido»; en uno de citas no", async () => {
    const w = await restaurant();
    const risk = await person(w, "Riesgo");
    await order(w, risk.id, { days: 45 });
    await order(w, risk.id, { days: 50 });
    const lost = await person(w, "Perdido");
    await order(w, lost.id, { days: 70 });
    expect((await findRow(w, risk.id)).segment).toBe("en_riesgo");
    expect((await findRow(w, lost.id)).segment).toBe("perdido");

    const dental = await makeWorld(dbs.owner);
    worlds.push(dental);
    const d = await person(dental, "Paciente");
    await order(dental, d.id, { days: 45 }); // (un negocio de citas casi no tendra pedidos; solo se comprueba el plazo)
    await order(dental, d.id, { days: 50 });
    expect((await findRow(dental, d.id)).segment).toBe("recurrente");
  });

  it("aislamiento: no mezcla pedidos ni reservaciones de otro negocio", async () => {
    const a = await restaurant();
    const b = await restaurant();
    const ca = await person(a, "De A");
    await order(a, ca.id, { days: 1 });
    expect((await listCustomers(dbs.app.db, b.owner, { now: NOW })).items.map((c) => c.id)).not.toContain(ca.id);
    expect(await getCustomer(dbs.app.db, b.owner, ca.id, { now: NOW })).toEqual({ ok: false, error: "not_found" });
  });
});

describe("ficha de un cliente de restaurante", () => {
  it("muestra su historial de pedidos y reservaciones, y las estadisticas juntas", async () => {
    const w = await restaurant();
    const c = await person(w, "Laura");
    await order(w, c.id, { days: 2, total: 11200, items: [["Taco al pastor", 3], ["Agua de horchata", 1]], mode: "delivery" });
    await order(w, c.id, { days: 12, total: 5000, items: [["Taco al pastor", 2]] });
    await order(w, c.id, { days: 15, status: "cancelled", total: 3000, items: [["Gringa", 1]] });
    await reservation(w, c.id, { days: 30, party: 6 });
    await reservation(w, c.id, { days: 3, status: "no_show" });
    await reservation(w, c.id, { days: 1, status: "confirmed", party: 2 }); // ya paso: por cerrar

    const r = await getCustomer(dbs.app.db, w.owner, c.id, { now: NOW });
    if (!r.ok) throw new Error("sin ficha");
    const d = r.customer;
    expect(d.orders.map((o) => [o.status, o.totalCents, o.items, o.mode])).toEqual([
      ["delivered", 11200, "3 × Taco al pastor, 1 × Agua de horchata", "delivery"],
      ["delivered", 5000, "2 × Taco al pastor", "pickup"],
      ["cancelled", 3000, "1 × Gringa", "pickup"],
    ]);
    expect(d.reservations.map((x) => [x.status, x.partySize, x.needsClosing])).toEqual([
      ["confirmed", 2, true],
      ["no_show", 4, false],
      ["completed", 6, false],
    ]);
    expect(d.stats).toMatchObject({
      visits: 3, // 2 pedidos entregados + 1 reservacion completada
      orders: 2,
      spendCents: 16200,
      avgTicketCents: 8100,
      reservationsDone: 1,
      noShows: 1,
      cancelled: 1,
      unclosed: 1,
      returned: true,
      topDish: { name: "Taco al pastor", count: 5 },
    });
    expect(d.stats.firstVisitAt).toEqual(ago(30));
    expect(d.stats.lastVisitAt).toEqual(ago(2));
    expect(d.stats.avgDaysBetweenVisits).toBe(14); // de hace 30 a hace 2 dias, tres visitas: 28 / 2
    expect(d.segment).toBe("recurrente");
  });

  it("un cliente nuevo sin nada tiene todo en cero y un negocio de citas sigue sin pedidos", async () => {
    const w = await restaurant();
    const c = await person(w, "Nadie");
    const r = await getCustomer(dbs.app.db, w.owner, c.id, { now: NOW });
    if (!r.ok) throw new Error("sin ficha");
    expect(r.customer).toMatchObject({ orders: [], reservations: [], segment: "prospecto" });
    expect(r.customer.stats).toMatchObject({ visits: 0, orders: 0, spendCents: 0, avgTicketCents: null, topDish: null, reservationsDone: 0 });
  });

  it("al unir dos clientes duplicados, el historial de pedidos y reservaciones queda en uno solo", async () => {
    const w = await restaurant();
    const a = await person(w, "Laura Mendez");
    const b = await person(w, "Laura Méndez");
    await order(w, a.id, { days: 4 });
    await reservation(w, b.id, { days: 6 });
    const merged = await mergeContacts(dbs.app.db, w.owner, { keepId: a.id, mergeId: b.id });
    expect(merged).toMatchObject({ ok: true });
    const r = await getCustomer(dbs.app.db, w.owner, a.id, { now: NOW });
    if (!r.ok) throw new Error("sin ficha");
    expect(r.customer.stats).toMatchObject({ orders: 1, reservationsDone: 1, visits: 2 });
  });
});
