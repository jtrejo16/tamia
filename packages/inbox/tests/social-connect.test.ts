import { randomBytes } from "node:crypto";
import { auditLog, channels } from "@empleado/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildFacebookLoginUrl,
  connectSocial,
  disconnectSocial,
  fetchPagesForCode,
  listSocialChannels,
  loadChannelAccess,
  type PageCandidate,
  type SocialDeps,
} from "../src";
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
const unique = () => String(Math.floor(1e14 + Math.random() * 9e14));

type Call = { method: string; path: string; auth: string | null; form: URLSearchParams | null; url: string };
/** Meta falso: responde como la Graph API y registra lo que se le pide. */
function fakeMeta(over: { status?: number; error?: boolean; accounts?: unknown[] } = {}) {
  const calls: Call[] = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const auth = new Headers(init?.headers).get("authorization");
    const body = init?.body ? String(init.body) : null;
    calls.push({ method: init?.method ?? "GET", path: u.pathname.replace(/^\/v[\d.]+\//, ""), auth, form: body ? new URLSearchParams(body) : null, url: String(url) });
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (over.error) return json({ error: { message: "rechazado", code: 190 } }, over.status ?? 400);
    const path = u.pathname.replace(/^\/v[\d.]+\//, "");
    if (path === "oauth/access_token") {
      const grant = new URLSearchParams(body ?? "").get("grant_type");
      return json({ access_token: grant === "fb_exchange_token" ? "USER-LONG" : "USER-SHORT" });
    }
    if (path.startsWith("me/accounts")) {
      return json({
        data: over.accounts ?? [
          { id: "P1", name: "Clínica Sonrisa", access_token: "PAGE-TOKEN-1", instagram_business_account: { id: "IG1", username: "clinicasonrisa" } },
          { id: "P2", name: "Sin token", instagram_business_account: { id: "IG2" } },
          { id: "P3", name: "Solo página", access_token: "PAGE-TOKEN-3" },
        ],
      });
    }
    if (path.endsWith("/subscribed_apps")) return json({ success: true });
    return json({}, 404);
  }) as typeof fetch;
  const deps: SocialDeps = { appId: "APP-ID", appSecret: "APP-SECRET", key: KEY, fetch: fetchFake };
  return { deps, calls };
}

const page = (over: Partial<PageCandidate> = {}): PageCandidate => ({
  pageId: unique(),
  name: "Clínica Sonrisa",
  pageToken: "PAGE-TOKEN-" + unique(),
  instagram: { id: unique(), username: "clinicasonrisa" },
  ...over,
});

describe("Iniciar sesion con Facebook", () => {
  it("la direccion de autorizacion lleva app, permisos, state y la direccion de regreso", () => {
    const u = new URL(buildFacebookLoginUrl({ appId: "APP-ID" }, { redirectUri: "https://panel.test/api/channel/facebook/callback", state: "ESTADO" }));
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/v23.0/dialog/oauth");
    expect(u.searchParams.get("client_id")).toBe("APP-ID");
    expect(u.searchParams.get("state")).toBe("ESTADO");
    expect(u.searchParams.get("redirect_uri")).toBe("https://panel.test/api/channel/facebook/callback");
    expect(u.searchParams.get("scope")!.split(",")).toEqual(
      expect.arrayContaining(["pages_messaging", "pages_show_list", "pages_manage_metadata", "instagram_basic", "instagram_manage_messages"]),
    );
    expect(u.searchParams.get("response_type")).toBe("code");
  });

  it("codigo -> token de usuario -> de larga duracion -> paginas; el secreto va en el cuerpo, NUNCA en la URL", async () => {
    const { deps, calls } = fakeMeta();
    const r = await fetchPagesForCode(deps, { code: "CODIGO", redirectUri: "https://panel.test/cb" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.map((c) => `${c.method} ${c.path.split("?")[0]}`)).toEqual(["POST oauth/access_token", "POST oauth/access_token", "GET me/accounts"]);
    expect(calls[0]!.form!.get("code")).toBe("CODIGO");
    expect(calls[0]!.form!.get("client_secret")).toBe("APP-SECRET");
    expect(calls[1]!.form!.get("fb_exchange_token")).toBe("USER-SHORT");
    expect(calls[2]!.auth).toBe("Bearer USER-LONG");
    expect(calls.every((c) => !c.url.includes("APP-SECRET") && !c.url.includes("USER-"))).toBe(true);

    // se descartan las paginas sin token; Instagram solo si esta vinculado
    expect(r.pages.map((p) => p.pageId)).toEqual(["P1", "P3"]);
    expect(r.pages[0]).toMatchObject({ pageToken: "PAGE-TOKEN-1", instagram: { id: "IG1", username: "clinicasonrisa" } });
    expect(r.pages[1]!.instagram).toBeNull();
  });

  it("sin paginas administradas, Meta rechaza o cae: errores claros", async () => {
    expect(await fetchPagesForCode(fakeMeta({ accounts: [] }).deps, { code: "c", redirectUri: "r" })).toEqual({ ok: false, error: "no_pages" });
    expect(await fetchPagesForCode(fakeMeta({ error: true, status: 400 }).deps, { code: "c", redirectUri: "r" })).toEqual({ ok: false, error: "meta_rejected" });
    expect(await fetchPagesForCode(fakeMeta({ error: true, status: 503 }).deps, { code: "c", redirectUri: "r" })).toEqual({ ok: false, error: "meta_unavailable" });
  });
});

describe("conectar la pagina elegida", () => {
  it("suscribe la pagina al webhook CON SU token y conecta Messenger e Instagram con el token cifrado", async () => {
    const w = await world();
    const { deps, calls } = fakeMeta();
    const p = page();
    expect(await connectSocial(dbs.app.db, deps, w.owner, { page: p, messenger: true, instagram: true })).toEqual({ ok: true, connected: ["messenger", "instagram"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: `${p.pageId}/subscribed_apps`, auth: `Bearer ${p.pageToken}` });
    expect(calls[0]!.form!.get("subscribed_fields")).toBe("messages,messaging_postbacks");

    const rows = await dbs.owner.db.select().from(channels).where(and(eq(channels.tenantId, w.tenantId)));
    const social = rows.filter((r) => r.type !== "whatsapp");
    expect(social.map((r) => [r.type, r.externalId]).sort()).toEqual([["instagram", p.instagram!.id], ["messenger", p.pageId]].sort());
    for (const r of social) {
      expect(r.credentialsEnc!.toString("utf8")).not.toContain(p.pageToken); // cifrado
      expect((await loadChannelAccess(dbs.app.db, KEY, w.tenantId, r.id))?.accessToken).toBe(p.pageToken);
    }

    const view = await listSocialChannels(dbs.app.db, w.owner);
    expect(view.map((v) => [v.type, v.name, v.handle, v.hasToken])).toEqual(
      expect.arrayContaining([["messenger", "Clínica Sonrisa", null, true], ["instagram", "Clínica Sonrisa", "clinicasonrisa", true]]),
    );
    expect(JSON.stringify(view)).not.toContain(p.pageToken);

    const audit = await dbs.owner.db.select().from(auditLog).where(eq(auditLog.tenantId, w.tenantId));
    expect(audit.filter((a) => a.action === "channel.connect")).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(p.pageToken);
  });

  it("solo Messenger, o Instagram sin cuenta vinculada: no inventa canales", async () => {
    const w = await world();
    const { deps } = fakeMeta();
    const noIg = page({ instagram: null });
    expect(await connectSocial(dbs.app.db, deps, w.owner, { page: noIg, messenger: true, instagram: true })).toEqual({ ok: true, connected: ["messenger"] });
    const w2 = await world();
    expect(await connectSocial(dbs.app.db, deps, w2.owner, { page: noIg, messenger: false, instagram: true })).toEqual({ ok: false, error: "invalid" });
    expect(await connectSocial(dbs.app.db, deps, w2.owner, { page: page(), messenger: false, instagram: false })).toEqual({ ok: false, error: "invalid" });
  });

  it("solo el dueño conecta o desconecta", async () => {
    const w = await world();
    const { deps, calls } = fakeMeta();
    expect(await connectSocial(dbs.app.db, deps, w.agent, { page: page(), messenger: true, instagram: false })).toEqual({ ok: false, error: "forbidden" });
    expect(await connectSocial(dbs.app.db, deps, w.viewer, { page: page(), messenger: true, instagram: false })).toEqual({ ok: false, error: "forbidden" });
    expect(await disconnectSocial(dbs.app.db, w.agent, "messenger")).toEqual({ ok: false, error: "forbidden" });
    expect(calls).toHaveLength(0);
  });

  it("si Meta rechaza la suscripcion de la pagina, NO se guarda nada", async () => {
    const w = await world();
    expect(await connectSocial(dbs.app.db, fakeMeta({ error: true, status: 400 }).deps, w.owner, { page: page(), messenger: true, instagram: true })).toEqual({ ok: false, error: "meta_rejected" });
    expect(await connectSocial(dbs.app.db, fakeMeta({ error: true, status: 500 }).deps, w.owner, { page: page(), messenger: true, instagram: true })).toEqual({ ok: false, error: "meta_unavailable" });
    expect(await listSocialChannels(dbs.app.db, w.owner)).toEqual([]);
  });

  it("una pagina ya conectada en OTRO negocio se rechaza sin tocar al primero", async () => {
    const a = await world();
    const b = await world();
    const { deps } = fakeMeta();
    const p = page();
    expect((await connectSocial(dbs.app.db, deps, a.owner, { page: p, messenger: true, instagram: false })).ok).toBe(true);
    expect(await connectSocial(dbs.app.db, deps, b.owner, { page: p, messenger: true, instagram: false })).toEqual({ ok: false, error: "already_connected" });
    expect(await listSocialChannels(dbs.app.db, b.owner)).toEqual([]);
    expect((await listSocialChannels(dbs.app.db, a.owner)).map((c) => c.externalId)).toEqual([p.pageId]);
  });

  it("reconectar otra pagina reemplaza el canal del mismo tipo (no duplica) y desconectar borra la clave", async () => {
    const w = await world();
    const { deps } = fakeMeta();
    await connectSocial(dbs.app.db, deps, w.owner, { page: page(), messenger: true, instagram: false });
    const second = page({ name: "Otra página" });
    await connectSocial(dbs.app.db, deps, w.owner, { page: second, messenger: true, instagram: false });
    const messengers = (await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, w.tenantId))).filter((c) => c.type === "messenger");
    expect(messengers).toHaveLength(1);
    expect(messengers[0]!.externalId).toBe(second.pageId);

    expect(await disconnectSocial(dbs.app.db, w.owner, "messenger")).toEqual({ ok: true });
    const [row] = (await dbs.owner.db.select().from(channels).where(eq(channels.tenantId, w.tenantId))).filter((c) => c.type === "messenger");
    expect(row).toMatchObject({ credentialsEnc: null, status: "paused" });
    expect(await disconnectSocial(dbs.app.db, w.owner, "tiktok")).toEqual({ ok: false, error: "invalid" });
    expect(await disconnectSocial(dbs.app.db, w.owner, "instagram")).toEqual({ ok: false, error: "not_found" });
  });
});
