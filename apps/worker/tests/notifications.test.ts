import { STAFF_ALERT_TEMPLATE } from "@empleado/channels";
import { auditLog, handoffs, notificationSettings, templates, tenants } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createNotificationScanner, createNotifier } from "../src/processors/notifications";
import { FakeSender, KEY, dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

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

/** Martes 2-mar-2027, 10:00 en Merida (dentro del horario de atencion humana de la prueba). */
const OPEN = new Date("2027-03-02T16:00:00Z");
/** Martes 23:00 en Merida (fuera de horario). */
const CLOSED = new Date("2027-03-03T05:00:00Z");
const EMAIL = { apiKey: "k", fromEmail: "avisos@jovia.test", fromName: "Jovia" };

async function setup(opts: { recipients?: Array<{ id: string; kind: "whatsapp" | "email"; address: string; enabled: boolean }>; mode?: string; template?: boolean; kind?: string; urgency?: string } = {}) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  const { db } = dbs.owner;
  await db.update(tenants).set({ humanHours: { mon: ["09:00", "19:00"], tue: ["09:00", "19:00"], wed: ["09:00", "19:00"], thu: ["09:00", "19:00"], fri: ["09:00", "19:00"], sat: null, sun: null } }).where(eq(tenants.id, w.tenantId));
  await db.insert(notificationSettings).values({
    tenantId: w.tenantId,
    enabled: true,
    mode: opts.mode ?? "business_hours",
    recipients: opts.recipients ?? [
      { id: "r1", kind: "whatsapp", address: "+529991234567", enabled: true },
      { id: "r2", kind: "email", address: "recepcion@clinica.test", enabled: true },
    ],
  });
  if (opts.template !== false) {
    await db.insert(templates).values({ tenantId: w.tenantId, channelId: w.channelId, name: STAFF_ALERT_TEMPLATE.name, language: STAFF_ALERT_TEMPLATE.language, category: "utility", components: [], status: "approved" });
  }
  const [h] = await db
    .insert(handoffs)
    .values({ tenantId: w.tenantId, conversationId: w.conversationId, reason: "Quiere hablar con la doctora", summary: "Pide cita con urgencia para su hijo", kind: opts.kind ?? "pidio_persona", urgency: opts.urgency ?? "normal" })
    .returning();
  const sender = new FakeSender();
  const sendEmail = vi.fn(async () => {});
  const deps = (now: Date, email: typeof EMAIL | null = EMAIL) => ({
    db: dbs.app.db,
    key: KEY,
    makeSender: () => sender,
    email,
    sendEmail,
    baseUrl: "https://app.jovia.test/",
    now: () => now,
  });
  const notifiedAt = async () => (await dbs.owner.db.select().from(handoffs).where(eq(handoffs.id, h!.id)))[0]!;
  return { w, h: h!, sender, sendEmail, deps, notifiedAt, job: { tenantId: w.tenantId, handoffId: h!.id } };
}

describe("aviso al equipo cuando piden a una persona", () => {
  it("manda la plantilla por WhatsApp y el correo, con el cliente, el canal, el motivo y el enlace; y solo una vez", async () => {
    const t = await setup();
    const r = await createNotifier(t.deps(OPEN))(t.job);
    expect(r).toEqual({ status: "sent", whatsapp: 1, email: 1 });

    expect(t.sender.calls).toHaveLength(1);
    const wa = t.sender.calls[0]!;
    expect(wa).toMatchObject({ kind: "template", to: "529991234567", template: { name: "aviso_atencion_humana", language: "es_MX" } });
    const p = wa.template!.bodyParams;
    expect(p[0]).toBe("Clínica Worker");
    expect(p[1]).toBe("Carlos Pérez");
    expect(p[2]).toBe("WhatsApp");
    expect(p[3]).toMatch(/pidió hablar con una persona.*urgencia para su hijo/i);
    expect(p[4]).toBe(`https://app.jovia.test/bandeja?c=${t.h.conversationId}`);
    expect(p.every((x) => !/[\n\t]/.test(x))).toBe(true); // Meta no admite saltos de linea

    expect(t.sendEmail).toHaveBeenCalledTimes(1);
    const [, mail] = t.sendEmail.mock.calls[0] as unknown as [unknown, { to: string; subject: string; text: string }];
    expect(mail.to).toBe("recepcion@clinica.test");
    expect(mail.subject).toContain("Carlos Pérez");
    expect(mail.text).toContain(`bandeja?c=${t.h.conversationId}`);

    expect((await t.notifiedAt()).notifiedAt).not.toBeNull();
    const [log] = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.entityId, t.h.id), eq(auditLog.action, "notification.sent")));
    expect(JSON.stringify(log!.diff)).not.toMatch(/recepcion@|529991234567/); // sin direcciones en la bitacora

    expect(await createNotifier(t.deps(OPEN))(t.job)).toMatchObject({ status: "skipped", reason: "already" });
    expect(t.sender.calls).toHaveLength(1);
  });

  it("con 'solo en horario' espera a que abra; con 'siempre' avisa de inmediato", async () => {
    const t = await setup();
    expect(await createNotifier(t.deps(CLOSED))(t.job)).toEqual({ status: "skipped", reason: "closed" });
    expect((await t.notifiedAt()).notifiedAt).toBeNull();
    expect(t.sender.calls).toHaveLength(0);
    // Al abrir el horario sale solo.
    expect(await createNotifier(t.deps(OPEN))(t.job)).toMatchObject({ status: "sent" });

    const always = await setup({ mode: "always" });
    expect(await createNotifier(always.deps(CLOSED))(always.job)).toMatchObject({ status: "sent" });
  });

  it("si falta la plantilla aprobada de WhatsApp, avisa por correo; si solo hay WhatsApp, espera sin gastar intentos", async () => {
    const both = await setup({ template: false });
    expect(await createNotifier(both.deps(OPEN))(both.job)).toEqual({ status: "sent", whatsapp: 0, email: 1 });
    expect(both.sender.calls).toHaveLength(0);

    const onlyWa = await setup({ template: false, recipients: [{ id: "r1", kind: "whatsapp", address: "+529991234567", enabled: true }] });
    expect(await createNotifier(onlyWa.deps(OPEN))(onlyWa.job)).toEqual({ status: "skipped", reason: "nothing_ready" });
    const row = await onlyWa.notifiedAt();
    expect(row.notifiedAt).toBeNull();
    expect(row.notifyAttempts).toBe(0);
  });

  it("un fallo real cuenta como intento y se libera para reintentar; tras 5 ya no insiste", async () => {
    const t = await setup({ recipients: [{ id: "r2", kind: "email", address: "recepcion@clinica.test", enabled: true }] });
    t.sendEmail.mockRejectedValue(new Error("correo caido"));
    expect(await createNotifier(t.deps(OPEN))(t.job)).toEqual({ status: "failed" });
    let row = await t.notifiedAt();
    expect(row).toMatchObject({ notifiedAt: null, notifyAttempts: 1 });
    // Con el servicio de correo sin configurar no es un fallo (no gasta intentos).
    expect(await createNotifier(t.deps(OPEN, null))(t.job)).toEqual({ status: "skipped", reason: "nothing_ready" });
    expect((await t.notifiedAt()).notifyAttempts).toBe(1);

    await dbs.owner.db.update(handoffs).set({ notifyAttempts: 5 }).where(eq(handoffs.id, t.h.id));
    const scan = createNotificationScanner(t.deps(OPEN));
    t.sendEmail.mockClear();
    await scan();
    expect(t.sendEmail).not.toHaveBeenCalled();
  });

  it("el escaner solo toma pedidos de persona, urgencias y quejas (no fallas ni dudas), de negocios con avisos encendidos", async () => {
    const pidio = await setup({ kind: "pidio_persona" });
    const queja = await setup({ kind: "queja" });
    const urgenteOtro = await setup({ kind: "otro", urgency: "alta" });
    const duda = await setup({ kind: "otro" });
    const falla = await setup({ kind: "sistema" });
    const apagado = await setup();
    await dbs.owner.db.update(notificationSettings).set({ enabled: false }).where(eq(notificationSettings.tenantId, apagado.w.tenantId));

    const scan = createNotificationScanner(pidio.deps(OPEN));
    await scan();
    const was = async (t: { notifiedAt: () => Promise<{ notifiedAt: Date | null }> }) => (await t.notifiedAt()).notifiedAt !== null;
    expect(await was(pidio)).toBe(true);
    expect(await was(queja)).toBe(true);
    expect(await was(urgenteOtro)).toBe(true);
    expect(await was(duda)).toBe(false);
    expect(await was(falla)).toBe(false);
    expect(await was(apagado)).toBe(false);
  });

  it("una escalacion ya resuelta no se avisa", async () => {
    const t = await setup();
    await dbs.owner.db.update(handoffs).set({ resolvedAt: new Date() }).where(eq(handoffs.id, t.h.id));
    expect(await createNotifier(t.deps(OPEN))(t.job)).toMatchObject({ status: "skipped", reason: "already" });
    expect(t.sender.calls).toHaveLength(0);
  });
});
