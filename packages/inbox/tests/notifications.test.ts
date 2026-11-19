import { auditLog, reviewSettings } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EmailError, emailDepsFromEnv, getNotificationSettings, getReviewSettings, normalizePhone, saveNotificationSettings, saveReviewSettings, sendEmail } from "../src";
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

describe("telefonos", () => {
  it("normaliza numeros mexicanos e internacionales a E.164", () => {
    expect(normalizePhone("999 123 4567")).toBe("+529991234567");
    expect(normalizePhone("(999) 123-4567")).toBe("+529991234567");
    expect(normalizePhone("+52 999 123 4567")).toBe("+529991234567");
    expect(normalizePhone("+52 1 999 123 4567")).toBe("+529991234567"); // el "1" antiguo de los moviles
    expect(normalizePhone("5219991234567")).toBe("+529991234567");
    expect(normalizePhone("+1 224 261 7398")).toBe("+12242617398");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("no es un numero")).toBeNull();
  });
});

describe("ajustes de avisos al equipo", () => {
  it("solo el dueño los cambia; normaliza, valida y audita sin guardar direcciones en la bitacora", async () => {
    const w = await world();
    const input = { enabled: true, mode: "business_hours", recipients: [{ kind: "whatsapp", address: "999 123 4567", enabled: true }, { kind: "email", address: "Recepcion@Clinica.test", enabled: true }] };
    expect(await saveNotificationSettings(dbs.app.db, w.agent, input)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await saveNotificationSettings(dbs.app.db, w.owner, input)).toEqual({ ok: true, needsTemplate: true });

    const got = await getNotificationSettings(dbs.app.db, w.owner);
    expect(got).toMatchObject({ enabled: true, mode: "business_hours", hasWhatsApp: true, template: null });
    expect(got.recipients.map((r) => [r.kind, r.address])).toEqual([["whatsapp", "+529991234567"], ["email", "recepcion@clinica.test"]]);
    expect(got.recipients.every((r) => r.id.length >= 6)).toBe(true);

    const [log] = await dbs.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, w.tenantId), eq(auditLog.action, "settings.notifications")));
    expect(JSON.stringify(log!.diff)).not.toMatch(/clinica\.test|529991234567/);
  });

  it("rechaza datos malos: correo o numero invalidos, repetidos, mas de 3, o encender sin destinatarios", async () => {
    const w = await world();
    const ok = { enabled: true, mode: "always", recipients: [{ kind: "email", address: "a@b.mx", enabled: true }] };
    const bad = async (patch: object) => saveNotificationSettings(dbs.app.db, w.owner, { ...ok, ...patch });
    expect(await bad({ recipients: [{ kind: "email", address: "no-es-correo", enabled: true }] })).toMatchObject({ ok: false, error: "invalid" });
    expect(await bad({ recipients: [{ kind: "whatsapp", address: "123", enabled: true }] })).toMatchObject({ ok: false, error: "invalid" });
    expect(await bad({ recipients: [{ kind: "email", address: "a@b.mx", enabled: true }, { kind: "email", address: "A@B.mx", enabled: true }] })).toMatchObject({ ok: false, error: "invalid" });
    const four = ["a", "b", "c", "d"].map((x) => ({ kind: "email", address: `${x}@b.mx`, enabled: true }));
    expect(await bad({ recipients: four })).toMatchObject({ ok: false, error: "invalid" });
    expect(await bad({ recipients: [] })).toMatchObject({ ok: false, error: "invalid" }); // encendido sin destinatarios
    expect(await bad({ recipients: [{ kind: "email", address: "a@b.mx", enabled: false }] })).toMatchObject({ ok: false, error: "invalid" });
    expect(await bad({ mode: "cuando sea" })).toMatchObject({ ok: false, error: "invalid" });
    // Apagado con lista vacia si se puede guardar.
    expect(await bad({ enabled: false, recipients: [] })).toEqual({ ok: true, needsTemplate: false });
  });
});

describe("ajustes de resenas", () => {
  it("valida el enlace segun el sitio, exige enlace para encender y solo el dueño las cambia", async () => {
    const w = await world();
    const ok = { enabled: true, hoursAfter: 3, platform: "google", url: "https://g.page/r/CabcDEF/review" };
    expect(await saveReviewSettings(dbs.app.db, w.agent, ok)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await saveReviewSettings(dbs.app.db, w.owner, { ...ok, url: "http://g.page/r/x" })).toMatchObject({ ok: false, error: "invalid" }); // sin https
    expect(await saveReviewSettings(dbs.app.db, w.owner, { ...ok, url: "https://evil.example/review" })).toMatchObject({ ok: false, error: "invalid" }); // no es de Google
    expect(await saveReviewSettings(dbs.app.db, w.owner, { ...ok, url: "javascript:alert(1)" })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveReviewSettings(dbs.app.db, w.owner, { ...ok, url: "" })).toMatchObject({ ok: false, error: "invalid" }); // encendida sin enlace
    expect(await saveReviewSettings(dbs.app.db, w.owner, { ...ok, hoursAfter: 0 })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveReviewSettings(dbs.app.db, w.owner, { ...ok, hoursAfter: 100 })).toMatchObject({ ok: false, error: "invalid" });
    expect(await saveReviewSettings(dbs.app.db, w.owner, { ...ok, platform: "facebook" })).toMatchObject({ ok: false, error: "invalid" }); // enlace de Google con "Facebook"
    expect(await saveReviewSettings(dbs.app.db, w.owner, { ...ok, platform: "other", url: "https://www.doctoralia.com.mx/clinica/resena" })).toEqual({ ok: true, needsTemplate: true });
    expect(await saveReviewSettings(dbs.app.db, w.owner, { ...ok, platform: "facebook", url: "https://www.facebook.com/ClinicaSonrisa/reviews" })).toMatchObject({ ok: true });
    expect(await saveReviewSettings(dbs.app.db, w.owner, ok)).toMatchObject({ ok: true });
    expect(await getReviewSettings(dbs.app.db, w.owner)).toMatchObject({ enabled: true, hoursAfter: 3, platform: "google", url: "https://g.page/r/CabcDEF/review", hasWhatsApp: true });
    // Apagada no necesita enlace.
    expect(await saveReviewSettings(dbs.app.db, w.owner, { enabled: false, hoursAfter: 3, platform: "google", url: "" })).toEqual({ ok: true, needsTemplate: false });
  });

  it("al encenderla solo cuentan las citas que terminen desde ese momento (no las ya pasadas) y reencender mantiene la fecha", async () => {
    const w = await world();
    const t0 = new Date("2027-03-02T10:00:00Z");
    const on = { enabled: true, hoursAfter: 3, platform: "google", url: "https://g.page/r/x/review" };
    await saveReviewSettings(dbs.app.db, w.owner, on, t0);
    const read = async () => (await dbs.owner.db.select().from(reviewSettings).where(eq(reviewSettings.tenantId, w.tenantId)))[0]!;
    expect((await read()).enabledAt?.toISOString()).toBe(t0.toISOString());
    // Guardar otra vez (sigue encendida) no mueve la fecha; apagar y volver a encender, si.
    await saveReviewSettings(dbs.app.db, w.owner, { ...on, hoursAfter: 5 }, new Date("2027-03-05T10:00:00Z"));
    expect((await read()).enabledAt?.toISOString()).toBe(t0.toISOString());
    await saveReviewSettings(dbs.app.db, w.owner, { ...on, enabled: false }, new Date("2027-03-06T10:00:00Z"));
    const t2 = new Date("2027-03-10T10:00:00Z");
    await saveReviewSettings(dbs.app.db, w.owner, on, t2);
    expect((await read()).enabledAt?.toISOString()).toBe(t2.toISOString());
  });
});

describe("correo (Brevo)", () => {
  it("se activa solo con clave y remitente validos", () => {
    expect(emailDepsFromEnv({})).toBeNull();
    expect(emailDepsFromEnv({ BREVO_API_KEY: "k" })).toBeNull();
    expect(emailDepsFromEnv({ BREVO_API_KEY: "k", EMAIL_FROM: "no-es-correo" })).toBeNull();
    expect(emailDepsFromEnv({ BREVO_API_KEY: "k", EMAIL_FROM: "avisos@tamia.com.mx" })).toEqual({ apiKey: "k", fromEmail: "avisos@tamia.com.mx", fromName: "Tamia" });
  });

  it("manda el correo a la API de Brevo y no filtra la clave en los errores", async () => {
    const deps = { apiKey: "SECRETA-123", fromEmail: "avisos@tamia.com.mx", fromName: "Tamia" };
    const ok = vi.fn(async () => new Response(JSON.stringify({ messageId: "m1" }), { status: 201 }));
    await sendEmail({ ...deps, fetch: ok as unknown as typeof fetch }, { to: "x@y.mx", subject: "Hola", text: "Texto" });
    const [url, init] = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("SECRETA-123");
    expect(JSON.parse(String(init.body))).toMatchObject({ sender: { email: "avisos@tamia.com.mx", name: "Tamia" }, to: [{ email: "x@y.mx" }], subject: "Hola", textContent: "Texto" });

    const rejected = vi.fn(async () => new Response(JSON.stringify({ message: "remitente no verificado" }), { status: 400 }));
    const err = (await sendEmail({ ...deps, fetch: rejected as unknown as typeof fetch }, { to: "x@y.mx", subject: "s", text: "t" }).catch((e) => e)) as EmailError;
    expect(err).toBeInstanceOf(EmailError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("remitente no verificado");
    expect(err.message).not.toContain("SECRETA");

    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await sendEmail({ ...deps, fetch: down as unknown as typeof fetch }, { to: "x@y.mx", subject: "s", text: "t" }).catch((e) => (e as EmailError).status)).toBe(0);
  });
});
