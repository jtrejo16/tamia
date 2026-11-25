import { auditLog, businessHolidays, businessHours, contacts, menuCategories, menuItems, reservations, restaurantSettings, tenants, withTenant } from "@empleado/db";
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

/** NOW = lunes 1-mar-2027 12:00 en Merida. El mundo de prueba abre de lunes a viernes de 09:00 a 19:00. */
const TUESDAY = "2027-03-02";

async function seed(over: Partial<typeof restaurantSettings.$inferInsert> | null = {}): Promise<World> {
  const w = await makeWorld(dbs.owner, { contactName: "Laura" });
  worlds.push(w);
  const db = dbs.owner.db;
  await db.update(tenants).set({ profile: { cancellationNoticeHours: 12, modules: ["restaurante"] } }).where(eq(tenants.id, w.tenantId));
  await db.update(contacts).set({ phoneE164: "+529991234567" }).where(eq(contacts.id, w.contactId));
  const [cat] = await db.insert(menuCategories).values({ tenantId: w.tenantId, name: "Tacos" }).returning();
  await db.insert(menuItems).values({ tenantId: w.tenantId, categoryId: cat!.id, name: "Pastor", priceCents: 1800 });
  if (over) await db.insert(restaurantSettings).values({ tenantId: w.tenantId, reservationsEnabled: true, reservationsCapacity: 20, ...over });
  return w;
}

const ctxOf = (w: World): Promise<TurnContext> => loadTurnContext(dbs.app.db, w.tenantId, w.conversationId, { now: NOW });
const call = (name: string, args: unknown, ctx: TurnContext) => runTool(name, JSON.stringify(args), ctx).then((r) => r.result as Record<string, any>);
const rowsOf = (w: World) => withTenant(dbs.app.db, { tenantId: w.tenantId }, (tx) => tx.select().from(reservations).orderBy(reservations.number));

/** Pide el resumen y confirma en un turno posterior, como en una conversacion real. */
async function reserve(w: World, args: Record<string, unknown>) {
  const ctx = await ctxOf(w);
  const summary = await call("crear_reservacion", args, ctx);
  if (!summary.requiere_confirmacion) return { summary, result: summary, ctx };
  ctx.inboundCount += 1;
  return { summary, result: await call("crear_reservacion", { ...args, confirmado: true }, ctx), ctx };
}
const booking = (over: Record<string, unknown> = {}) => ({ fecha: TUESDAY, hora: "13:00", personas: 4, ...over });

describe("buscar_mesa", () => {
  it("un negocio que no activo las reservaciones no las ofrece", async () => {
    const w = await seed(null);
    expect(await call("buscar_mesa", { fecha: TUESDAY, personas: 2 }, await ctxOf(w))).toMatchObject({ error: "reservaciones_no_disponibles" });
    expect(await call("crear_reservacion", booking(), await ctxOf(w))).toMatchObject({ error: "reservaciones_no_disponibles" });
    expect(((await call("consultar_menu", {}, await ctxOf(w))) as any).info_de_pedidos.reservaciones).toBe("no disponibles");
  });

  it("devuelve las horas libres mas cercanas a la pedida, sin revelar el aforo", async () => {
    const w = await seed();
    const r = await call("buscar_mesa", { fecha: TUESDAY, personas: 4, hora_preferida: "15:00" }, await ctxOf(w));
    expect(r).toMatchObject({ personas: 4, hora_pedida_disponible: true });
    // Las cuatro mas cercanas a las 15:00 (14:00 y 16:00 empatan; entra la anterior), en orden.
    expect(r.horas_disponibles).toEqual(["14:00", "14:30", "15:00", "15:30"]);
    expect(JSON.stringify(r)).not.toMatch(/aforo|capacidad|lugares/i);
  });

  it("explica por que no hay: dia cerrado, fecha pasada, grupo grande, sin horario cargado", async () => {
    const w = await seed();
    const ctx = await ctxOf(w);
    expect(await call("buscar_mesa", { fecha: "2027-03-07", personas: 2 }, ctx)).toMatchObject({ error: "cerrado_ese_dia" }); // domingo
    expect(await call("buscar_mesa", { fecha: "2027-02-20", personas: 2 }, ctx)).toMatchObject({ error: "fecha_pasada" });
    expect(await call("buscar_mesa", { fecha: TUESDAY, personas: 15 }, ctx)).toMatchObject({ error: "grupo_grande", maximo: 10 });
    expect(await call("buscar_mesa", { fecha: "mañana", personas: 2 }, ctx)).toMatchObject({ error: "fecha_invalida" });
    expect(await call("buscar_mesa", { fecha: TUESDAY, personas: 2, hora_preferida: "25:00" }, ctx)).toMatchObject({ error: "hora_invalida" });
    await dbs.owner.db.delete(businessHours).where(eq(businessHours.tenantId, w.tenantId));
    expect(await call("buscar_mesa", { fecha: TUESDAY, personas: 2 }, await ctxOf(w))).toMatchObject({ error: "horario_no_configurado" });
  });

  it("si el dia esta lleno, ofrece los proximos dias con lugar", async () => {
    const w = await seed({ reservationsCapacity: 10 });
    await dbs.owner.db.insert(reservations).values({ tenantId: w.tenantId, number: 1, contactId: w.contactId, channel: "panel", customerName: "Grupo", partySize: 10, startsAt: new Date("2027-03-02T15:00:00Z"), endsAt: new Date("2027-03-03T01:00:00Z") });
    const r = await call("buscar_mesa", { fecha: TUESDAY, personas: 4 }, await ctxOf(w));
    expect(r).toMatchObject({ error: "sin_disponibilidad" });
    expect(r.dias_con_lugar[0]).toContain("2027-03-03");
  });

  it("un dia de cierre configurado no ofrece nada", async () => {
    const w = await seed();
    await dbs.owner.db.insert(businessHolidays).values({ tenantId: w.tenantId, staffId: null, date: TUESDAY });
    expect(await call("buscar_mesa", { fecha: TUESDAY, personas: 2 }, await ctxOf(w))).toMatchObject({ error: "cerrado_ese_dia" });
  });
});

describe("crear_reservacion", () => {
  it("resume, espera la confirmacion en un mensaje posterior y crea la reservacion con su numero", async () => {
    const w = await seed();
    const { summary, result } = await reserve(w, booking({ notas: "cumpleaños" }));
    expect(summary.resumen).toContain("4 personas");
    expect(summary.resumen).toContain("martes 2 de marzo a las 13:00");
    expect(summary.resumen).toContain("cumpleaños");
    expect(result).toMatchObject({ ok: true, reservacion_numero: 1, personas: 4 });
    const [r] = await rowsOf(w);
    expect(r).toMatchObject({ number: 1, status: "confirmed", partySize: 4, customerName: "Laura", customerPhone: "+529991234567", channel: "whatsapp", notes: "cumpleaños", createdBy: "bot" });
    expect(r!.startsAt).toEqual(new Date("2027-03-02T19:00:00Z"));
    expect(r!.endsAt).toEqual(new Date("2027-03-02T20:30:00Z")); // estancia de 90 minutos
  });

  it("no crea nada si el cliente no confirmo en un mensaje posterior", async () => {
    const w = await seed();
    const ctx = await ctxOf(w);
    await call("crear_reservacion", booking(), ctx);
    expect(await call("crear_reservacion", { ...booking(), confirmado: true }, ctx)).toMatchObject({ error: "falta_confirmacion" });
    expect(await rowsOf(w)).toHaveLength(0);
  });

  it("no pasa del aforo: el grupo que ya no cabe recibe otras horas, y uno mas chico si cabe", async () => {
    const w = await seed({ reservationsCapacity: 10 });
    expect((await reserve(w, booking({ personas: 6 }))).result).toMatchObject({ ok: true });
    const tooBig = (await reserve(w, booking({ hora: "13:30", personas: 6 }))).result;
    expect(tooBig).toMatchObject({ error: "hora_no_disponible" });
    expect(tooBig.horas_disponibles.length).toBeGreaterThan(0);
    expect(tooBig.horas_disponibles).not.toContain("13:30");
    expect((await reserve(w, booking({ hora: "13:30", personas: 4 }))).result).toMatchObject({ ok: true, reservacion_numero: 2 });
    expect(await rowsOf(w)).toHaveLength(2);
    // Mas tarde (despues de que termina la estancia) vuelve a haber lugar.
    expect((await reserve(w, booking({ hora: "15:30", personas: 10 }))).result).toMatchObject({ ok: true });
  });

  it("solo acepta horas que ofrece el sistema (no una fuera de horario ni un intervalo raro)", async () => {
    const w = await seed();
    expect((await reserve(w, booking({ hora: "21:00" }))).result).toMatchObject({ error: "hora_no_disponible" }); // cierra a las 19
    expect((await reserve(w, booking({ hora: "13:10" }))).result).toMatchObject({ error: "hora_no_disponible" });
    expect(await rowsOf(w)).toHaveLength(0);
  });

  it("repetir la misma reservacion no la duplica; otra hora es otra reservacion", async () => {
    const w = await seed();
    await reserve(w, booking());
    const again = await reserve(w, booking());
    expect(again.result).toMatchObject({ ok: true, reservacion_numero: 1, nota: expect.stringContaining("no se duplicó") });
    expect((await reserve(w, booking({ hora: "17:00" }))).result).toMatchObject({ ok: true, reservacion_numero: 2 });
    expect(await rowsOf(w)).toHaveLength(2);
  });

  it("pide el nombre y el telefono si faltan; los grupos grandes y el aviso minimo se respetan", async () => {
    const w = await seed();
    await dbs.owner.db.update(contacts).set({ phoneE164: null }).where(eq(contacts.id, w.contactId));
    expect(await call("crear_reservacion", booking(), await ctxOf(w))).toMatchObject({ error: "faltan_datos", faltan: ["teléfono a 10 dígitos"] });
    await dbs.owner.db.update(contacts).set({ phoneE164: "+529991234567", displayName: null }).where(eq(contacts.id, w.contactId));
    expect(await call("crear_reservacion", booking(), await ctxOf(w))).toMatchObject({ error: "faltan_datos", faltan: ["nombre"] });
    expect(await call("crear_reservacion", booking({ personas: 30 }), await ctxOf(w))).toMatchObject({ error: "grupo_grande" });
    expect(await call("crear_reservacion", booking({ fecha: "2027-03-01", hora: "12:30" }), await ctxOf(w))).toMatchObject({ error: "hora_no_disponible" }); // son las 12:00 y piden 60 min de aviso
  });

  it("la bitacora deja constancia", async () => {
    const w = await seed();
    await reserve(w, booking());
    const rows = await withTenant(dbs.app.db, { tenantId: w.tenantId }, (tx) => tx.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entity, "reservation")));
    expect(rows.map((r) => r.action)).toEqual(["reservation.created"]);
  });
});

describe("mis_reservaciones y cancelar_reservacion", () => {
  it("el cliente ve las suyas y cancela; el lugar queda libre otra vez", async () => {
    const w = await seed({ reservationsCapacity: 10 });
    await reserve(w, booking({ personas: 10 }));
    const mine = await call("mis_reservaciones", {}, await ctxOf(w));
    expect(mine.reservaciones).toHaveLength(1);
    expect(mine.reservaciones[0]).toMatchObject({ reservacion_numero: 1, personas: 10 });
    // Lleno para otros.
    expect(await call("buscar_mesa", { fecha: TUESDAY, personas: 2, hora_preferida: "13:00" }, await ctxOf(w))).toMatchObject({ hora_pedida_disponible: false });

    const ctx = await ctxOf(w);
    expect(await call("cancelar_reservacion", { reservacion_numero: 1 }, ctx)).toMatchObject({ requiere_confirmacion: true });
    ctx.inboundCount += 1;
    expect(await call("cancelar_reservacion", { reservacion_numero: 1, confirmado: true }, ctx)).toMatchObject({ ok: true });
    expect((await rowsOf(w))[0]).toMatchObject({ status: "cancelled", cancelledBy: "cliente" });
    expect(await call("buscar_mesa", { fecha: TUESDAY, personas: 2, hora_preferida: "13:00" }, await ctxOf(w))).toMatchObject({ hora_pedida_disponible: true });
    expect((await call("mis_reservaciones", {}, await ctxOf(w))).reservaciones).toEqual([]);
    expect(await call("cancelar_reservacion", { reservacion_numero: 1 }, await ctxOf(w))).toMatchObject({ error: "reservacion_cerrada" });
  });

  it("no se cancela una que ya empezo ni la de otro cliente", async () => {
    const w = await seed();
    await dbs.owner.db.insert(reservations).values({ tenantId: w.tenantId, number: 1, contactId: w.contactId, channel: "panel", customerName: "Laura", partySize: 2, startsAt: new Date("2027-03-01T17:00:00Z"), endsAt: new Date("2027-03-01T19:00:00Z") });
    expect(await call("cancelar_reservacion", { reservacion_numero: 1 }, await ctxOf(w))).toMatchObject({ error: "reservacion_pasada" });
    const other = await loadTurnContext(dbs.app.db, w.tenantId, w.otherContactId, { now: NOW }).catch(() => null);
    if (other) {
      expect(await call("cancelar_reservacion", { reservacion_numero: 1 }, other)).toMatchObject({ error: "reservacion_no_encontrada" });
      expect((await call("mis_reservaciones", {}, other)).reservaciones).toEqual([]);
    }
  });
});

describe("consultar_menu informa de las reservaciones", () => {
  it("publica los limites cuando estan activas", async () => {
    const w = await seed();
    const info = ((await call("consultar_menu", {}, await ctxOf(w))) as any).info_de_pedidos;
    expect(info.reservaciones).toEqual({ disponibles: true, grupo_maximo: 10, aviso_minimo_minutos: 60, hasta_dias_adelante: 30 });
  });
});

describe("aislamiento", () => {
  it("las reservaciones de otro negocio no ocupan el aforo de este", async () => {
    const a = await seed({ reservationsCapacity: 4 });
    const b = await seed({ reservationsCapacity: 4 });
    await reserve(a, booking({ personas: 4 }));
    expect((await reserve(b, booking({ personas: 4 }))).result).toMatchObject({ ok: true, reservacion_numero: 1 });
    expect(await rowsOf(a)).toHaveLength(1);
    expect(await rowsOf(b)).toHaveLength(1);
    const cross = await dbs.owner.db.select().from(reservations).where(and(eq(reservations.tenantId, b.tenantId)));
    expect(cross).toHaveLength(1);
  });
});
