import { agentConfigs, auditLog, businessHolidays, businessHours, knowledgeDocs, services, staffServices, tenants } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addHoliday,
  getConfig,
  removeDoc,
  removeHoliday,
  saveDoc,
  saveService,
  saveStaff,
  setHours,
  setServiceActive,
  updateAgent,
  updateBusiness,
} from "../src";
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

async function world() {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  return w;
}
const audit = (w: World, action: string) =>
  dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, action)));

const business = {
  name: "Clínica Panel Renovada",
  description: "clínica dental familiar",
  address: "Calle 60 #500, Mérida",
  mapsUrl: "https://maps.example/x",
  paymentMethods: ["efectivo", "tarjeta"],
  keyFacts: ["Estacionamiento gratuito"],
  cancellationPolicy: "Avisar con 12 horas de anticipación",
  cancellationNoticeHours: 12,
  depositPolicy: "",
  privacyNoticeUrl: "https://clinica.example/aviso",
  timezone: "America/Merida",
  humanHours: { mon: ["09:00", "18:00"], tue: ["09:00", "18:00"], sun: null },
};

/** Un restaurante (sin el modulo de citas). */
async function restaurantWorld() {
  const w = await world();
  await dbs.owner.db.update(tenants).set({ vertical: "taqueria", profile: {} }).where(eq(tenants.id, w.tenantId));
  return w;
}

describe("horarios que cruzan la medianoche", () => {
  // El horario de una taqueria nocturna: lunes a viernes 17:00 a 01:00, sabado 16:00 a 01:00 y domingo 13:00 a medianoche.
  const night = [
    ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "17:00", closes: "01:00" })),
    { weekday: 6, opens: "16:00", closes: "01:00" },
    { weekday: 0, opens: "13:00", closes: "00:00" },
  ];

  it("un restaurante guarda su horario nocturno tal cual", async () => {
    const w = await restaurantWorld();
    expect(await setHours(dbs.app.db, w.owner, { staffId: null, windows: night })).toEqual({ ok: true });
    const rows = await dbs.owner.db.select().from(businessHours).where(eq(businessHours.tenantId, w.tenantId));
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.weekday === 1)).toMatchObject({ opens: "17:00:00", closes: "01:00:00" });
    expect(rows.find((r) => r.weekday === 0)).toMatchObject({ opens: "13:00:00", closes: "00:00:00" });
  });

  it("un negocio con agenda de citas no puede (la agenda no entiende turnos que cruzan la medianoche) y no pierde su horario", async () => {
    const w = await world();
    expect(await setHours(dbs.app.db, w.owner, { staffId: null, windows: [{ weekday: 2, opens: "09:00", closes: "19:00" }] })).toEqual({ ok: true });
    const r = await setHours(dbs.app.db, w.owner, { staffId: null, windows: night });
    expect(r).toMatchObject({ ok: false, error: "invalid", details: [expect.stringContaining("sin agenda de citas")] });
    expect(await dbs.owner.db.select().from(businessHours).where(eq(businessHours.tenantId, w.tenantId))).toHaveLength(1);
  });

  it("abrir y cerrar a la misma hora sigue siendo invalido, y los empalmes se detectan (tambien con turnos nocturnos)", async () => {
    const w = await restaurantWorld();
    const bad = async (windows: unknown[]) => expect(await setHours(dbs.app.db, w.owner, { staffId: null, windows })).toMatchObject({ ok: false, error: "invalid" });
    await bad([{ weekday: 2, opens: "09:00", closes: "09:00" }]);
    await bad([{ weekday: 2, opens: "09:00", closes: "15:00" }, { weekday: 2, opens: "14:00", closes: "19:00" }]);
    await bad([{ weekday: 2, opens: "18:00", closes: "02:00" }, { weekday: 2, opens: "20:00", closes: "23:00" }]); // el turno nocturno ya ocupa el resto del dia
    expect(await setHours(dbs.app.db, w.owner, { staffId: null, windows: [{ weekday: 2, opens: "09:00", closes: "12:00" }, { weekday: 2, opens: "18:00", closes: "02:00" }] })).toEqual({ ok: true });
  });
});

describe("negocio", () => {
  it("el dueño lo actualiza y el cambio queda en el perfil y en la bitácora", async () => {
    const w = await world();
    expect(await updateBusiness(dbs.app.db, w.owner, business)).toEqual({ ok: true });
    const [t] = await dbs.owner.db.select().from(tenants).where(eq(tenants.id, w.tenantId));
    expect(t).toMatchObject({ name: "Clínica Panel Renovada", privacyNoticeUrl: "https://clinica.example/aviso", timezone: "America/Merida" });
    expect(t!.profile).toMatchObject({ address: "Calle 60 #500, Mérida", paymentMethods: ["efectivo", "tarjeta"], cancellationNoticeHours: 12 });
    expect(t!.profile.depositPolicy).toBeUndefined(); // vacio = no definido
    expect(t!.humanHours).toMatchObject({ mon: ["09:00", "18:00"], sun: null });
    expect(await audit(w, "config.business.updated")).toHaveLength(1);

    const snapshot = await getConfig(dbs.app.db, w.viewer);
    expect(snapshot!.business).toMatchObject({ name: "Clínica Panel Renovada", address: "Calle 60 #500, Mérida", cancellationNoticeHours: 12 });
  });

  it("rechaza datos invalidos con mensajes claros y no cambia nada", async () => {
    const w = await world();
    for (const bad of [
      { ...business, name: "x" },
      { ...business, mapsUrl: "http://sin-https.example" },
      { ...business, privacyNoticeUrl: "no-es-url" },
      { ...business, timezone: "Marte/Olympus" },
      { ...business, cancellationNoticeHours: 500 },
      { ...business, humanHours: { mon: ["9am", "6pm"] } },
      { ...business, paymentMethods: Array(20).fill("x") },
    ]) {
      const r = await updateBusiness(dbs.app.db, w.owner, bad);
      expect(r).toMatchObject({ ok: false, error: "invalid" });
      expect((r as { details: string[] }).details.length).toBeGreaterThan(0);
    }
    const [t] = await dbs.owner.db.select().from(tenants).where(eq(tenants.id, w.tenantId));
    expect(t!.name).toBe("Clínica Panel");
  });

  it("solo el dueño puede configurar: recepción y lectores no", async () => {
    const w = await world();
    for (const ctx of [w.agent, w.viewer]) {
      expect(await updateBusiness(dbs.app.db, ctx, business)).toEqual({ ok: false, error: "forbidden" });
      expect(await saveService(dbs.app.db, ctx, { name: "Intruso", durationMin: 30, bufferMin: 0, price: 1, requiresDeposit: false, active: true, staffIds: [] })).toEqual({ ok: false, error: "forbidden" });
      expect(await setHours(dbs.app.db, ctx, { staffId: null, windows: [] })).toEqual({ ok: false, error: "forbidden" });
      expect(await saveDoc(dbs.app.db, ctx, { title: "x", text: "y" })).toEqual({ ok: false, error: "forbidden" });
    }
    expect((await getConfig(dbs.app.db, w.agent))!.business.name).toBe("Clínica Panel"); // leer si pueden
  });
});

describe("asistente", () => {
  it("el nivel elige el modelo y el respaldo aprobados, y el cambio de autonomia se audita con antes y despues", async () => {
    const w = await world();
    await dbs.owner.db.update(agentConfigs).set({ model: "anthropic/claude-haiku-5.5", autonomy: "copilot" }).where(eq(agentConfigs.tenantId, w.tenantId));
    const input = { assistantName: "Sonri", tone: "cálido y profesional", formality: "usted", autonomy: "auto", tier: "balanceado", escalationRules: ["quejas"], forbiddenTopics: ["diagnósticos"] };
    expect(await updateAgent(dbs.app.db, w.owner, input)).toEqual({ ok: true });

    const [row] = await dbs.owner.db.select().from(agentConfigs).where(eq(agentConfigs.tenantId, w.tenantId));
    expect(row).toMatchObject({ assistantName: "Sonri", autonomy: "auto", model: "anthropic/claude-sonnet-5.5", fallbackModel: "anthropic/claude-haiku-5.5" });
    const [entry] = await audit(w, "config.agent.updated");
    expect(entry!.diff).toMatchObject({ autonomy: { from: "copilot", to: "auto" }, tier: "balanceado" });
    expect((await getConfig(dbs.app.db, w.owner))!.agent).toMatchObject({ tier: "balanceado", autonomy: "auto" });
  });

  it("valida nivel, autonomia y trato", async () => {
    const w = await world();
    const ok = { assistantName: "Sonri", tone: "cálido", formality: "tu", autonomy: "semi", tier: "economico", escalationRules: [], forbiddenTopics: [] };
    for (const bad of [{ ...ok, tier: "gratis" }, { ...ok, autonomy: "total" }, { ...ok, formality: "vos" }, { ...ok, assistantName: "" }]) {
      expect(await updateAgent(dbs.app.db, w.owner, bad)).toMatchObject({ ok: false, error: "invalid" });
    }
    expect(await updateAgent(dbs.app.db, w.agent, ok)).toEqual({ ok: false, error: "forbidden" });
  });
});

describe("servicios y equipo", () => {
  const service = { name: "Blanqueamiento", description: "Aclara hasta 3 tonos", durationMin: 60, bufferMin: 10, price: 2800.5, requiresDeposit: true, active: true, staffIds: [] as string[] };

  it("crea un servicio (pesos -> centavos), lo asigna a un especialista y lo edita", async () => {
    const w = await world();
    const created = await saveService(dbs.app.db, w.owner, { ...service, staffIds: [w.staffId] });
    expect(created).toMatchObject({ ok: true });
    const id = (created as { id: string }).id;

    const [row] = await dbs.owner.db.select().from(services).where(eq(services.id, id));
    expect(row).toMatchObject({ name: "Blanqueamiento", priceCents: 280050, durationMin: 60, requiresDeposit: true });
    expect((await dbs.owner.db.select().from(staffServices).where(eq(staffServices.serviceId, id))).map((l) => l.staffId)).toEqual([w.staffId]);

    expect(await saveService(dbs.app.db, w.owner, { ...service, id, price: null, staffIds: [] })).toMatchObject({ ok: true });
    const [after] = await dbs.owner.db.select().from(services).where(eq(services.id, id));
    expect(after!.priceCents).toBeNull();
    expect(await dbs.owner.db.select().from(staffServices).where(eq(staffServices.serviceId, id))).toHaveLength(0);
    expect((await getConfig(dbs.app.db, w.owner))!.services.find((s) => s.id === id)).toMatchObject({ price: null, staffIds: [] });
  });

  it("valida duraciones, precios y nombres", async () => {
    const w = await world();
    for (const bad of [{ ...service, name: "" }, { ...service, durationMin: 2 }, { ...service, durationMin: 600 }, { ...service, bufferMin: -1 }, { ...service, price: -5 }, { ...service, staffIds: ["no-es-uuid"] }]) {
      expect(await saveService(dbs.app.db, w.owner, bad)).toMatchObject({ ok: false, error: "invalid" });
    }
  });

  it("desactivar un servicio lo deja de ofrecer sin borrar su historial", async () => {
    const w = await world();
    expect(await setServiceActive(dbs.app.db, w.owner, w.serviceId, false)).toEqual({ ok: true });
    const [row] = await dbs.owner.db.select().from(services).where(eq(services.id, w.serviceId));
    expect(row!.active).toBe(false);
  });

  it("un negocio NO puede editar ni asignar cosas de otro (aislamiento)", async () => {
    const a = await world();
    const b = await world();
    expect(await saveService(dbs.app.db, b.owner, { ...service, id: a.serviceId })).toEqual({ ok: false, error: "not_found" });
    expect(await setServiceActive(dbs.app.db, b.owner, a.serviceId, false)).toEqual({ ok: false, error: "not_found" });
    // Un especialista de otro negocio no se puede asignar: se ignora.
    const mine = await saveService(dbs.app.db, b.owner, { ...service, staffIds: [a.staffId] });
    expect(await dbs.owner.db.select().from(staffServices).where(eq(staffServices.serviceId, (mine as { id: string }).id))).toHaveLength(0);
    expect(await saveStaff(dbs.app.db, b.owner, { id: a.staffId, name: "Hackeado", active: true, serviceIds: [] })).toEqual({ ok: false, error: "not_found" });
    expect((await getConfig(dbs.app.db, b.owner))!.services.map((s) => s.id)).not.toContain(a.serviceId);
  });

  it("crea especialistas y les asigna servicios", async () => {
    const w = await world();
    const r = await saveStaff(dbs.app.db, w.owner, { name: "Dr. Mena", roleLabel: "Endodoncista", active: true, serviceIds: [w.serviceId] });
    expect(r).toMatchObject({ ok: true });
    const snapshot = await getConfig(dbs.app.db, w.owner);
    expect(snapshot!.staff.find((s) => s.name === "Dr. Mena")).toMatchObject({ roleLabel: "Endodoncista", serviceIds: [w.serviceId], ownHours: false });
  });
});

describe("horarios y festivos", () => {
  const week = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "09:00", closes: "19:00" }));

  it("reemplaza el horario del negocio y el propio de un especialista (y se puede volver al general)", async () => {
    const w = await world();
    expect(await setHours(dbs.app.db, w.owner, { staffId: null, windows: [...week, { weekday: 6, opens: "09:00", closes: "14:00" }] })).toEqual({ ok: true });
    let rows = await dbs.owner.db.select().from(businessHours).where(eq(businessHours.tenantId, w.tenantId));
    expect(rows.filter((r) => r.staffId === null)).toHaveLength(6);

    await setHours(dbs.app.db, w.owner, { staffId: w.staffId, windows: [{ weekday: 1, opens: "10:00", closes: "15:00" }] });
    expect((await getConfig(dbs.app.db, w.owner))!.staff.find((s) => s.id === w.staffId)!.ownHours).toBe(true);

    await setHours(dbs.app.db, w.owner, { staffId: w.staffId, windows: [] });
    rows = await dbs.owner.db.select().from(businessHours).where(eq(businessHours.tenantId, w.tenantId));
    expect(rows.filter((r) => r.staffId === w.staffId)).toHaveLength(0);
    expect(rows.filter((r) => r.staffId === null)).toHaveLength(6); // el general no se toco
    expect(await audit(w, "config.hours.updated")).toHaveLength(3);
  });

  it("acepta descanso a mediodia (dos ventanas) y rechaza cierres antes de abrir o ventanas encimadas", async () => {
    const w = await world();
    expect(await setHours(dbs.app.db, w.owner, { staffId: null, windows: [{ weekday: 2, opens: "09:00", closes: "14:00" }, { weekday: 2, opens: "16:00", closes: "19:00" }] })).toEqual({ ok: true });
    for (const bad of [
      [{ weekday: 2, opens: "19:00", closes: "09:00" }],
      [{ weekday: 2, opens: "09:00", closes: "09:00" }],
      [{ weekday: 2, opens: "09:00", closes: "15:00" }, { weekday: 2, opens: "14:00", closes: "19:00" }],
      [{ weekday: 9, opens: "09:00", closes: "19:00" }],
      [{ weekday: 2, opens: "9:00", closes: "19:00" }],
    ]) {
      expect(await setHours(dbs.app.db, w.owner, { staffId: null, windows: bad })).toMatchObject({ ok: false, error: "invalid" });
    }
    const rows = await dbs.owner.db.select().from(businessHours).where(eq(businessHours.tenantId, w.tenantId));
    expect(rows).toHaveLength(2); // los rechazos no borraron lo bueno
  });

  it("no se puede poner horario a un especialista de otro negocio", async () => {
    const a = await world();
    const b = await world();
    expect(await setHours(dbs.app.db, b.owner, { staffId: a.staffId, windows: week })).toEqual({ ok: false, error: "not_found" });
  });

  it("agrega y quita dias festivos, validando la fecha", async () => {
    const w = await world();
    const r = await addHoliday(dbs.app.db, w.owner, { staffId: null, date: "2027-12-25", reason: "Navidad" });
    expect(r).toMatchObject({ ok: true });
    expect(await addHoliday(dbs.app.db, w.owner, { staffId: null, date: "25/12/2027" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await addHoliday(dbs.app.db, w.owner, { staffId: null, date: "2027-13-45" })).toMatchObject({ ok: false, error: "invalid" });
    expect((await getConfig(dbs.app.db, w.owner, new Date("2027-12-01")))!.holidays).toMatchObject([{ date: "2027-12-25", reason: "Navidad" }]);
    expect(await removeHoliday(dbs.app.db, w.owner, (r as { id: string }).id)).toEqual({ ok: true });
    expect(await dbs.owner.db.select().from(businessHolidays).where(eq(businessHolidays.tenantId, w.tenantId))).toHaveLength(0);
    expect(await removeHoliday(dbs.app.db, w.owner, (r as { id: string }).id)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("conocimiento del asistente", () => {
  it("crea, edita y borra documentos; el texto queda listo para que el asistente lo consulte", async () => {
    const w = await world();
    const created = await saveDoc(dbs.app.db, w.owner, { title: "Preguntas frecuentes", text: "¿Atienden niños? Sí, desde los 4 años." });
    const id = (created as { id: string }).id;
    const [row] = await dbs.owner.db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id));
    expect(row).toMatchObject({ title: "Preguntas frecuentes", status: "ready", sourceType: "text" });

    await saveDoc(dbs.app.db, w.owner, { id, title: "Preguntas frecuentes", text: "¿Atienden niños? Sí, desde los 3 años." });
    expect((await getConfig(dbs.app.db, w.owner))!.docs[0]!.text).toContain("3 años");
    expect(await saveDoc(dbs.app.db, w.owner, { title: "", text: "" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await removeDoc(dbs.app.db, w.owner, id)).toEqual({ ok: true });
    expect((await getConfig(dbs.app.db, w.owner))!.docs).toHaveLength(0);
  });

  it("otro negocio no puede leer ni borrar los documentos", async () => {
    const a = await world();
    const b = await world();
    const created = await saveDoc(dbs.app.db, a.owner, { title: "Privado", text: "secreto de A" });
    expect((await getConfig(dbs.app.db, b.owner))!.docs).toHaveLength(0);
    expect(await removeDoc(dbs.app.db, b.owner, (created as { id: string }).id)).toEqual({ ok: false, error: "not_found" });
  });
});
