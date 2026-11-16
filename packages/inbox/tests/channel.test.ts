import { randomBytes } from "node:crypto";
import { auditLog, channels } from "@empleado/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectChannel, disconnectChannel, getChannel, loadChannelAccess } from "../src";
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

const world = async () => {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  return w;
};
const unique = () => String(Math.floor(1e12 + Math.random() * 9e12));
const TOKEN = "EAAG" + "x".repeat(60);

/** Graph API falso: valida el token como lo haria Meta y registra lo que se le pide. */
function fakeGraph(behavior: { status?: number; error?: { code: number; message: string }; validToken?: string } = {}) {
  const calls: Array<{ method: string; path: string; auth: string | null }> = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method: init?.method ?? "GET", path: u.pathname, auth });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (behavior.error) return json({ error: behavior.error }, behavior.status ?? 400);
    if (behavior.validToken && auth !== `Bearer ${behavior.validToken}`) return json({ error: { code: 190, message: "Invalid OAuth access token" } }, 401);
    if (u.pathname.endsWith("/subscribed_apps")) return json({ success: true });
    return json({ display_phone_number: "+52 998 123 4567", verified_name: "Clínica Álamo", quality_rating: "GREEN" });
  }) as typeof fetch;
  return { deps: { key: KEY, fetch: fetchFake }, calls };
}

const input = (over: Record<string, string> = {}) => ({ phoneNumberId: unique(), wabaId: unique(), accessToken: TOKEN, ...over });

describe("conectar el WhatsApp del negocio desde el panel", () => {
  it("comprueba con Meta, suscribe la app, guarda la clave CIFRADA y no la devuelve nunca", async () => {
    const w = await world();
    const { deps, calls } = fakeGraph({ validToken: TOKEN });
    const data = input();
    const res = await connectChannel(dbs.app.db, deps, w.owner, data);
    expect(res).toEqual({ ok: true, displayPhone: "+52 998 123 4567", verifiedName: "Clínica Álamo" });

    // Preguntó por ese numero y suscribio la cuenta, siempre con la clave del cliente.
    expect(calls.map((c) => `${c.method} ${c.path.split("/").slice(2).join("/")}`)).toEqual([`GET ${data.phoneNumberId}`, `POST ${data.wabaId}/subscribed_apps`]);
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);

    const [row] = await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, w.tenantId));
    expect(row).toMatchObject({ externalId: data.phoneNumberId, wabaId: data.wabaId, displayPhone: "+52 998 123 4567", status: "active", qualityRating: "GREEN" });
    expect(row!.credentialsEnc!.toString("utf8")).not.toContain(TOKEN); // cifrada, no en claro
    const access = await loadChannelAccess(dbs.app.db, KEY, w.tenantId, row!.id);
    expect(access?.accessToken).toBe(TOKEN); // y se puede abrir con la llave

    const view = await getChannel(dbs.app.db, w.owner);
    expect(view).toMatchObject({ connected: true, hasToken: true, phoneNumberId: data.phoneNumberId });
    expect(JSON.stringify(view)).not.toContain(TOKEN);

    // La bitacora dice que se conecto, pero jamas guarda la clave.
    const audit = await dbs.owner.db.select().from(auditLog).where(eq(auditLog.tenantId, w.tenantId));
    const entry = audit.find((a) => a.action === "channel.connect");
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it("reemplaza el canal existente (mismo registro, nuevo numero y clave)", async () => {
    const w = await world();
    const [before] = await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, w.tenantId));
    const { deps } = fakeGraph();
    const data = input();
    expect((await connectChannel(dbs.app.db, deps, w.owner, data)).ok).toBe(true);
    const rows = await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, w.tenantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before!.id);
    expect(rows[0]!.externalId).toBe(data.phoneNumberId);
  });

  it("si Meta rechaza la clave, NO se guarda nada", async () => {
    const w = await world();
    const { deps } = fakeGraph({ validToken: "OTRA-CLAVE" });
    const before = (await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, w.tenantId)))[0]!;
    expect(await connectChannel(dbs.app.db, deps, w.owner, input())).toEqual({ ok: false, error: "meta_rejected" });
    const after = (await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, w.tenantId)))[0]!;
    expect(after.externalId).toBe(before.externalId);
    expect(after.credentialsEnc).toEqual(before.credentialsEnc);
  });

  it("si Meta no responde (error de servidor) se avisa como no disponible", async () => {
    const w = await world();
    const { deps } = fakeGraph({ status: 500, error: { code: 2, message: "Service temporarily unavailable" } });
    expect(await connectChannel(dbs.app.db, deps, w.owner, input())).toEqual({ ok: false, error: "meta_unavailable" });
  });

  it("solo el dueño conecta o desconecta; los datos se validan antes de llamar a Meta", async () => {
    const w = await world();
    const { deps, calls } = fakeGraph();
    expect(await connectChannel(dbs.app.db, deps, w.agent, input())).toEqual({ ok: false, error: "forbidden" });
    expect(await connectChannel(dbs.app.db, deps, w.viewer, input())).toEqual({ ok: false, error: "forbidden" });
    expect(await disconnectChannel(dbs.app.db, w.agent)).toEqual({ ok: false, error: "forbidden" });

    const bad = await connectChannel(dbs.app.db, deps, w.owner, { phoneNumberId: "abc", wabaId: "", accessToken: "corta con espacios" });
    expect(bad).toMatchObject({ ok: false, error: "invalid" });
    expect((bad as { details: string[] }).details.length).toBeGreaterThanOrEqual(3);
    expect(calls).toHaveLength(0); // no se molesto a Meta con datos invalidos
  });

  it("un numero que ya esta conectado en OTRO negocio se rechaza sin tocar al primero", async () => {
    const a = await world();
    const b = await world();
    const { deps } = fakeGraph();
    const data = input();
    expect((await connectChannel(dbs.app.db, deps, a.owner, data)).ok).toBe(true);
    expect(await connectChannel(dbs.app.db, deps, b.owner, data)).toEqual({ ok: false, error: "already_connected" });
    const [rowA] = await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, a.tenantId));
    expect(rowA!.externalId).toBe(data.phoneNumberId);
    const [rowB] = await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, b.tenantId));
    expect(rowB!.externalId).not.toBe(data.phoneNumberId);
  });

  it("desconectar borra la clave guardada y pausa el canal", async () => {
    const w = await world();
    const { deps } = fakeGraph();
    await connectChannel(dbs.app.db, deps, w.owner, input());
    expect(await disconnectChannel(dbs.app.db, w.owner)).toEqual({ ok: true });
    const [row] = await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, w.tenantId));
    expect(row).toMatchObject({ credentialsEnc: null, status: "paused" });
    expect(await getChannel(dbs.app.db, w.owner)).toMatchObject({ connected: false, hasToken: false });
  });
});
