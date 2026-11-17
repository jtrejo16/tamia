import { appointments, calendarConnections } from "@empleado/db";
import { parseKey } from "@empleado/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildGoogleAuthUrl,
  connectGoogleCalendar,
  disconnectGoogleCalendar,
  getCalendarConnection,
  syncAppointmentsToGoogle,
  type GoogleDeps,
} from "../src";
import { TUESDAY_10, dropWorld, env, makeWorld, openDbs, type Dbs, type World } from "./helpers";

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

const uid = () => Math.random().toString(36).slice(2, 10);
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.y`;

interface Call {
  method: string;
  url: string;
  body: any;
  auth?: string | null;
}

/** Google falso: OAuth + eventos. `mode` permite simular fallas. */
function fakeGoogle(opts: { refresh?: boolean; revoked?: boolean; patch404?: boolean; insert400?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const raw = init?.body ? String(init.body) : "";
    const body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, url: `${u.origin}${u.pathname}`, body, auth: new Headers(init?.headers).get("authorization") });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (u.pathname === "/token") {
      if (body.grant_type === "authorization_code")
        return json({ access_token: "at", id_token: idToken("doctora@gmail.com"), ...(opts.refresh === false ? {} : { refresh_token: "RT-secreto-123" }) });
      if (opts.revoked) return json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
      return json({ access_token: "access-" + uid() });
    }
    if (u.pathname === "/revoke") return json({});
    if (u.pathname.includes("/events")) {
      if (method === "POST") return opts.insert400 ? json({ error: { message: "Invalid value", errors: [{ reason: "invalid" }] } }, 400) : json({ id: `ev_${uid()}` });
      if (method === "PATCH") return opts.patch404 ? json({ error: { message: "Not Found" } }, 404) : json({});
      if (method === "DELETE") return new Response(null, { status: 204 });
    }
    return json({}, 404);
  }) as typeof fetch;
  const deps: GoogleDeps = {
    clientId: "cid",
    clientSecret: "csecret",
    key: parseKey(env("ENCRYPTION_KEY")),
    fetch: fetchFake,
    tokenUrl: "https://g.test/token",
    apiUrl: "https://g.test/calendar/v3",
  };
  return { deps, calls, events: () => calls.filter((c) => c.url.includes("/events")) };
}

async function connectedWorld(g: ReturnType<typeof fakeGoogle>) {
  const w = await makeWorld(dbs.owner);
  worlds.push(w);
  const r = await connectGoogleCalendar(dbs.app.db, g.deps, w.owner, { code: "code", redirectUri: "https://panel.test/cb" });
  expect(r).toEqual({ ok: true });
  return w;
}

async function addAppt(w: World, status: "confirmed" | "pending" = "confirmed", startsAt = TUESDAY_10) {
  const start = new Date(startsAt);
  const [a] = await dbs.owner.db
    .insert(appointments)
    .values({ tenantId: w.tenantId, contactId: w.contactId, serviceId: w.serviceId, staffId: w.staffId, startsAt: start, endsAt: new Date(start.getTime() + 45 * 60_000), status })
    .returning();
  return a!;
}
const reload = async (id: string) => (await dbs.owner.db.select().from(appointments).where(eq(appointments.id, id)))[0]!;

describe("Google Calendar: conectar", () => {
  it("la direccion de autorizacion pide acceso offline y solo eventos", () => {
    const url = new URL(buildGoogleAuthUrl({ clientId: "cid" }, { redirectUri: "https://panel.test/cb", state: "S" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("S");
    expect(url.searchParams.get("scope")).toContain("calendar.events");
  });

  it("guarda el permiso CIFRADO y muestra la cuenta; solo el dueño conecta", async () => {
    const g = fakeGoogle();
    const w = await makeWorld(dbs.owner);
    worlds.push(w);
    const args = { code: "code", redirectUri: "https://panel.test/cb" };

    expect(await connectGoogleCalendar(dbs.app.db, g.deps, w.agent, args)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await connectGoogleCalendar(dbs.app.db, g.deps, w.owner, args)).toEqual({ ok: true });

    const [row] = await dbs.owner.db.select().from(calendarConnections).where(eq(calendarConnections.tenantId, w.tenantId));
    expect(row!.refreshTokenEnc.toString("utf8")).not.toContain("RT-secreto-123");
    expect(await getCalendarConnection(dbs.app.db, w.owner)).toMatchObject({ connected: true, accountEmail: "doctora@gmail.com", status: "active" });
  });

  it("si Google no entrega permiso permanente, lo dice y no guarda nada", async () => {
    const g = fakeGoogle({ refresh: false });
    const w = await makeWorld(dbs.owner);
    worlds.push(w);
    expect(await connectGoogleCalendar(dbs.app.db, g.deps, w.owner, { code: "c", redirectUri: "https://panel.test/cb" })).toMatchObject({ ok: false, error: "no_refresh_token" });
    expect((await getCalendarConnection(dbs.app.db, w.owner)).connected).toBe(false);
  });

  it("un negocio no ve la conexion de otro", async () => {
    const g = fakeGoogle();
    const a = await connectedWorld(g);
    const b = await makeWorld(dbs.owner);
    worlds.push(b);
    expect((await getCalendarConnection(dbs.app.db, b.owner)).connected).toBe(false);
    expect((await getCalendarConnection(dbs.app.db, a.owner)).connected).toBe(true);
  });
});

describe("Google Calendar: sincronizar citas", () => {
  it("crea el evento al confirmar, lo mueve al cambiar de hora y lo borra al cancelar", async () => {
    const g = fakeGoogle();
    const w = await connectedWorld(g);
    const a = await addAppt(w);

    const r1 = await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    expect(r1.created).toBeGreaterThanOrEqual(1);
    const created = g.events().find((c) => c.method === "POST")!;
    expect(created.auth).toMatch(/^Bearer access-/);
    expect(created.body).toMatchObject({ summary: "Limpieza dental — Carlos Pérez", start: { timeZone: "America/Merida" } });
    expect(created.body.description).toContain("Dra. Ruiz");
    const synced = await reload(a.id);
    expect(synced.calendarEventId).toMatch(/^ev_/);
    expect(synced.calendarSyncedAt).not.toBeNull();

    // Sin cambios: no vuelve a tocar Google.
    const before = g.events().length;
    await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    expect(g.events().length).toBe(before);

    // Cambio de hora -> PATCH al mismo evento.
    await dbs.owner.db
      .update(appointments)
      .set({ startsAt: new Date("2027-03-02T17:00:00Z"), endsAt: new Date("2027-03-02T17:45:00Z"), updatedAt: new Date(Date.now() + 5_000) })
      .where(eq(appointments.id, a.id));
    await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    const patch = g.events().find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain(encodeURIComponent(synced.calendarEventId!));
    expect(patch.body.start.dateTime).toBe("2027-03-02T17:00:00.000Z");

    // Cancelada -> DELETE y se olvida el id.
    await dbs.owner.db.update(appointments).set({ status: "cancelled", updatedAt: new Date(Date.now() + 10_000) }).where(eq(appointments.id, a.id));
    await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    expect(g.events().some((c) => c.method === "DELETE")).toBe(true);
    expect((await reload(a.id)).calendarEventId).toBeNull();
  });

  it("las citas pendientes (sin confirmar) y las de otro negocio sin calendario no se reflejan", async () => {
    const g = fakeGoogle();
    const w = await connectedWorld(g);
    const pending = await addAppt(w, "pending");
    const other = await makeWorld(dbs.owner); // sin calendario
    worlds.push(other);
    const foreign = await addAppt(other);

    await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    expect((await reload(pending.id)).calendarEventId).toBeNull();
    expect((await reload(foreign.id)).calendarEventId).toBeNull();
  });

  it("si el evento se borro a mano en Google, se vuelve a crear", async () => {
    const g = fakeGoogle({ patch404: true });
    const w = await connectedWorld(g);
    const a = await addAppt(w);
    await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    const first = (await reload(a.id)).calendarEventId;

    await dbs.owner.db.update(appointments).set({ updatedAt: new Date(Date.now() + 5_000) }).where(eq(appointments.id, a.id));
    await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    const second = (await reload(a.id)).calendarEventId;
    expect(second).toMatch(/^ev_/);
    expect(second).not.toBe(first);
  });

  it("si Google revoco el permiso, la conexion queda en error (a reconectar) y no se reintenta", async () => {
    const g = fakeGoogle({ revoked: true });
    const w = await connectedWorld(g);
    await addAppt(w);
    const r = await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    expect(r.errors).toBeGreaterThanOrEqual(1);
    expect(await getCalendarConnection(dbs.app.db, w.owner)).toMatchObject({ status: "error" });

    const before = g.calls.length;
    await syncAppointmentsToGoogle(dbs.app.db, g.deps); // ya no es "activa": ni se intenta
    expect(g.calls.length).toBe(before);
  });

  it("si Google rechaza los datos de una cita, no se reintenta cada minuto y se deja el motivo", async () => {
    const g = fakeGoogle({ insert400: true });
    const w = await connectedWorld(g);
    const a = await addAppt(w);
    await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    expect((await getCalendarConnection(dbs.app.db, w.owner)).lastError).toContain("No se pudo reflejar");
    const before = g.events().length;
    await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    expect(g.events().length).toBe(before);
    expect((await reload(a.id)).calendarEventId).toBeNull();
  });
});

describe("Google Calendar: desconectar", () => {
  it("quita la conexion, revoca el permiso y deja las citas listas para una cuenta nueva", async () => {
    const g = fakeGoogle();
    const w = await connectedWorld(g);
    const a = await addAppt(w);
    await syncAppointmentsToGoogle(dbs.app.db, g.deps);
    expect((await reload(a.id)).calendarEventId).not.toBeNull();

    expect(await disconnectGoogleCalendar(dbs.app.db, g.deps, w.agent)).toMatchObject({ ok: false, error: "forbidden" });
    expect(await disconnectGoogleCalendar(dbs.app.db, g.deps, w.owner)).toEqual({ ok: true });
    expect((await getCalendarConnection(dbs.app.db, w.owner)).connected).toBe(false);
    expect(g.calls.some((c) => c.url.endsWith("/revoke"))).toBe(true);
    expect(await reload(a.id)).toMatchObject({ calendarEventId: null, calendarSyncedAt: null });
  });
});
