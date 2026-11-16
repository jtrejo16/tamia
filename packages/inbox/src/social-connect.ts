import { sealChannelCredentials } from "@empleado/channels";
import { auditLog, channels, withTenant, type Database } from "@empleado/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

/**
 * Conexion de Messenger e Instagram con "Iniciar sesion con Facebook":
 * el dueño autoriza, elegimos su pagina (y su cuenta de Instagram vinculada), guardamos el token
 * de la PAGINA cifrado y suscribimos la pagina a nuestro webhook. Nunca se pide ni se muestra un token.
 */
export interface SocialDeps {
  appId: string;
  /** App Secret de la app de Meta: solo viaja del servidor a Meta. */
  appSecret: string;
  /** Llave AES-256 para cifrar el token de la pagina. */
  key: Buffer;
  apiVersion?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Permisos que se piden. Sin pages_messaging / instagram_manage_messages no se pueden enviar mensajes. */
export const FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_messaging",
  "pages_manage_metadata",
  "instagram_basic",
  "instagram_manage_messages",
] as const;

export interface PageCandidate {
  pageId: string;
  name: string;
  /** Token de la PAGINA (no vence si se obtuvo de un token de usuario de larga duracion). */
  pageToken: string;
  instagram: { id: string; username: string | null } | null;
}

export type SocialConnectError = "forbidden" | "invalid" | "meta_rejected" | "meta_unavailable" | "already_connected" | "no_pages" | "not_found";

const graphBase = (d: SocialDeps) => `${(d.baseUrl ?? "https://graph.facebook.com").replace(/\/$/, "")}/${d.apiVersion ?? "v23.0"}`;

/** Direccion de Facebook donde el dueño autoriza. `state` lo firma quien llama (anti-CSRF). */
export function buildFacebookLoginUrl(d: Pick<SocialDeps, "appId" | "apiVersion">, input: { redirectUri: string; state: string }): string {
  const u = new URL(`https://www.facebook.com/${d.apiVersion ?? "v23.0"}/dialog/oauth`);
  u.searchParams.set("client_id", d.appId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("state", input.state);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", FACEBOOK_SCOPES.join(","));
  return u.toString();
}

class MetaCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(d: SocialDeps, method: "GET" | "POST", path: string, opts: { token?: string; form?: Record<string, string> } = {}): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await (d.fetch ?? fetch)(`${graphBase(d)}/${path}`, {
      method,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: opts.form ? new URLSearchParams(opts.form).toString() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new MetaCallError("sin conexion con Meta", 0);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || json.error) throw new MetaCallError(json.error?.message ?? `Meta respondio ${res.status}`, res.status);
  return json;
}

const metaFailure = (e: unknown): Failure<"meta_rejected" | "meta_unavailable"> | null =>
  e instanceof MetaCallError ? fail(e.status === 0 || e.status >= 500 ? "meta_unavailable" : "meta_rejected") : null;

/**
 * Cambia el codigo de autorizacion por las paginas del usuario con su token. Pasos: codigo -> token
 * de usuario -> token de larga duracion -> paginas (cada una con su token, que no vence).
 */
export async function fetchPagesForCode(
  d: SocialDeps,
  input: { code: string; redirectUri: string },
): Promise<{ ok: true; pages: PageCandidate[] } | Failure<"meta_rejected" | "meta_unavailable" | "no_pages">> {
  try {
    const short = await call(d, "POST", "oauth/access_token", {
      form: { client_id: d.appId, client_secret: d.appSecret, redirect_uri: input.redirectUri, code: input.code },
    });
    const long = await call(d, "POST", "oauth/access_token", {
      form: { grant_type: "fb_exchange_token", client_id: d.appId, client_secret: d.appSecret, fb_exchange_token: String(short.access_token) },
    });
    const accounts = await call(d, "GET", "me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100", {
      token: String(long.access_token),
    });
    const pages: PageCandidate[] = (Array.isArray(accounts.data) ? accounts.data : [])
      .filter((p: any) => typeof p?.id === "string" && typeof p?.access_token === "string")
      .map((p: any) => ({
        pageId: p.id,
        name: String(p.name ?? p.id),
        pageToken: p.access_token,
        instagram: p.instagram_business_account?.id ? { id: String(p.instagram_business_account.id), username: p.instagram_business_account.username ?? null } : null,
      }));
    return pages.length > 0 ? { ok: true, pages } : fail("no_pages");
  } catch (e) {
    const f = metaFailure(e);
    if (f) return f;
    throw e;
  }
}

export interface SocialChannelView {
  type: "messenger" | "instagram";
  externalId: string;
  name: string | null;
  handle: string | null;
  status: "active" | "paused" | "error";
  hasToken: boolean;
}

const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });

export async function listSocialChannels(db: Database, ctx: PanelContext): Promise<SocialChannelView[]> {
  const all = await withTenant(db, scope(ctx), (tx) => tx.select().from(channels));
  return all
    .filter((c) => c.type === "messenger" || c.type === "instagram")
    .map((c) => {
      const meta = (c.meta ?? {}) as { name?: string; username?: string };
      return {
        type: c.type as "messenger" | "instagram",
        externalId: c.externalId,
        name: meta.name ?? null,
        handle: meta.username ?? null,
        status: c.status,
        hasToken: c.credentialsEnc !== null,
      };
    });
}

/**
 * Conecta la pagina elegida (y/o su Instagram). Solo dueño. Primero se suscribe la pagina a
 * nuestro webhook; si Meta lo rechaza no se guarda nada.
 */
export async function connectSocial(
  db: Database,
  d: SocialDeps,
  ctx: PanelContext,
  input: { page: PageCandidate; messenger: boolean; instagram: boolean },
): Promise<Success<{ connected: Array<"messenger" | "instagram"> }> | Failure<SocialConnectError>> {
  if (!can(ctx.role, "configure")) return fail("forbidden");
  const wantIg = input.instagram && input.page.instagram !== null;
  if (!input.messenger && !wantIg) return fail("invalid");

  try {
    // Mismos campos para ambos: Instagram usa la suscripcion de la pagina.
    await call(d, "POST", `${encodeURIComponent(input.page.pageId)}/subscribed_apps`, {
      token: input.page.pageToken,
      form: { subscribed_fields: "messages,messaging_postbacks" },
    });
  } catch (e) {
    const f = metaFailure(e);
    if (f) return f;
    throw e;
  }

  const targets: Array<{ type: "messenger" | "instagram"; externalId: string; meta: Record<string, string> }> = [];
  if (input.messenger) targets.push({ type: "messenger", externalId: input.page.pageId, meta: { name: input.page.name } });
  if (wantIg) targets.push({ type: "instagram", externalId: input.page.instagram!.id, meta: { name: input.page.name, ...(input.page.instagram!.username ? { username: input.page.instagram!.username } : {}) } });

  try {
    await withTenant(db, scope(ctx), async (tx) => {
      for (const t of targets) {
        const [existing] = await tx.select().from(channels).where(eq(channels.type, t.type)).limit(1);
        const channelId = existing?.id ?? randomUUID();
        const values = {
          externalId: t.externalId,
          meta: t.meta as never,
          credentialsEnc: sealChannelCredentials({ accessToken: input.page.pageToken }, d.key, ctx.tenantId, channelId),
          status: "active" as const,
          updatedAt: new Date(),
        };
        if (existing) await tx.update(channels).set(values).where(eq(channels.id, channelId));
        else await tx.insert(channels).values({ id: channelId, tenantId: ctx.tenantId, type: t.type, ...values });
        await tx.insert(auditLog).values({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          action: "channel.connect",
          entity: "channel",
          entityId: channelId,
          diff: { type: t.type, accountId: t.externalId } as never, // nunca el token
        });
      }
    });
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "23505") return fail("already_connected");
    throw error;
  }
  return { ok: true, connected: targets.map((t) => t.type) };
}

/** Desconecta Messenger o Instagram: borra el token guardado y pausa el canal. Solo dueño. */
export async function disconnectSocial(db: Database, ctx: PanelContext, type: unknown): Promise<Success | Failure<SocialConnectError>> {
  if (!can(ctx.role, "configure")) return fail("forbidden");
  if (type !== "messenger" && type !== "instagram") return fail("invalid");
  return withTenant(db, scope(ctx), async (tx) => {
    const [c] = await tx.select().from(channels).where(eq(channels.type, type)).limit(1);
    if (!c) return fail("not_found");
    await tx.update(channels).set({ credentialsEnc: null, status: "paused", updatedAt: new Date() }).where(eq(channels.id, c.id));
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: "channel.disconnect", entity: "channel", entityId: c.id });
    return { ok: true as const };
  });
}
