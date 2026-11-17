import {
  appointments,
  auditLog,
  calendarConnections,
  calendarDueAppointments,
  contacts,
  services,
  staff,
  tenants,
  withTenant,
  type Database,
} from "@empleado/db";
import { decryptSecret, encryptSecret } from "@empleado/shared";
import { eq, sql } from "drizzle-orm";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

/**
 * Google Calendar: cada negocio conecta SU calendario (OAuth) y las citas confirmadas se reflejan como
 * eventos (crear / mover / borrar). Un sentido: el sistema manda, Google solo muestra.
 * Permiso pedido: calendar.events (leer y escribir eventos) + correo para mostrar la cuenta.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "openid", "email"];

export interface GoogleDeps {
  clientId: string;
  clientSecret: string;
  /** Llave de cifrado (ENCRYPTION_KEY ya convertida a 32 bytes). */
  key: Buffer;
  fetch?: typeof fetch;
  /** Para pruebas. */
  authUrl?: string;
  tokenUrl?: string;
  apiUrl?: string;
}

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Codigo de OAuth (por ejemplo "invalid_grant") o de la API, si Google lo dio. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "GoogleError";
  }
}
export const isGoogleError = (e: unknown): e is GoogleError => e instanceof Error && e.name === "GoogleError";

export function buildGoogleAuthUrl(deps: Pick<GoogleDeps, "clientId" | "authUrl">, input: { redirectUri: string; state: string }): string {
  const p = new URLSearchParams({
    client_id: deps.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline", // para recibir refresh_token
    prompt: "consent", // sin esto Google no vuelve a darlo si ya autorizaron antes
    include_granted_scopes: "true",
    state: input.state,
  });
  return `${deps.authUrl ?? AUTH_URL}?${p.toString()}`;
}

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}));
}

async function tokenCall(deps: GoogleDeps, body: Record<string, string>): Promise<any> {
  const doFetch = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(deps.tokenUrl ?? TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: deps.clientId, client_secret: deps.clientSecret, ...body }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new GoogleError("sin conexion con Google", 0);
  }
  const json = await readJson(res);
  if (!res.ok) throw new GoogleError(json.error_description ?? json.error ?? `Google respondio ${res.status}`, res.status, json.error);
  return json;
}

/** Correo de la cuenta, leido del id_token (llega directo de Google por TLS en este mismo intercambio). */
function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export async function exchangeGoogleCode(
  deps: GoogleDeps,
  input: { code: string; redirectUri: string },
): Promise<{ refreshToken: string; email: string | null }> {
  const j = await tokenCall(deps, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri });
  if (typeof j.refresh_token !== "string" || !j.refresh_token) throw new GoogleError("Google no entrego un permiso permanente", 400, "no_refresh_token");
  return { refreshToken: j.refresh_token, email: emailFromIdToken(j.id_token) };
}

export async function refreshGoogleAccessToken(deps: GoogleDeps, refreshToken: string): Promise<string> {
  const j = await tokenCall(deps, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (typeof j.access_token !== "string") throw new GoogleError("Google no entrego un token de acceso", 502);
  return j.access_token;
}

export interface CalendarEvent {
  summary: string;
  description?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
}

export class GoogleCalendarApi {
  constructor(
    private readonly deps: GoogleDeps,
    private readonly accessToken: string,
    private readonly calendarId: string,
  ) {}

  private async call(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(`${this.deps.apiUrl ?? API}/calendars/${encodeURIComponent(this.calendarId)}/events${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GoogleError("sin conexion con Google", 0);
    }
    if (method === "DELETE" && (res.status === 204 || res.status === 404 || res.status === 410)) return {};
    const json = await readJson(res);
    if (!res.ok) throw new GoogleError(json.error?.message ?? `Google respondio ${res.status}`, res.status, json.error?.errors?.[0]?.reason ?? json.error?.status);
    return json;
  }

  async insert(event: CalendarEvent): Promise<string> {
    const j = await this.call("POST", "", event);
    if (typeof j.id !== "string") throw new GoogleError("Google no devolvio el id del evento", 502);
    return j.id;
  }
  async patch(eventId: string, event: CalendarEvent): Promise<void> {
    await this.call("PATCH", `/${encodeURIComponent(eventId)}`, event);
  }
  async remove(eventId: string): Promise<void> {
    await this.call("DELETE", `/${encodeURIComponent(eventId)}`);
  }
}

// ----------------------------------------------------------------- panel: conectar / ver / desconectar

const scope = (ctx: PanelContext) => ({ tenantId: ctx.tenantId, userId: ctx.userId });
const aad = (tenantId: string) => `gcal:${tenantId}`;

export interface CalendarView {
  connected: boolean;
  accountEmail: string | null;
  /** active | error */
  status: "active" | "error" | null;
  lastError: string | null;
  lastSyncedAt: Date | null;
}

export async function getCalendarConnection(db: Database, ctx: PanelContext): Promise<CalendarView> {
  const [row] = await withTenant(db, scope(ctx), (tx) => tx.select().from(calendarConnections));
  return {
    connected: Boolean(row),
    accountEmail: row?.accountEmail ?? null,
    status: row ? (row.status === "error" ? "error" : "active") : null,
    lastError: row?.lastError ?? null,
    lastSyncedAt: row?.lastSyncedAt ?? null,
  };
}

/** Guarda la conexion (solo dueño). Reconectar reemplaza la anterior y vuelve a sincronizar todo. */
export async function connectGoogleCalendar(
  db: Database,
  deps: GoogleDeps,
  ctx: PanelContext,
  input: { code: string; redirectUri: string },
): Promise<Success | Failure<"forbidden" | "google_rejected" | "google_down" | "no_refresh_token">> {
  if (!can(ctx.role, "configure")) return fail("forbidden");
  let exchanged: { refreshToken: string; email: string | null };
  try {
    exchanged = await exchangeGoogleCode(deps, input);
  } catch (e) {
    if (isGoogleError(e)) {
      if (e.code === "no_refresh_token") return fail("no_refresh_token");
      if (e.status === 0 || e.status >= 500) return fail("google_down");
    }
    return fail("google_rejected");
  }

  const enc = encryptSecret(exchanged.refreshToken, deps.key, aad(ctx.tenantId));
  await withTenant(db, scope(ctx), async (tx) => {
    const values = { accountEmail: exchanged.email, refreshTokenEnc: enc, status: "active", lastError: null, updatedAt: new Date() };
    await tx
      .insert(calendarConnections)
      .values({ tenantId: ctx.tenantId, provider: "google", calendarId: "primary", ...values })
      .onConflictDoUpdate({ target: calendarConnections.tenantId, set: { ...values, calendarId: "primary" } });
    // Cuenta nueva: los eventos anteriores ya no existen alli; que se vuelvan a crear todos.
    await tx.update(appointments).set({ calendarEventId: null, calendarSyncedAt: null }).where(sql`true`);
    await tx.insert(auditLog).values({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      action: "calendar.connect",
      entity: "calendar_connections",
      diff: { provider: "google", account: exchanged.email } as never,
    });
  });
  return { ok: true };
}

/** Quita la conexion (solo dueño). Los eventos ya creados se quedan en Google; el permiso se revoca. */
export async function disconnectGoogleCalendar(db: Database, deps: GoogleDeps | null, ctx: PanelContext): Promise<Success | Failure<"forbidden">> {
  if (!can(ctx.role, "configure")) return fail("forbidden");
  const row = await withTenant(db, scope(ctx), async (tx) => {
    const [r] = await tx.select().from(calendarConnections);
    if (!r) return null;
    await tx.delete(calendarConnections).where(eq(calendarConnections.id, r.id));
    await tx.update(appointments).set({ calendarEventId: null, calendarSyncedAt: null }).where(sql`true`);
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: "calendar.disconnect", entity: "calendar_connections" });
    return r;
  });
  if (row && deps) {
    // Mejor esfuerzo: revocar el permiso en Google.
    try {
      const token = decryptSecret(row.refreshTokenEnc, deps.key, aad(ctx.tenantId));
      await (deps.fetch ?? fetch)(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      /* no pasa nada: el usuario tambien puede quitarlo desde su cuenta de Google */
    }
  }
  return { ok: true };
}

// ----------------------------------------------------------------- sincronizacion (worker)

export interface CalendarSyncResult {
  checked: number;
  created: number;
  updated: number;
  deleted: number;
  errors: number;
}

type LogFn = (event: string, data?: Record<string, unknown>) => void;

function buildEvent(a: { startsAt: Date; endsAt: Date; id: string }, svc: string, who: string, phone: string | null, staffName: string | null, tz: string): CalendarEvent {
  const lines = [`Paciente: ${who}`, phone ? `Teléfono: ${phone}` : null, staffName ? `Con: ${staffName}` : null, "Agendada por el asistente (Tamia)."].filter(Boolean);
  return {
    summary: `${svc} — ${who}`,
    description: lines.join("\n"),
    start: { dateTime: a.startsAt.toISOString(), timeZone: tz },
    end: { dateTime: a.endsAt.toISOString(), timeZone: tz },
  };
}

/** Un error "permanente" de la cita (datos que Google rechaza): no se reintenta cada minuto. */
const permanent = (e: GoogleError) => e.status >= 400 && e.status < 500 && ![401, 403, 408, 429].includes(e.status);

/**
 * Refleja en Google las citas pendientes de sincronizar (todas las vias que cambian citas quedan cubiertas:
 * agente, panel, voz...). Idempotente: cada cita guarda el id de su evento y la fecha en que se sincronizo.
 */
export async function syncAppointmentsToGoogle(
  db: Database,
  deps: GoogleDeps,
  opts: { limit?: number; log?: LogFn } = {},
): Promise<CalendarSyncResult> {
  const log = opts.log ?? (() => {});
  const out: CalendarSyncResult = { checked: 0, created: 0, updated: 0, deleted: 0, errors: 0 };
  const due = await calendarDueAppointments(db, opts.limit ?? 50);
  const byTenant = new Map<string, string[]>();
  for (const d of due) byTenant.set(d.tenantId, [...(byTenant.get(d.tenantId) ?? []), d.appointmentId]);

  for (const [tenantId, ids] of byTenant) {
    const conn = await withTenant(db, { tenantId }, async (tx) => (await tx.select().from(calendarConnections))[0] ?? null);
    if (!conn) continue;

    let api: GoogleCalendarApi;
    try {
      const refresh = decryptSecret(conn.refreshTokenEnc, deps.key, aad(tenantId));
      api = new GoogleCalendarApi(deps, await refreshGoogleAccessToken(deps, refresh), conn.calendarId);
    } catch (e) {
      out.errors += ids.length;
      // invalid_grant = el permiso se revoco: hay que reconectar. Otros fallos son temporales.
      if (isGoogleError(e) && e.code === "invalid_grant") {
        await withTenant(db, { tenantId }, (tx) =>
          tx.update(calendarConnections).set({ status: "error", lastError: "Google ya no tiene el permiso. Vuelve a conectar tu calendario.", updatedAt: new Date() }).where(eq(calendarConnections.id, conn.id)),
        );
        log("calendar.revoked", { tenantId });
      } else log("calendar.token_error", { tenantId, error: e instanceof Error ? e.message : String(e) });
      continue;
    }

    for (const id of ids) {
      out.checked++;
      try {
        const row = await withTenant(db, { tenantId }, async (tx) => {
          const [r] = await tx
            .select({ a: appointments, contact: contacts, service: services, staff: staff, tz: tenants.timezone })
            .from(appointments)
            .innerJoin(contacts, eq(contacts.id, appointments.contactId))
            .innerJoin(services, eq(services.id, appointments.serviceId))
            .innerJoin(staff, eq(staff.id, appointments.staffId))
            .innerJoin(tenants, eq(tenants.id, appointments.tenantId))
            .where(eq(appointments.id, id));
          return r ?? null;
        });
        if (!row) continue;
        const { a } = row;
        const mark = (eventId: string | null) =>
          withTenant(db, { tenantId }, async (tx) => {
            // calendar_synced_at = updated_at leido: si la cita cambio mientras tanto, sigue pendiente.
            await tx.update(appointments).set({ calendarEventId: eventId, calendarSyncedAt: a.updatedAt }).where(eq(appointments.id, a.id));
            await tx.update(calendarConnections).set({ lastSyncedAt: new Date(), lastError: null }).where(eq(calendarConnections.id, conn.id));
          });

        if (a.status === "cancelled") {
          if (a.calendarEventId) await api.remove(a.calendarEventId);
          await mark(null);
          out.deleted++;
          continue;
        }
        const event = buildEvent(a, row.service.name, row.contact.displayName ?? "Paciente", row.contact.phoneE164, row.staff.name ?? null, row.tz);
        if (a.calendarEventId) {
          try {
            await api.patch(a.calendarEventId, event);
            await mark(a.calendarEventId);
            out.updated++;
            continue;
          } catch (e) {
            if (!(isGoogleError(e) && (e.status === 404 || e.status === 410))) throw e;
            // El evento se borro a mano en Google: se vuelve a crear.
          }
        }
        await mark(await api.insert(event));
        out.created++;
      } catch (e) {
        out.errors++;
        log("calendar.sync_error", { tenantId, appointmentId: id, error: e instanceof Error ? e.message : String(e) });
        if (isGoogleError(e) && permanent(e)) {
          // Google rechaza esta cita (datos): se marca como atendida para no reintentar cada minuto, y se deja el motivo.
          await withTenant(db, { tenantId }, async (tx) => {
            await tx.update(appointments).set({ calendarSyncedAt: sql`updated_at` }).where(eq(appointments.id, id));
            await tx.update(calendarConnections).set({ lastError: `No se pudo reflejar una cita: ${e.message}`.slice(0, 300) }).where(eq(calendarConnections.id, conn.id));
          });
        }
      }
    }
  }
  return out;
}
