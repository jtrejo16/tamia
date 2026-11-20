import { ensureConversation } from "@empleado/agent";
import { appointments, auditLog, channels, contacts, conversations } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCustomer, getCustomer, listAppointmentsToClose, listCustomers, segmentOf, updateCustomer } from "../src";
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

async function world() {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  return w;
}

/** Un cliente nuevo del negocio, con las citas indicadas (dias antes de NOW; negativo = futuro). */
async function customer(w: World, name: string, phone: string | null, appts: Array<{ days: number; status: "pending" | "confirmed" | "cancelled" | "no_show" | "done" }> = []) {
  const [c] = await dbs.owner.db.insert(contacts).values({ tenantId: w.tenantId, displayName: name, phoneE164: phone }).returning();
  for (const a of appts) {
    const startsAt = ago(a.days);
    await dbs.owner.db.insert(appointments).values({
      tenantId: w.tenantId,
      contactId: c!.id,
      serviceId: w.serviceId,
      staffId: w.staffId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 45 * 60_000),
      status: a.status,
    });
  }
  return c!;
}

describe("segmentos", () => {
  const f = (over: Partial<Parameters<typeof segmentOf>[0]>) => ({ visits: 0, upcoming: 0, unclosed: 0, lastVisit: null, ...over });
  it("clasifica por visitas y por dias sin venir; con cita proxima nunca es en riesgo", () => {
    expect(segmentOf(f({}), NOW)).toBe("prospecto");
    expect(segmentOf(f({ upcoming: 1 }), NOW)).toBe("nuevo");
    expect(segmentOf(f({ unclosed: 1 }), NOW)).toBe("nuevo");
    expect(segmentOf(f({ visits: 1, lastVisit: ago(5) }), NOW)).toBe("nuevo");
    expect(segmentOf(f({ visits: 2, lastVisit: ago(5) }), NOW)).toBe("recurrente");
    expect(segmentOf(f({ visits: 3, lastVisit: ago(61) }), NOW)).toBe("en_riesgo");
    expect(segmentOf(f({ visits: 1, lastVisit: ago(121) }), NOW)).toBe("perdido");
    expect(segmentOf(f({ visits: 3, lastVisit: ago(200), upcoming: 1 }), NOW)).toBe("recurrente");
  });
});

describe("lista de clientes", () => {
  it("calcula segmentos, cifras de la cabecera y filtros; ignora los contactos del probador", async () => {
    const w = await world();
    // El de la prueba (Carlos) trae una conversacion de WhatsApp, sin citas: prospecto.
    const recurrent = await customer(w, "Ana Recurrente", "+529990000001", [{ days: 90, status: "done" }, { days: 10, status: "done" }]);
    const risk = await customer(w, "Beto En Riesgo", "+529990000002", [{ days: 80, status: "done" }]);
    const lost = await customer(w, "Carla Perdida", "+529990000003", [{ days: 200, status: "done" }]);
    const fails = await customer(w, "Diego Faltista", "+529990000004", [{ days: 30, status: "no_show" }, { days: 20, status: "no_show" }, { days: 15, status: "done" }]);
    const open = await customer(w, "Elena Por Cerrar", "+529990000005", [{ days: 3, status: "confirmed" }]);
    const future = await customer(w, "Fer Con Cita", "+529990000006", [{ days: -2, status: "confirmed" }]);

    // Un contacto que solo existe en el probador no debe aparecer.
    const [pg] = await dbs.owner.db.insert(channels).values({ tenantId: w.tenantId, type: "playground", externalId: `pg-${w.tenantId}` }).returning();
    const [pc] = await dbs.owner.db.insert(contacts).values({ tenantId: w.tenantId, displayName: "Prueba Probador", phoneE164: "+529990000099" }).returning();
    await dbs.owner.db.insert(conversations).values({ tenantId: w.tenantId, contactId: pc!.id, channelId: pg!.id });

    const all = await listCustomers(dbs.app.db, w.viewer, { now: NOW }); // el rol de solo lectura puede ver
    const by = new Map(all.items.map((c) => [c.id, c]));
    expect(by.has(pc!.id)).toBe(false);
    expect(by.get(recurrent.id)).toMatchObject({ segment: "recurrente", visits: 2, noShows: 0 });
    expect(by.get(risk.id)?.segment).toBe("en_riesgo");
    expect(by.get(lost.id)?.segment).toBe("perdido");
    expect(by.get(fails.id)).toMatchObject({ frequentNoShow: true, noShows: 2, visits: 1 });
    expect(by.get(open.id)).toMatchObject({ segment: "nuevo", unclosed: 1 });
    expect(by.get(future.id)).toMatchObject({ segment: "nuevo" });
    expect(by.get(future.id)?.nextAppointmentAt).toBeInstanceOf(Date);
    expect(by.get(w.contactId)).toMatchObject({ segment: "prospecto", channels: ["whatsapp"] });

    // 7 clientes: Carlos + 6. Vinieron al menos una vez: recurrente, riesgo, perdida y faltista (4); volvieron 2+: solo Ana.
    expect(all.summary).toMatchObject({ total: 7, recurring: 1, atRisk: 1, lost: 1, toClose: 1 });
    expect(all.summary.returnRate).toBeCloseTo(1 / 4);
    expect(all.summary.noShowRate).toBeCloseTo(2 / (5 + 2)); // 5 realizadas (2+1+1+1 = 5), 2 inasistencias

    const risky = await listCustomers(dbs.app.db, w.owner, { now: NOW, filter: "en_riesgo" });
    expect(risky.items.map((c) => c.id)).toEqual([risk.id]);
    expect(risky.total).toBe(1);
    expect((await listCustomers(dbs.app.db, w.owner, { now: NOW, filter: "inasistencias" })).items.map((c) => c.id)).toEqual([fails.id]);
    // La cabecera no cambia con el filtro.
    expect(risky.summary.total).toBe(7);
  });

  it("busca por nombre, telefono (con o sin formato) o correo, y pagina", async () => {
    const w = await world();
    const a = await customer(w, "María López", "+529991112233");
    await dbs.owner.db.update(contacts).set({ email: "maria@correo.test" }).where(eq(contacts.id, a.id));
    await customer(w, "Pedro Ruiz", "+529994445566");
    const q = (text: string) => listCustomers(dbs.app.db, w.owner, { now: NOW, q: text }).then((r) => r.items.map((c) => c.id));
    expect(await q("lópez")).toEqual([a.id]);
    expect(await q("999 111 22")).toEqual([a.id]);
    expect(await q("(999) 111-2233")).toEqual([a.id]);
    expect(await q("maria@correo")).toEqual([a.id]);
    expect(await q("no existe")).toEqual([]);
    expect(await q("%")).toEqual([]); // los comodines del buscador se escapan
    const page = await listCustomers(dbs.app.db, w.owner, { now: NOW, limit: 2, offset: 1 });
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(3);
  });

  it("un negocio no ve los clientes de otro", async () => {
    const a = await world();
    const b = await world();
    await customer(a, "Solo de A", "+529990010001");
    const rows = await listCustomers(dbs.app.db, b.owner, { now: NOW });
    expect(rows.items.some((c) => c.name === "Solo de A")).toBe(false);
  });
});

describe("ficha del cliente", () => {
  it("junta historial y estadisticas: visitas, frecuencia, gasto estimado, si volvio, y las citas por cerrar", async () => {
    const w = await world();
    const c = await customer(w, "Ana Recurrente", "+529990000011", [
      { days: 100, status: "done" },
      { days: 40, status: "done" },
      { days: 20, status: "no_show" },
      { days: 15, status: "cancelled" },
      { days: 3, status: "confirmed" }, // ya paso y nadie la cerro
      { days: -5, status: "confirmed" },
    ]);
    const r = await getCustomer(dbs.app.db, w.viewer, c.id, { now: NOW });
    if (!r.ok) throw new Error("no encontrado");
    const x = r.customer;
    expect(x).toMatchObject({ name: "Ana Recurrente", phone: "+529990000011", segment: "recurrente", notes: "", optedOut: false });
    expect(x.stats).toMatchObject({
      visits: 2,
      noShows: 1,
      cancelled: 1,
      upcoming: 1,
      unclosed: 1,
      avgDaysBetweenVisits: 60,
      daysSinceLastVisit: 40,
      estimatedSpendCents: 120000,
      returned: true,
      topService: { name: "Limpieza dental", count: 2 },
      currency: "MXN",
    });
    expect(x.stats.firstVisitAt?.toISOString()).toBe(ago(100).toISOString());
    // Del mas reciente al mas viejo, y la que falta cerrar va marcada.
    expect(x.appointments.map((a) => a.status)).toEqual(["confirmed", "confirmed", "cancelled", "no_show", "done", "done"]);
    expect(x.appointments.filter((a) => a.needsClosing)).toHaveLength(1);
    expect(x.appointments[0]).toMatchObject({ service: "Limpieza dental", staff: "Dra. Ruiz", priceCents: 60000 });
  });

  it("sin citas no inventa cifras, y un id ajeno no existe", async () => {
    const w = await world();
    const other = await world();
    const r = await getCustomer(dbs.app.db, w.owner, w.contactId, { now: NOW });
    if (!r.ok) throw new Error("no encontrado");
    expect(r.customer.stats).toMatchObject({ visits: 0, returned: false, avgDaysBetweenVisits: null, daysSinceLastVisit: null, topService: null, estimatedSpendCents: 0 });
    expect(r.customer.channels).toEqual(["whatsapp"]);
    expect(await getCustomer(dbs.app.db, other.owner, w.contactId, { now: NOW })).toEqual({ ok: false, error: "not_found" });
  });
});

describe("editar cliente", () => {
  it("el equipo edita nombre, correo, etiquetas y notas; el lector no; queda en la bitacora sin los datos", async () => {
    const w = await world();
    const input = { displayName: "  Carlos P. Ramírez ", email: "CARLOS@Correo.Test", tags: ["vip", " vip ", "ortodoncia"], notes: "Prefiere las tardes." };
    expect(await updateCustomer(dbs.app.db, w.viewer, w.contactId, input)).toEqual({ ok: false, error: "forbidden" });
    expect(await updateCustomer(dbs.app.db, w.agent, w.contactId, input)).toEqual({ ok: true });
    const [c] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, w.contactId));
    expect(c).toMatchObject({ displayName: "Carlos P. Ramírez", email: "carlos@correo.test", tags: ["vip", "ortodoncia"], notes: "Prefiere las tardes." });

    const logs = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, "customer.updated")));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0]!.diff)).toContain("correo");
    expect(JSON.stringify(logs[0]!.diff)).not.toMatch(/correo\.test|Ramírez|tardes/);

    // Sin cambios no escribe nada.
    expect(await updateCustomer(dbs.app.db, w.agent, w.contactId, input)).toEqual({ ok: true });
    expect(await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, "customer.updated")))).toHaveLength(1);

    // Las notas internas nunca van al perfil que lee el asistente.
    expect(JSON.stringify(c!.profile)).not.toContain("tardes");
  });

  it("normaliza el telefono, lo vacia si se pide, y rechaza datos malos", async () => {
    const w = await world();
    expect(await updateCustomer(dbs.app.db, w.agent, w.contactId, { phone: "(999) 123-4567" })).toEqual({ ok: true });
    expect((await dbs.owner.db.select().from(contacts).where(eq(contacts.id, w.contactId)))[0]!.phoneE164).toBe("+529991234567");

    for (const bad of [{ phone: "123" }, { email: "no-es-correo" }, { displayName: "x".repeat(121) }, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }, { notes: "n".repeat(2001) }]) {
      expect(await updateCustomer(dbs.app.db, w.agent, w.contactId, bad)).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(await updateCustomer(dbs.app.db, w.agent, w.contactId, { phone: "" })).toEqual({ ok: true });
    expect((await dbs.owner.db.select().from(contacts).where(eq(contacts.id, w.contactId)))[0]!.phoneE164).toBeNull();
    expect(await updateCustomer(dbs.app.db, w.agent, "00000000-0000-4000-8000-000000000000", { notes: "x" })).toEqual({ ok: false, error: "not_found" });
  });

  it("si el telefono ya es de otro cliente avisa con quien (para unirlos), tambien si esta guardado con el 1 antiguo", async () => {
    const w = await world();
    const other = await customer(w, "Laura Ya Existe", "+5219991234567"); // guardada como la manda WhatsApp
    const r = await updateCustomer(dbs.app.db, w.agent, w.contactId, { phone: "999 123 4567" });
    expect(r).toEqual({ ok: false, error: "phone_taken", otherId: other.id, otherName: "Laura Ya Existe" });
    expect((await dbs.owner.db.select().from(contacts).where(eq(contacts.id, w.contactId)))[0]!.phoneE164).not.toBe("+529991234567");

    // Escribir el MISMO celular de otra forma no es un cambio: se queda el que ya estaba guardado.
    const same = await customer(w, "Mismo Numero", "+5219995550000");
    expect(await updateCustomer(dbs.app.db, w.agent, same.id, { phone: "999 555 0000" })).toEqual({ ok: true });
    expect((await dbs.owner.db.select().from(contacts).where(eq(contacts.id, same.id)))[0]!.phoneE164).toBe("+5219995550000");
  });

  it("marcar «no contactar» y volver a contactar", async () => {
    const w = await world();
    await dbs.owner.db.update(contacts).set({ optInMarketing: true }).where(eq(contacts.id, w.contactId));
    await updateCustomer(dbs.app.db, w.agent, w.contactId, { optedOut: true }, NOW);
    let [c] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, w.contactId));
    expect(c!.optedOutAt?.toISOString()).toBe(NOW.toISOString());
    expect(c!.optInMarketing).toBe(false);
    await updateCustomer(dbs.app.db, w.agent, w.contactId, { optedOut: false });
    [c] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, w.contactId));
    expect(c!.optedOutAt).toBeNull();
  });
});

describe("alta manual", () => {
  it("pide nombre y un medio de contacto; no duplica telefonos", async () => {
    const w = await world();
    expect(await createCustomer(dbs.app.db, w.viewer, { displayName: "X", phone: "999 000 1111" })).toEqual({ ok: false, error: "forbidden" });
    expect(await createCustomer(dbs.app.db, w.agent, { phone: "999 000 1111" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await createCustomer(dbs.app.db, w.agent, { displayName: "Sin medio" })).toMatchObject({ ok: false, error: "invalid" });

    const ok = await createCustomer(dbs.app.db, w.agent, { displayName: "Nueva Clienta", phone: "999 000 1111", email: "nueva@correo.test", tags: ["referida"], notes: "Vino por una amiga" });
    if (!ok.ok) throw new Error("no se creó");
    const [c] = await dbs.owner.db.select().from(contacts).where(eq(contacts.id, ok.id));
    expect(c).toMatchObject({ displayName: "Nueva Clienta", phoneE164: "+529990001111", email: "nueva@correo.test", tags: ["referida"], notes: "Vino por una amiga" });

    expect(await createCustomer(dbs.app.db, w.agent, { displayName: "Repetida", phone: "9990001111" })).toEqual({ ok: false, error: "phone_taken", otherId: ok.id, otherName: "Nueva Clienta" });
    // Solo con correo tambien se puede.
    expect((await createCustomer(dbs.app.db, w.owner, { displayName: "Solo correo", email: "solo@correo.test" })).ok).toBe(true);
  });

  it("si el cliente escribe por WhatsApp, lo reconoce aunque el equipo guardara su numero sin el 1 antiguo", async () => {
    const w = await world();
    const c = await createCustomer(dbs.app.db, w.agent, { displayName: "Reconocida", phone: "999 777 8899" });
    if (!c.ok) throw new Error("no se creó");
    // WhatsApp lo manda como +5219997778899.
    const ref = await ensureConversation(dbs.app.db, { tenantId: w.tenantId, phone: "+5219997778899", profileName: "Recon" });
    expect(ref.contactId).toBe(c.id);
    const count = await dbs.owner.db.select().from(contacts).where(and(eq(contacts.tenantId, w.tenantId), eq(contacts.displayName, "Reconocida")));
    expect(count).toHaveLength(1);
  });
});

describe("citas por cerrar", () => {
  it("lista solo las que ya terminaron y siguen pendientes o confirmadas, la mas reciente primero", async () => {
    const w = await world();
    const a = await customer(w, "Cerrar Uno", "+529990020001", [{ days: 2, status: "confirmed" }]);
    await customer(w, "Cerrar Dos", "+529990020002", [{ days: 9, status: "pending" }]);
    await customer(w, "Ya Cerrada", "+529990020003", [{ days: 4, status: "done" }]);
    await customer(w, "Futura", "+529990020004", [{ days: -3, status: "confirmed" }]);
    await customer(w, "Cancelada", "+529990020005", [{ days: 5, status: "cancelled" }]);
    await customer(w, "Muy vieja", "+529990020006", [{ days: 400, status: "confirmed" }]); // fuera de los ultimos 120 dias

    const rows = await listAppointmentsToClose(dbs.app.db, w.agent, { now: NOW });
    expect(rows.map((r) => r.contact.name)).toEqual(["Cerrar Uno", "Cerrar Dos"]);
    expect(rows[0]!.contact.id).toBe(a.id);
  });
});
