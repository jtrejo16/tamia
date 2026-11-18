import { appointments, auditLog, messages } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bookingCatalog, createManualAppointment, freeSlots, listAppointments, searchBookingContacts, takeControl } from "../src";
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

const noop = async () => {};
const TUESDAY = "2027-03-02"; // el negocio atiende de lunes a viernes, 9:00-19:00 (America/Merida)

async function world() {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  return w;
}

describe("agendar a mano", () => {
  it("el catalogo trae los servicios activos con quien los atiende", async () => {
    const w = await world();
    const c = await bookingCatalog(dbs.app.db, w.agent);
    expect(c.services).toHaveLength(1);
    expect(c.services[0]).toMatchObject({ name: "Limpieza dental", durationMin: 45, staff: [{ id: w.staffId, name: "Dra. Ruiz" }] });
  });

  it("ofrece los horarios libres reales (sin fines de semana) y deja de ofrecer el que se ocupa", async () => {
    const w = await world();
    const day = await freeSlots(dbs.app.db, w.agent, { serviceId: w.serviceId, day: TUESDAY });
    expect(day.ok).toBe(true);
    if (!day.ok) return;
    expect(day.slots.length).toBeGreaterThan(5);
    expect(day.slots.every((s) => s.staffId === w.staffId)).toBe(true);

    const saturday = await freeSlots(dbs.app.db, w.agent, { serviceId: w.serviceId, day: "2027-03-06" });
    expect(saturday).toMatchObject({ ok: true, slots: [] });

    const first = day.slots[0]!;
    const made = await createManualAppointment(dbs.app.db, w.agent, { contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId, startIso: first.startIso }, noop, NOW);
    expect(made.ok).toBe(true);
    const after = await freeSlots(dbs.app.db, w.agent, { serviceId: w.serviceId, day: TUESDAY });
    expect(after.ok && after.slots.some((s) => s.startIso === first.startIso)).toBe(false);
  });

  it("crea la cita confirmada, queda en Citas y en la bitacora, y no deja agendar dos veces el mismo horario", async () => {
    const w = await world();
    const day = await freeSlots(dbs.app.db, w.agent, { serviceId: w.serviceId, day: TUESDAY });
    if (!day.ok) throw new Error("sin horarios");
    const slot = day.slots[3]!;

    const r = await createManualAppointment(dbs.app.db, w.agent, { contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId, startIso: slot.startIso, conversationId: w.conversationId }, noop, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.summary).toMatch(/Limpieza dental.*Dra\. Ruiz/);

    const [row] = await dbs.owner.db.select().from(appointments).where(eq(appointments.id, r.appointmentId));
    expect(row).toMatchObject({ status: "confirmed", contactId: w.contactId, staffId: w.staffId, sourceConversationId: w.conversationId });
    expect(row!.endsAt.getTime() - row!.startsAt.getTime()).toBe(45 * 60_000);

    const listed = await listAppointments(dbs.app.db, w.agent, { from: new Date("2027-03-01T00:00:00Z"), to: new Date("2027-03-10T00:00:00Z"), now: NOW });
    expect(listed.some((a) => a.id === r.appointmentId)).toBe(true);

    const [log] = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.entityId, r.appointmentId), eq(auditLog.action, "appointment.created")));
    expect(log).toMatchObject({ userId: w.agentId });
    expect(log!.diff).toMatchObject({ actor: "panel" });

    // El mismo horario, otra vez: no se deja.
    const again = await createManualAppointment(dbs.app.db, w.agent, { contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId, startIso: slot.startIso }, noop, NOW);
    expect(again).toEqual({ ok: false, error: "horario_no_disponible" });
  });

  it("rechaza horarios fuera de agenda, roles de solo lectura y datos de otro negocio", async () => {
    const w = await world();
    const other = await world();
    const day = await freeSlots(dbs.app.db, w.agent, { serviceId: w.serviceId, day: TUESDAY });
    if (!day.ok) throw new Error("sin horarios");
    const ok = day.slots[0]!.startIso;

    // Domingo / fuera de horario: no esta libre.
    expect(await createManualAppointment(dbs.app.db, w.agent, { contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId, startIso: "2027-03-07T16:00:00Z" }, noop, NOW)).toEqual({ ok: false, error: "horario_no_disponible" });
    // Lector: sin permiso.
    expect(await createManualAppointment(dbs.app.db, w.viewer, { contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId, startIso: ok }, noop, NOW)).toEqual({ ok: false, error: "forbidden" });
    expect(await freeSlots(dbs.app.db, w.viewer, { serviceId: w.serviceId, day: TUESDAY })).toEqual({ ok: false, error: "forbidden" });
    // Cliente de otro negocio.
    expect(await createManualAppointment(dbs.app.db, w.agent, { contactId: other.contactId, serviceId: w.serviceId, staffId: w.staffId, startIso: ok }, noop, NOW)).toEqual({ ok: false, error: "contacto_no_encontrado" });
    // Servicio de otro negocio.
    expect(await freeSlots(dbs.app.db, w.agent, { serviceId: other.serviceId, day: TUESDAY })).toEqual({ ok: false, error: "servicio_no_encontrado" });
    // Fecha invalida.
    expect(await freeSlots(dbs.app.db, w.agent, { serviceId: w.serviceId, day: "no-es-fecha" })).toEqual({ ok: false, error: "fecha_invalida" });
  });

  it("puede avisarle al cliente en la conversacion, solo si quien agenda tiene el control", async () => {
    const w = await world();
    const day = await freeSlots(dbs.app.db, w.agent, { serviceId: w.serviceId, day: TUESDAY });
    if (!day.ok) throw new Error("sin horarios");
    const queued: string[] = [];
    const enqueue = async (j: { messageId: string }) => void queued.push(j.messageId);

    // Sin tener el control de la conversacion: la cita se crea, el aviso no.
    const a = await createManualAppointment(dbs.app.db, w.agent, { contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId, startIso: day.slots[0]!.startIso, conversationId: w.conversationId, notify: true }, enqueue, NOW);
    expect(a).toMatchObject({ ok: true, notified: "not_in_control" });
    expect(queued).toHaveLength(0);

    // Con el control: se manda el resumen.
    await takeControl(dbs.app.db, w.agent, w.conversationId);
    const b = await createManualAppointment(dbs.app.db, w.agent, { contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId, startIso: day.slots[6]!.startIso, conversationId: w.conversationId, notify: true }, enqueue, NOW);
    expect(b).toMatchObject({ ok: true, notified: true });
    expect(queued).toHaveLength(1);
    const [msg] = await dbs.owner.db.select().from(messages).where(eq(messages.id, queued[0]!));
    expect(msg).toMatchObject({ direction: "out", sender: "human", status: "queued" });
    expect(msg!.body).toContain("quedó agendada");
  });

  it("busca clientes por nombre, apodo o telefono, solo del propio negocio", async () => {
    const w = await world();
    const other = await world();
    expect((await searchBookingContacts(dbs.app.db, w.agent, "Carlos")).map((c) => c.id)).toContain(w.contactId);
    expect((await searchBookingContacts(dbs.app.db, w.agent, "carlitos")).map((c) => c.id)).toContain(w.contactId);
    const [phone] = await dbs.owner.db.query.contacts.findMany({ where: (t, { eq: e }) => e(t.id, w.contactId) });
    expect((await searchBookingContacts(dbs.app.db, w.agent, phone!.phoneE164!.slice(-7))).map((c) => c.id)).toContain(w.contactId);
    expect((await searchBookingContacts(dbs.app.db, w.agent, "Carlos")).some((c) => c.id === other.contactId)).toBe(false);
    expect(await searchBookingContacts(dbs.app.db, w.agent, "c")).toEqual([]);
  });
});
