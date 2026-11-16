import { randomBytes } from "node:crypto";
import { REMINDER_TEMPLATES, sealChannelCredentials } from "@empleado/channels";
import { channels, templates } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createReminderTemplates, listTemplates, syncTemplates } from "../src";
import { dropWorld, makeWorld, openDbs, type Dbs, type World } from "./helpers";

let dbs: Dbs;
const worlds: World[] = [];
const KEY = randomBytes(32);

beforeAll(() => {
  dbs = openDbs();
});
afterAll(async () => {
  for (const w of worlds) await dropWorld(dbs.owner, w);
  await dbs.app.close();
  await dbs.owner.close();
});

async function world(options: { token?: boolean; waba?: boolean } = {}) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  await dbs.owner.db
    .update(channels)
    .set({
      wabaId: options.waba === false ? null : "WABA-TEST",
      ...(options.token === false ? {} : { credentialsEnc: sealChannelCredentials({ accessToken: "EAAG-token-de-prueba" }, KEY, w.tenantId, w.channelId) }),
    })
    .where(eq(channels.id, w.channelId));
  return w;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Meta falso: GET lista lo que se le diga; POST crea y devuelve un id. */
function fakeMeta(remote: Array<Record<string, unknown>> = []) {
  let n = 100;
  const posted: Array<Record<string, unknown>> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push(JSON.parse(init.body as string));
      return json({ id: String(++n), status: "PENDING", category: "UTILITY" });
    }
    return json({ data: remote });
  });
  return { fetchMock: fetchMock as unknown as typeof fetch, posted, raw: fetchMock };
}

const deps = (fetchImpl: typeof fetch) => ({ key: KEY, fetch: fetchImpl });

describe("sincronizar plantillas con Meta", () => {
  it("guarda las plantillas remotas y despues solo cuenta los cambios de estado", async () => {
    const w = await world();
    const meta = fakeMeta([
      { id: "1", name: "recordatorio_cita_24h", language: "es_MX", status: "PENDING", category: "UTILITY" },
      { id: "2", name: "promo_verano", language: "es_MX", status: "REJECTED", category: "MARKETING" },
    ]);
    expect(await syncTemplates(dbs.app.db, deps(meta.fetchMock), w.tenantId)).toEqual({ ok: true, synced: 2, total: 2 });
    expect(await syncTemplates(dbs.app.db, deps(meta.fetchMock), w.tenantId)).toEqual({ ok: true, synced: 0, total: 2 });

    // Meta aprueba la primera: es el unico cambio.
    const approved = fakeMeta([
      { id: "1", name: "recordatorio_cita_24h", language: "es_MX", status: "APPROVED", category: "UTILITY" },
      { id: "2", name: "promo_verano", language: "es_MX", status: "REJECTED", category: "MARKETING" },
    ]);
    expect(await syncTemplates(dbs.app.db, deps(approved.fetchMock), w.tenantId)).toEqual({ ok: true, synced: 1, total: 2 });

    const rows = await dbs.owner.db.select().from(templates).where(eq(templates.tenantId, w.tenantId));
    expect(Object.fromEntries(rows.map((r) => [r.name, [r.status, r.category]]))).toEqual({
      recordatorio_cita_24h: ["approved", "utility"],
      promo_verano: ["rejected", "marketing"],
    });
  });

  it("usa el token del canal y la cuenta de WhatsApp correcta", async () => {
    const w = await world();
    const meta = fakeMeta([]);
    await syncTemplates(dbs.app.db, deps(meta.fetchMock), w.tenantId);
    const [url, init] = meta.raw.mock.calls[0]!;
    expect(String(url)).toContain("/WABA-TEST/message_templates");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer EAAG-token-de-prueba");
  });

  it("explica por que no puede: sin token, sin cuenta, Meta rechaza o esta caido", async () => {
    const noToken = await world({ token: false });
    expect(await syncTemplates(dbs.app.db, deps(fakeMeta().fetchMock), noToken.tenantId)).toMatchObject({ ok: false, error: "no_token" });

    const noWaba = await world({ waba: false });
    expect(await syncTemplates(dbs.app.db, deps(fakeMeta().fetchMock), noWaba.tenantId)).toMatchObject({ ok: false, error: "no_waba" });

    const w = await world();
    const rejected = vi.fn().mockResolvedValue(json({ error: { message: "Invalid OAuth", code: 190 } }, 401)) as unknown as typeof fetch;
    expect(await syncTemplates(dbs.app.db, deps(rejected), w.tenantId)).toMatchObject({ ok: false, error: "meta_rejected" });
    const down = vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
    expect(await syncTemplates(dbs.app.db, deps(down), w.tenantId)).toMatchObject({ ok: false, error: "meta_unavailable" });
  });

  it("un negocio no toca las plantillas ni el canal de otro", async () => {
    const a = await world();
    const b = await world();
    const meta = fakeMeta([{ id: "1", name: "solo_de_a", language: "es_MX", status: "APPROVED", category: "UTILITY" }]);
    await syncTemplates(dbs.app.db, deps(meta.fetchMock), a.tenantId);
    expect(await listTemplates(dbs.app.db, b.owner)).toHaveLength(0);
    expect((await listTemplates(dbs.app.db, a.owner)).map((t) => t.name)).toEqual(["solo_de_a"]);
  });
});

describe("crear las plantillas de recordatorio", () => {
  it("crea las dos en Meta (24 h y 2 h) con botones, y quedan pendientes de revision", async () => {
    const w = await world();
    const meta = fakeMeta([]);
    const r = await createReminderTemplates(dbs.app.db, deps(meta.fetchMock), w.owner);
    expect(r).toEqual({ ok: true, created: ["recordatorio_cita_24h", "recordatorio_cita_2h"], existing: [] });

    expect(meta.posted.map((p) => p.name)).toEqual(["recordatorio_cita_24h", "recordatorio_cita_2h"]);
    for (const p of meta.posted) {
      expect(p).toMatchObject({ language: "es_MX", category: "UTILITY" });
      expect((p.components as Array<{ type: string }>).map((c) => c.type)).toEqual(["BODY", "BUTTONS"]);
    }

    const list = await listTemplates(dbs.app.db, w.owner);
    expect(list.map((t) => [t.name, t.status, t.isReminder])).toEqual([
      ["recordatorio_cita_24h", "pending", true],
      ["recordatorio_cita_2h", "pending", true],
    ]);
    expect(list[0]!.bodyText).toBe(REMINDER_TEMPLATES["24h"].body);
  });

  it("es idempotente: si ya existen en Meta (en cualquier estado) no las vuelve a crear", async () => {
    const w = await world();
    const meta = fakeMeta([
      { id: "1", name: "recordatorio_cita_24h", language: "es_MX", status: "APPROVED", category: "UTILITY" },
      { id: "2", name: "recordatorio_cita_2h", language: "es_MX", status: "REJECTED", category: "UTILITY" },
    ]);
    const r = await createReminderTemplates(dbs.app.db, deps(meta.fetchMock), w.owner);
    expect(r).toEqual({ ok: true, created: [], existing: ["recordatorio_cita_24h", "recordatorio_cita_2h"] });
    expect(meta.posted).toHaveLength(0);
    const statuses = Object.fromEntries((await listTemplates(dbs.app.db, w.owner)).map((t) => [t.name, t.status]));
    expect(statuses).toEqual({ recordatorio_cita_24h: "approved", recordatorio_cita_2h: "rejected" });
  });

  it("solo el dueño puede crearlas", async () => {
    const w = await world();
    const meta = fakeMeta([]);
    for (const ctx of [w.agent, w.viewer]) {
      expect(await createReminderTemplates(dbs.app.db, deps(meta.fetchMock), ctx)).toEqual({ ok: false, error: "forbidden" });
    }
    expect(meta.posted).toHaveLength(0);
  });

  it("si Meta rechaza la creacion, lo dice con el motivo y no deja basura a medias", async () => {
    const w = await world();
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: { message: "Invalid parameter", code: 100, error_user_msg: "El cuerpo no puede terminar con una variable" } }, 400) : json({ data: [] }),
    ) as unknown as typeof fetch;
    const r = await createReminderTemplates(dbs.app.db, deps(fetchImpl), w.owner);
    expect(r).toMatchObject({ ok: false, error: "meta_rejected" });
    expect((r as { details?: string }).details).toContain("El cuerpo no puede terminar con una variable");
    expect(await listTemplates(dbs.app.db, w.owner)).toHaveLength(0);
  });
});
