import { buttonPayloads, decodeTemplateMessage, type InboundJobData } from "@empleado/channels";
import { appointments, auditLog, contacts, conversations, messages, templates } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { noLock } from "../src/lock";
import { createInboundProcessor } from "../src/processors/inbound";
import { createOutboundProcessor } from "../src/processors/outbound";
import { createReminderScanner } from "../src/processors/reminders";
import { unlimited } from "../src/ratelimit";
import { FakeLLM, FakeSender, KEY, dropWorld, makeAppointment, makeWorld, openDbs, type Dbs, type World } from "./helpers";

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

/** Martes 2-mar-2027, 10:00 en Merida (horario diurno). */
const NOW = new Date("2027-03-02T16:00:00Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 3600_000);

async function setup(options: Parameters<typeof makeWorld>[1] = {}) {
  const w = await makeWorld(dbs.owner, options);
  worlds.push(w);
  const enqueued: Array<{ tenantId: string; messageId: string }> = [];
  const enqueueOutbound = async (j: { tenantId: string; messageId: string }) => void enqueued.push(j);
  // El escaner mira TODOS los negocios; cada prueba lo limita al suyo para no mezclarse con las demas.
  const scan = (now = NOW) => createReminderScanner({ db: dbs.app.db, enqueueOutbound, now: () => now })({ tenantId: w.tenantId });
  const outMessages = () =>
    dbs.owner.db.select().from(messages).where(and(eq(messages.conversationId, w.conversationId), eq(messages.direction, "out")));
  return { w, enqueued, enqueueOutbound, scan, outMessages };
}

describe("recordatorios de cita", () => {
  it("24 h antes: encola la plantilla con el texto, los datos y los botones de ESA cita", async () => {
    const { w, scan, enqueued, outMessages } = await setup();
    const appt = await makeAppointment(dbs.owner, w, { startsAt: hours(10) }); // mañana... hoy 20:00

    const result = await scan();
    expect(result).toMatchObject({ sent: 1, errors: 0 });

    const [msg] = await outMessages();
    expect(msg).toMatchObject({ type: "template", sender: "bot", status: "queued" });
    const body = decodeTemplateMessage(msg!.body)!;
    expect(body).toMatchObject({ name: "recordatorio_cita_24h", language: "es_MX", buttons: buttonPayloads(appt.id) });
    expect(body.params).toEqual(["Carlos", "limpieza dental", "martes 2 de marzo a las 20:00", "Clínica Worker"]);
    expect(body.text).toBe("Hola Carlos, te recordamos tu cita de limpieza dental el martes 2 de marzo a las 20:00 en Clínica Worker. ¿Nos confirmas tu asistencia?");
    expect(enqueued).toEqual([{ tenantId: w.tenantId, messageId: msg!.id }]);

    const [row] = await dbs.owner.db.select().from(appointments).where(eq(appointments.id, appt.id));
    expect(row!.reminder24hSentAt).toBeTruthy();
    expect(row!.reminder2hSentAt).toBeNull();
  });

  it("no se repite: una segunda revision no envia otra vez", async () => {
    const { w, scan, outMessages } = await setup();
    await makeAppointment(dbs.owner, w, { startsAt: hours(10) });
    await scan();
    expect(await scan()).toMatchObject({ sent: 0 });
    expect(await outMessages()).toHaveLength(1);
  });

  it("dos procesos revisando a la vez envian UN solo recordatorio", async () => {
    const { w, scan, outMessages } = await setup();
    await makeAppointment(dbs.owner, w, { startsAt: hours(10) });
    const [a, b] = await Promise.all([scan(), scan()]);
    expect(a.sent + b.sent).toBe(1);
    expect(await outMessages()).toHaveLength(1);
  });

  it("2 h antes: usa la plantilla corta", async () => {
    const { w, scan, outMessages } = await setup();
    await makeAppointment(dbs.owner, w, { startsAt: new Date(NOW.getTime() + 90 * 60_000) });
    expect(await scan()).toMatchObject({ sent: 1 });
    const [msg] = await outMessages();
    expect(decodeTemplateMessage(msg!.body)!.name).toBe("recordatorio_cita_2h");
    expect(decodeTemplateMessage(msg!.body)!.text).toContain("es hoy, martes 2 de marzo a las 11:30");
  });

  it("si la cita se agendo hace pocas horas NO se manda el de 24 h (el cliente acaba de enterarse)", async () => {
    const { w, scan, outMessages } = await setup();
    await makeAppointment(dbs.owner, w, { startsAt: hours(10), createdAt: new Date(NOW.getTime() - 5 * 3600_000) });
    expect(await scan()).toMatchObject({ sent: 0 });
    expect(await outMessages()).toHaveLength(0);
  });

  it("nunca de noche: fuera de 08:00-20:59 (hora del negocio) no se envia nada", async () => {
    const { w, scan } = await setup();
    await makeAppointment(dbs.owner, w, { startsAt: hours(10) });
    const night = new Date("2027-03-03T04:00:00Z"); // 22:00 en Merida
    const dawn = new Date("2027-03-02T13:30:00Z"); // 07:30 en Merida
    expect(await scan(night)).toMatchObject({ sent: 0 });
    expect(await scan(dawn)).toMatchObject({ sent: 0 });
  });

  it("sin plantilla aprobada no se envia NI se marca como enviado: sale cuando Meta la aprueba", async () => {
    const { w, scan, outMessages } = await setup();
    const appt = await makeAppointment(dbs.owner, w, { startsAt: hours(10), templates: "pending" });
    expect(await scan()).toMatchObject({ sent: 0, skipped: 1 });
    expect(await outMessages()).toHaveLength(0);
    const [row] = await dbs.owner.db.select().from(appointments).where(eq(appointments.id, appt.id));
    expect(row!.reminder24hSentAt).toBeNull();

    await dbs.owner.db.update(templates).set({ status: "approved" }).where(eq(templates.tenantId, w.tenantId));
    expect(await scan()).toMatchObject({ sent: 1 });
  });

  it("no avisa de citas canceladas, ni a quien pidio no recibir mensajes, ni a contactos sin telefono", async () => {
    const cancelled = await setup();
    await makeAppointment(dbs.owner, cancelled.w, { startsAt: hours(10), status: "cancelled" });
    expect(await cancelled.scan()).toMatchObject({ sent: 0 });

    const optedOut = await setup();
    await dbs.owner.db.update(contacts).set({ optedOutAt: new Date() }).where(eq(contacts.id, optedOut.w.contactId));
    await makeAppointment(dbs.owner, optedOut.w, { startsAt: hours(10) });
    expect(await optedOut.scan()).toMatchObject({ sent: 0 });
    expect(await optedOut.outMessages()).toHaveLength(0);

    const noPhone = await setup();
    await dbs.owner.db.update(contacts).set({ phoneE164: null }).where(eq(contacts.id, noPhone.w.contactId));
    await makeAppointment(dbs.owner, noPhone.w, { startsAt: hours(10) });
    expect(await noPhone.scan()).toMatchObject({ sent: 0 });
  });

  it("citas fuera de rango (muy lejanas o ya pasadas) no se avisan", async () => {
    const { w, scan } = await setup();
    await makeAppointment(dbs.owner, w, { startsAt: hours(48) });
    await makeAppointment(dbs.owner, w, { startsAt: hours(-1), status: "pending" });
    expect(await scan()).toMatchObject({ sent: 0 });
  });

  it("sin filtro atiende a TODOS los negocios, cada uno por su propio canal", async () => {
    const a = await setup();
    const b = await setup();
    await makeAppointment(dbs.owner, a.w, { startsAt: hours(10) });
    await makeAppointment(dbs.owner, b.w, { startsAt: hours(11) });
    const all = await createReminderScanner({ db: dbs.app.db, enqueueOutbound: a.enqueueOutbound, now: () => NOW })();
    expect(all.sent).toBeGreaterThanOrEqual(2);
    expect(await a.outMessages()).toHaveLength(1);
    expect(await b.outMessages()).toHaveLength(1);
    const [ma] = await a.outMessages();
    const [mb] = await b.outMessages();
    expect(ma!.channelId).toBe(a.w.channelId);
    expect(mb!.channelId).toBe(b.w.channelId);
  });

  it("un recordatorio NO abre la ventana de 24 h del cliente", async () => {
    const { w, scan } = await setup({ lastInboundAt: null });
    await makeAppointment(dbs.owner, w, { startsAt: hours(10) });
    await scan();
    const [conv] = await dbs.owner.db.select().from(conversations).where(eq(conversations.id, w.conversationId));
    expect(conv!.lastInboundAt).toBeNull();
  });
});

describe("envio de la plantilla (aunque la ventana de 24 h este cerrada)", () => {
  it("el worker la manda con sus parametros y botones; un texto libre en la misma situacion se bloquearia", async () => {
    const { w, scan, outMessages } = await setup({ lastInboundAt: null });
    const appt = await makeAppointment(dbs.owner, w, { startsAt: hours(10) });
    await scan();
    const [msg] = await outMessages();

    const sender = new FakeSender();
    const process = createOutboundProcessor({ db: dbs.app.db, key: KEY, makeSender: () => sender, lock: noLock, now: () => NOW });
    expect(await process({ tenantId: w.tenantId, messageId: msg!.id })).toMatchObject({ sent: [msg!.id], failed: [] });

    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]).toMatchObject({ kind: "template", to: w.waId });
    expect(sender.calls[0]!.template).toMatchObject({
      name: "recordatorio_cita_24h",
      language: "es_MX",
      bodyParams: ["Carlos", "limpieza dental", "martes 2 de marzo a las 20:00", "Clínica Worker"],
      buttonPayloads: buttonPayloads(appt.id),
    });
    const [row] = await dbs.owner.db.select().from(messages).where(eq(messages.id, msg!.id));
    expect(row!.status).toBe("sent");
  });
});

describe("botones del recordatorio", () => {
  async function inboundSetup(options: Parameters<typeof makeWorld>[1] = {}) {
    const base = await setup(options);
    const llm = new FakeLLM([{ text: "Claro, ¿qué día le acomoda?" }]);
    const process = createInboundProcessor({
      db: dbs.app.db,
      llm,
      enqueueOutbound: base.enqueueOutbound,
      lock: noLock,
      limiter: unlimited,
      now: () => NOW,
    });
    const press = (payload: string, text: string, id = `wamid.BTN${Math.random().toString(36).slice(2)}`): InboundJobData => ({
      tenantId: base.w.tenantId,
      channelId: base.w.channelId,
      phoneNumberId: base.w.phoneNumberId,
      message: { id, from: base.w.waId, timestamp: 1, type: "interactive", text, replyPayload: payload },
    });
    return { ...base, llm, process, press };
  }

  it("'Confirmo' marca la cita como confirmada por el cliente, agradece y NO gasta IA", async () => {
    const { w, process, press, llm, outMessages } = await inboundSetup();
    const appt = await makeAppointment(dbs.owner, w, { startsAt: hours(10), status: "pending" });

    const result = await process(press(`rem:confirm:${appt.id}`, "Confirmo"));
    expect(result).toMatchObject({ status: "processed", action: "send" });
    expect(llm.requests).toHaveLength(0);

    const [row] = await dbs.owner.db.select().from(appointments).where(eq(appointments.id, appt.id));
    expect(row).toMatchObject({ confirmedByContact: true, status: "confirmed" });
    const [ack] = await outMessages();
    expect(ack).toMatchObject({ type: "text", sender: "bot", status: "queued" });
    expect(ack!.body).toBe("¡Gracias, Carlos! Tu cita de limpieza dental queda confirmada para el martes 2 de marzo a las 20:00. Te esperamos en Clínica Worker.");
    const log = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, "appointment.confirmed_by_contact")));
    expect(log).toHaveLength(1);
    const inbound = await dbs.owner.db.select().from(messages).where(and(eq(messages.conversationId, w.conversationId), eq(messages.direction, "in")));
    expect(inbound.map((m) => m.body)).toEqual(["Confirmo"]);
  });

  it("el mismo toque entregado dos veces no genera dos agradecimientos", async () => {
    const { w, process, press, outMessages } = await inboundSetup();
    const appt = await makeAppointment(dbs.owner, w, { startsAt: hours(10) });
    const same = press(`rem:confirm:${appt.id}`, "Confirmo", "wamid.MISMO");
    await process(same);
    await process(same);
    expect(await outMessages()).toHaveLength(1);
  });

  it("'Reagendar' pasa al agente con el contexto de la cita (para que ofrezca horarios)", async () => {
    const { w, process, press, llm } = await inboundSetup();
    const appt = await makeAppointment(dbs.owner, w, { startsAt: hours(10) });
    const result = await process(press(`rem:resched:${appt.id}`, "Reagendar"));
    expect(result).toMatchObject({ status: "processed", action: "send" });
    expect(llm.requests).toHaveLength(1);
    const userText = JSON.stringify(llm.requests[0]!.messages.filter((m) => m.role === "user"));
    expect(userText).toContain("reagendar mi cita de limpieza dental del martes 2 de marzo a las 20:00");
    const [row] = await dbs.owner.db.select().from(appointments).where(eq(appointments.id, appt.id));
    expect(row!.confirmedByContact).toBe(false); // no se confirma nada
  });

  it("un identificador de cita AJENO no sirve: no se confirma y lo atiende el agente", async () => {
    const { w, process, press, llm } = await inboundSetup();
    const other = await setup();
    const theirs = await makeAppointment(dbs.owner, other.w, { startsAt: hours(10) });
    // La cita de otro negocio ni siquiera es visible; y una de OTRO cliente del mismo negocio tampoco.
    const [stranger] = await dbs.owner.db.insert(contacts).values({ tenantId: w.tenantId, phoneE164: "+5219990009999", displayName: "Otra" }).returning();
    const sameTenantOther = await makeAppointment(dbs.owner, w, { startsAt: hours(11), contactId: stranger!.id });

    for (const id of [theirs.id, sameTenantOther.id]) {
      await process(press(`rem:confirm:${id}`, "Confirmo"));
    }
    expect(llm.requests.length).toBe(2); // pasaron al agente
    const [a] = await dbs.owner.db.select().from(appointments).where(eq(appointments.id, sameTenantOther.id));
    expect(a!.confirmedByContact).toBe(false);
    const [b] = await dbs.owner.db.select().from(appointments).where(eq(appointments.id, theirs.id));
    expect(b!.confirmedByContact).toBe(false);
  });

  it("si una persona tiene el control, la confirmacion se registra pero NO se contesta sola", async () => {
    const { w, process, press, outMessages } = await inboundSetup();
    await dbs.owner.db.update(conversations).set({ state: "human" }).where(eq(conversations.id, w.conversationId));
    const appt = await makeAppointment(dbs.owner, w, { startsAt: hours(10) });
    const result = await process(press(`rem:confirm:${appt.id}`, "Confirmo"));
    expect(result).toMatchObject({ action: "none", queued: [] });
    const [row] = await dbs.owner.db.select().from(appointments).where(eq(appointments.id, appt.id));
    expect(row!.confirmedByContact).toBe(true);
    expect(await outMessages()).toHaveLength(0);
  });

  it("una cita ya cancelada no se confirma por un boton viejo", async () => {
    const { w, process, press, llm } = await inboundSetup();
    const appt = await makeAppointment(dbs.owner, w, { startsAt: hours(10), status: "cancelled" });
    await process(press(`rem:confirm:${appt.id}`, "Confirmo"));
    expect(llm.requests).toHaveLength(1);
    const [row] = await dbs.owner.db.select().from(appointments).where(eq(appointments.id, appt.id));
    expect(row).toMatchObject({ status: "cancelled", confirmedByContact: false });
  });
});

void vi;
