import { REVIEW_REQUEST_TEMPLATE, decodeTemplateMessage } from "@empleado/channels";
import { appointments, auditLog, contacts, messages, reviewSettings, templates } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReviewProcessor, createReviewScanner } from "../src/processors/reviews";
import { dropWorld, makeAppointment, makeWorld, openDbs, type Dbs, type World } from "./helpers";

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

const NOW = new Date("2027-03-02T16:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const URL_GOOGLE = "https://g.page/r/CabcDEF/review";

/** Una cita que termino hace ~4 h (la solicitud sale 3 h despues de terminar) y un negocio con la funcion encendida. */
async function setup(opts: { enabled?: boolean; template?: boolean; status?: "confirmed" | "done" | "cancelled" | "no_show"; endedHoursAgo?: number; enabledAt?: Date } = {}) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  const { db } = dbs.owner;
  const ended = opts.endedHoursAgo ?? 4;
  // makeAppointment crea la cita a partir de startsAt; dura 45 min.
  const appt = await makeAppointment(dbs.owner, w, { startsAt: hoursAgo(ended + 0.75), status: opts.status ?? "confirmed", templates: "none" });
  await db.insert(reviewSettings).values({ tenantId: w.tenantId, enabled: opts.enabled ?? true, hoursAfter: 3, platform: "google", url: URL_GOOGLE, enabledAt: opts.enabledAt ?? hoursAgo(24 * 7) });
  if (opts.template !== false) {
    await db.insert(templates).values({ tenantId: w.tenantId, channelId: w.channelId, name: REVIEW_REQUEST_TEMPLATE.name, language: REVIEW_REQUEST_TEMPLATE.language, category: "utility", components: [], status: "approved" });
  }
  const enqueued: Array<{ tenantId: string; messageId: string }> = [];
  const deps = { db: dbs.app.db, enqueueOutbound: async (j: { tenantId: string; messageId: string }) => void enqueued.push(j), now: () => NOW };
  const row = async () => (await dbs.owner.db.select().from(appointments).where(eq(appointments.id, appt.id)))[0]!;
  return { w, appt, deps, enqueued, row, job: { tenantId: w.tenantId, appointmentId: appt.id }, process: createReviewProcessor(deps) };
}

describe("solicitud de resena despues de la cita", () => {
  it("manda la plantilla por WhatsApp con el nombre, el negocio y el enlace, y solo una vez por cita", async () => {
    const t = await setup();
    const r = await t.process(t.job);
    expect(r.status).toBe("sent");
    expect(t.enqueued).toHaveLength(1);

    const [msg] = await dbs.owner.db.select().from(messages).where(and(eq(messages.conversationId, t.w.conversationId), eq(messages.direction, "out")));
    expect(msg).toMatchObject({ type: "template", sender: "bot", status: "queued" });
    const body = decodeTemplateMessage(msg!.body)!;
    expect(body).toMatchObject({ name: "solicitud_resena", language: "es_MX", params: ["Carlos", "Clínica Worker", URL_GOOGLE], buttons: [] });
    expect(body.text).toContain("Carlos");
    expect(body.text).toContain(URL_GOOGLE);
    // Texto neutro: no pide reseña solo a quien quedo contento ni ofrece nada a cambio.
    expect(body.text).not.toMatch(/si tu experiencia fue buena|descuento|regalo|a cambio|gratis/i);

    expect((await t.row()).reviewRequestedAt).not.toBeNull();
    expect((await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.entityId, t.appt.id), eq(auditLog.action, "review.requested")))).length).toBe(1);
    expect(await t.process(t.job)).toEqual({ status: "skipped", reason: "already" });
    expect(t.enqueued).toHaveLength(1);
  });

  it("espera las horas configuradas despues de terminar la cita", async () => {
    const t = await setup({ endedHoursAgo: 1 });
    expect(await t.process(t.job)).toEqual({ status: "skipped", reason: "not_due" });
    expect((await t.row()).reviewRequestedAt).toBeNull();
  });

  it("no la pide a citas canceladas ni de 'no asistio', ni a quien pidio no recibir mensajes, ni a quien no tiene telefono", async () => {
    for (const status of ["cancelled", "no_show"] as const) {
      const t = await setup({ status });
      expect(await t.process(t.job)).toEqual({ status: "skipped", reason: "inactive" });
    }
    const optedOut = await setup();
    await dbs.owner.db.update(contacts).set({ optedOutAt: new Date() }).where(eq(contacts.id, optedOut.w.contactId));
    expect(await optedOut.process(optedOut.job)).toEqual({ status: "skipped", reason: "opted_out" });

    const noPhone = await setup();
    await dbs.owner.db.update(contacts).set({ phoneE164: null }).where(eq(contacts.id, noPhone.w.contactId));
    expect(await noPhone.process(noPhone.job)).toEqual({ status: "skipped", reason: "no_phone" });
    // Estos motivos no se arreglan solos: la cita se da por atendida para no estorbar en la fila.
    expect((await noPhone.row()).reviewRequestedAt).not.toBeNull();
  });

  it("al mismo cliente solo se le pide una vez cada 90 dias, aunque tenga varias citas", async () => {
    const t = await setup();
    const other = await makeAppointment(dbs.owner, t.w, { startsAt: hoursAgo(24 * 30), status: "done", templates: "none" });
    await dbs.owner.db.update(appointments).set({ reviewRequestedAt: hoursAgo(24 * 10) }).where(eq(appointments.id, other.id)); // pidieron hace 10 dias
    expect(await t.process(t.job)).toEqual({ status: "skipped", reason: "recent_request" });

    // Si la ultima solicitud fue hace mas de 90 dias, si se vuelve a pedir.
    const t2 = await setup();
    const old = await makeAppointment(dbs.owner, t2.w, { startsAt: hoursAgo(24 * 200), status: "done", templates: "none" });
    await dbs.owner.db.update(appointments).set({ reviewRequestedAt: hoursAgo(24 * 120) }).where(eq(appointments.id, old.id));
    expect((await t2.process(t2.job)).status).toBe("sent");
  });

  it("sin plantilla aprobada espera (no la marca) y sale en cuanto Meta la apruebe", async () => {
    const t = await setup({ template: false });
    expect(await t.process(t.job)).toEqual({ status: "skipped", reason: "no_template" });
    expect((await t.row()).reviewRequestedAt).toBeNull();
    await dbs.owner.db.insert(templates).values({ tenantId: t.w.tenantId, channelId: t.w.channelId, name: REVIEW_REQUEST_TEMPLATE.name, language: REVIEW_REQUEST_TEMPLATE.language, category: "utility", components: [], status: "approved" });
    expect((await t.process(t.job)).status).toBe("sent");
  });

  it("el escaner solo toma negocios con la funcion encendida y citas posteriores a cuando se encendio", async () => {
    const on = await setup();
    const off = await setup({ enabled: false });
    const before = await setup({ enabledAt: hoursAgo(2) }); // se encendio DESPUES de que terminara la cita (hace 4 h)

    await createReviewScanner(on.deps)();
    expect((await on.row()).reviewRequestedAt).not.toBeNull();
    expect((await off.row()).reviewRequestedAt).toBeNull();
    expect((await before.row()).reviewRequestedAt).toBeNull();
  });
});
