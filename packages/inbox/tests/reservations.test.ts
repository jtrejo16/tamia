import { contacts, conversations, messages, reservations, restaurantSettings, tenants, withTenant } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countUpcomingReservationsToday, createManualReservation, getReservationSettings, listReservations, saveReservationSettings, setReservationStatus } from "../src";
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

/** NOW = lunes 1-mar-2027 12:00 en Merida (UTC-6). */
const TUESDAY = "2027-03-02";
const noop = async () => {};
const queued = () => {
  const jobs: string[] = [];
  return { jobs, enqueue: async (j: { messageId: string }) => void jobs.push(j.messageId) };
};
const ok = <T>(r: T): Extract<T, { ok: true }> => {
  expect(r).toMatchObject({ ok: true });
  return r as Extract<T, { ok: true }>;
};

async function restaurant(withModule = true, settings: Partial<typeof restaurantSettings.$inferInsert> | null = { reservationsEnabled: true, reservationsCapacity: 20 }) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  if (withModule) await dbs.owner.db.update(tenants).set({ profile: { cancellationNoticeHours: 12, modules: ["restaurante"] } }).where(eq(tenants.id, w.tenantId));
  if (settings) await dbs.owner.db.insert(restaurantSettings).values({ tenantId: w.tenantId, ...settings });
  return w;
}

/** Una reservacion directa en la base (como si ya existiera). */
async function seedRes(w: World, over: Partial<typeof reservations.$inferInsert> & { startsAt: Date }) {
  const [r] = await dbs.owner.db
    .insert(reservations)
    .values({ tenantId: w.tenantId, number: 1, contactId: w.contactId, conversationId: w.conversationId, channel: "whatsapp", customerName: "Laura", customerPhone: "+529991234567", partySize: 4, endsAt: new Date(over.startsAt.getTime() + 90 * 60_000), ...over })
    .returning();
  return r!;
}
const at = (iso: string) => new Date(iso);

describe("agenda del dia", () => {
  it("lista las reservaciones de un dia en orden, con comensales, pico y aforo", async () => {
    const w = await restaurant();
    // Martes 13:00 (19:00Z) para 6 y 13:30 para 8 (se traslapan), y una cancelada que no cuenta.
    await seedRes(w, { number: 1, startsAt: at("2027-03-02T19:00:00Z"), partySize: 6 });
    await seedRes(w, { number: 2, startsAt: at("2027-03-02T19:30:00Z"), partySize: 8, customerName: "Carlos" });
    await seedRes(w, { number: 3, startsAt: at("2027-03-02T21:00:00Z"), partySize: 5, status: "cancelled" });
    await seedRes(w, { number: 4, startsAt: at("2027-03-03T19:00:00Z"), partySize: 2 }); // otro dia
    const r = ok(await listReservations(dbs.app.db, w.viewer, { date: TUESDAY, now: NOW }));
    expect(r).toMatchObject({ date: TUESDAY, covers: 14, count: 2, peak: 14, capacity: 20, enabled: true });
    expect(r.reservations.map((x) => [x.number, x.status, x.partySize])).toEqual([[1, "confirmed", 6], [2, "confirmed", 8], [3, "cancelled", 5]]);
    expect(ok(await listReservations(dbs.app.db, w.viewer, { now: NOW })).reservations).toHaveLength(0); // hoy (lunes): nada
    expect(await listReservations(dbs.app.db, w.viewer, { date: "no-es-fecha", now: NOW })).toEqual({ ok: false, error: "invalid" });
  });

  it("un negocio sin el modulo no tiene reservaciones", async () => {
    const w = await restaurant(false);
    expect(await listReservations(dbs.app.db, w.owner, { now: NOW })).toEqual({ ok: false, error: "module_off" });
    expect(await getReservationSettings(dbs.app.db, w.owner)).toEqual({ ok: false, error: "module_off" });
    expect(await createManualReservation(dbs.app.db, w.owner, {}, NOW)).toMatchObject({ ok: false });
  });

  it("la insignia cuenta las confirmadas de hoy que aun no llegan", async () => {
    const w = await restaurant();
    await seedRes(w, { number: 1, startsAt: at("2027-03-01T21:00:00Z") }); // hoy 15:00
    await seedRes(w, { number: 2, startsAt: at("2027-03-02T21:00:00Z") }); // manana
    await seedRes(w, { number: 3, startsAt: at("2027-03-01T23:00:00Z"), status: "seated" });
    expect(await countUpcomingReservationsToday(dbs.app.db, w.viewer, NOW)).toBe(1);
  });

  it("aislamiento: no ve las de otro negocio", async () => {
    const a = await restaurant();
    const b = await restaurant();
    await seedRes(a, { startsAt: at("2027-03-02T19:00:00Z") });
    expect(ok(await listReservations(dbs.app.db, b.owner, { date: TUESDAY, now: NOW })).reservations).toHaveLength(0);
    expect(await setReservationStatus(dbs.app.db, b.owner, (await dbs.owner.db.select().from(reservations).where(eq(reservations.tenantId, a.tenantId)))[0]!.id, "seated", {}, noop, NOW)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("estados de una reservacion", () => {
  it("confirmada → sentada → completada; el lector no cambia nada", async () => {
    const w = await restaurant();
    const r = await seedRes(w, { startsAt: at("2027-03-02T19:00:00Z") });
    expect(await setReservationStatus(dbs.app.db, w.viewer, r.id, "seated", {}, noop, NOW)).toEqual({ ok: false, error: "forbidden" });
    ok(await setReservationStatus(dbs.app.db, w.agent, r.id, "seated", {}, noop, NOW));
    expect(await setReservationStatus(dbs.app.db, w.owner, r.id, "cancelled", {}, noop, NOW)).toEqual({ ok: false, error: "invalid_transition" }); // ya sentada
    ok(await setReservationStatus(dbs.app.db, w.owner, r.id, "completed", {}, noop, NOW));
    expect(await setReservationStatus(dbs.app.db, w.owner, r.id, "seated", {}, noop, NOW)).toEqual({ ok: false, error: "invalid_transition" });
    const [row] = await dbs.owner.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(row).toMatchObject({ status: "completed" });
    expect(row!.seatedAt).not.toBeNull();
  });

  it("«no llegó» solo despues de su hora", async () => {
    const w = await restaurant();
    const later = await seedRes(w, { number: 1, startsAt: at("2027-03-02T19:00:00Z") });
    expect(await setReservationStatus(dbs.app.db, w.owner, later.id, "no_show", {}, noop, NOW)).toEqual({ ok: false, error: "invalid_transition" });
    ok(await setReservationStatus(dbs.app.db, w.owner, later.id, "no_show", {}, noop, at("2027-03-02T20:30:00Z")));
  });

  it("cancelar guarda el motivo y le avisa al cliente por su conversacion", async () => {
    const w = await restaurant();
    const r = await seedRes(w, { startsAt: at("2027-03-02T19:00:00Z"), partySize: 4 });
    await dbs.owner.db.update(conversations).set({ lastInboundAt: NOW }).where(eq(conversations.id, w.conversationId));
    const q = queued();
    expect(ok(await setReservationStatus(dbs.app.db, w.owner, r.id, "cancelled", { reason: "Evento privado" }, q.enqueue, NOW)).notice).toBe("sent");
    const [m] = await withTenant(dbs.app.db, { tenantId: w.tenantId }, (tx) => tx.select().from(messages).where(eq(messages.id, q.jobs[0]!)));
    expect(m!.body).toContain("#1");
    expect(m!.body).toContain("4 personas");
    expect(m!.body).toContain("martes 2 de marzo a las 13:00");
    expect(m!.body).toContain("Evento privado");
    const [row] = await dbs.owner.db.select().from(reservations).where(eq(reservations.id, r.id));
    expect(row).toMatchObject({ status: "cancelled", cancelledBy: "equipo", cancelReason: "Evento privado" });
  });

  it("con la ventana de WhatsApp cerrada, el cambio se guarda y se avisa que no se pudo notificar", async () => {
    const w = await restaurant();
    const r = await seedRes(w, { startsAt: at("2027-03-02T19:00:00Z") });
    await dbs.owner.db.update(conversations).set({ lastInboundAt: new Date(NOW.getTime() - 40 * 3_600_000) }).where(eq(conversations.id, w.conversationId));
    const q = queued();
    expect(ok(await setReservationStatus(dbs.app.db, w.owner, r.id, "cancelled", {}, q.enqueue, NOW)).notice).toBe("window_closed");
    expect(q.jobs).toHaveLength(0);
  });
});

describe("reservacion manual", () => {
  const input = (over: Record<string, unknown> = {}) => ({ name: "Don Pepe", phone: "999 111 2233", date: TUESDAY, time: "20:00", partySize: 6, notes: "ventana", ...over });

  it("da de alta al cliente por su telefono y reserva; el mismo telefono despues usa al mismo cliente", async () => {
    const w = await restaurant();
    const a = ok(await createManualReservation(dbs.app.db, w.agent, input(), NOW));
    expect(a).toMatchObject({ overbooked: false, reservation: { number: 1, status: "confirmed", partySize: 6, channel: "panel", createdBy: "panel", customerName: "Don Pepe", customerPhone: "+529991112233", notes: "ventana" } });
    expect(a.reservation.startsAt).toBe("2027-03-03T02:00:00.000Z"); // 20:00 en Merida
    expect(a.reservation.endsAt).toBe("2027-03-03T03:30:00.000Z");
    const b = ok(await createManualReservation(dbs.app.db, w.agent, input({ time: "13:00" }), NOW));
    expect(b.reservation.number).toBe(2);
    const people = await dbs.owner.db.select().from(contacts).where(eq(contacts.phoneE164, "+529991112233"));
    expect(people).toHaveLength(1);
  });

  it("respeta el aforo; con «ignorar aforo» reserva y lo avisa", async () => {
    const w = await restaurant(true, { reservationsEnabled: true, reservationsCapacity: 10 });
    ok(await createManualReservation(dbs.app.db, w.owner, input({ partySize: 8 }), NOW));
    expect(await createManualReservation(dbs.app.db, w.owner, input({ phone: "999 222 3344", name: "Otra", partySize: 5 }), NOW)).toEqual({ ok: false, error: "sin_cupo" });
    const forced = ok(await createManualReservation(dbs.app.db, w.owner, input({ phone: "999 222 3344", name: "Otra", partySize: 5, ignoreCapacity: true }), NOW));
    expect(forced.overbooked).toBe(true);
    expect(ok(await listReservations(dbs.app.db, w.owner, { date: TUESDAY, now: NOW })).peak).toBe(13);
  });

  it("valida los datos y los permisos", async () => {
    const w = await restaurant();
    const bad = async (over: Record<string, unknown>) => expect(await createManualReservation(dbs.app.db, w.owner, input(over), NOW)).toMatchObject({ ok: false, error: "invalid" });
    await bad({ name: "" });
    await bad({ partySize: 0 });
    await bad({ partySize: 500 });
    await bad({ date: "2027-02-30" });
    await bad({ time: "25:00" });
    await bad({ phone: "123" });
    await bad({ date: "2027-02-20" }); // ya paso
    expect(await createManualReservation(dbs.app.db, w.viewer, input(), NOW)).toEqual({ ok: false, error: "forbidden" });
    expect(await dbs.owner.db.select().from(reservations).where(eq(reservations.tenantId, w.tenantId))).toHaveLength(0);
  });
});

describe("ajustes de reservaciones", () => {
  const good = { enabled: true, capacity: 50, stayMinutes: 120, slotMinutes: 30, maxParty: 12, minNoticeMinutes: 90, maxDaysAhead: 45, lastSeatingMinutes: 45 };

  it("valen los de por defecto hasta que se guardan; se guardan sin tocar los de pedidos", async () => {
    const w = await restaurant(true, null);
    const first = ok(await getReservationSettings(dbs.app.db, w.owner));
    expect(first.settings).toMatchObject({ reservationsEnabled: false, reservationsCapacity: 40, reservationsStayMinutes: 90 });
    expect(first.hoursConfigured).toBe(true); // el mundo de prueba ya trae horario
    await dbs.owner.db.insert(restaurantSettings).values({ tenantId: w.tenantId, prepMinutes: 35, paymentMethods: ["efectivo"] }).onConflictDoNothing();
    const saved = ok(await saveReservationSettings(dbs.app.db, w.agent, good));
    expect(saved.settings).toMatchObject({ reservationsEnabled: true, reservationsCapacity: 50, reservationsStayMinutes: 120, reservationsMaxParty: 12, reservationsMinNoticeMinutes: 90, reservationsMaxDaysAhead: 45, reservationsLastSeatingMinutes: 45 });
    const [row] = await dbs.owner.db.select().from(restaurantSettings).where(eq(restaurantSettings.tenantId, w.tenantId));
    expect(row).toMatchObject({ prepMinutes: 35, paymentMethods: ["efectivo"] });
  });

  it("valida cada limite; el lector no cambia nada", async () => {
    const w = await restaurant();
    const bad = async (over: Record<string, unknown>) => expect(await saveReservationSettings(dbs.app.db, w.owner, { ...good, ...over })).toMatchObject({ ok: false, error: "invalid" });
    await bad({ capacity: 0 });
    await bad({ capacity: "abc" });
    await bad({ stayMinutes: 10 });
    await bad({ slotMinutes: 20 });
    await bad({ maxParty: 80 }); // mayor al aforo de 50
    await bad({ minNoticeMinutes: -1 });
    await bad({ maxDaysAhead: 0 });
    expect(await saveReservationSettings(dbs.app.db, w.viewer, good)).toEqual({ ok: false, error: "forbidden" });
    expect(ok(await getReservationSettings(dbs.app.db, w.owner)).settings.reservationsCapacity).toBe(20);
  });
});
