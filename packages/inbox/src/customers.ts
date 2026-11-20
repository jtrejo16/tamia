import { phoneVariants, type MatchReason } from "@empleado/agent";
import { appointments, auditLog, channels, contacts, conversations, services, staff, withTenant, type Database, type Tx } from "@empleado/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { listAppointments, type AppointmentView } from "./appointments";
import { contactRelations } from "./contact-link";
import { normalizePhone } from "./notifications";
import { can, fail, type Failure, type PanelContext, type Success } from "./types";

/**
 * Gestion de clientes: lista con segmentos y numeros, ficha con historial y estadisticas, edicion de datos
 * de contacto, alta manual y la cola de "citas por cerrar" (pasadas que nadie marco como realizadas).
 *
 * Las estadisticas se calculan al consultar (sin tablas aparte). "Vino" = cita en estado "done"; si el equipo
 * no cierra las citas, estas cifras salen bajas: de ahi la cola de citas por cerrar.
 */

/** Dias sin venir para considerar a un cliente "en riesgo" y "perdido". */
export const RISK_DAYS = 60;
export const LOST_DAYS = 120;
const DAY_MS = 86_400_000;

export type CustomerSegment = "prospecto" | "nuevo" | "recurrente" | "en_riesgo" | "perdido";

export interface SegmentFacts {
  visits: number;
  /** Citas pendientes o confirmadas que aun no han terminado. */
  upcoming: number;
  /** Pendientes o confirmadas que ya terminaron y nadie cerro. */
  unclosed: number;
  lastVisit: Date | null;
}

/** Etapa del cliente. Quien tiene cita proxima nunca es "en riesgo" ni "perdido". */
export function segmentOf(f: SegmentFacts, now: Date): CustomerSegment {
  if (f.visits === 0) return f.upcoming > 0 || f.unclosed > 0 ? "nuevo" : "prospecto";
  if (f.upcoming === 0 && f.lastVisit) {
    const days = (now.getTime() - f.lastVisit.getTime()) / DAY_MS;
    if (days > LOST_DAYS) return "perdido";
    if (days > RISK_DAYS) return "en_riesgo";
  }
  return f.visits >= 2 ? "recurrente" : "nuevo";
}

export interface CustomerRow {
  id: string;
  name: string;
  hasRealName: boolean;
  phone: string | null;
  email: string | null;
  tags: string[];
  channels: string[];
  segment: CustomerSegment;
  /** Dos o mas inasistencias. */
  frequentNoShow: boolean;
  visits: number;
  noShows: number;
  cancelled: number;
  unclosed: number;
  lastVisitAt: Date | null;
  nextAppointmentAt: Date | null;
  optedOut: boolean;
  createdAt: Date;
}

export interface CustomersSummary {
  total: number;
  /** Dados de alta en los ultimos 30 dias. */
  newLast30: number;
  recurring: number;
  /** De quienes ya vinieron al menos una vez, la parte que volvio (2 o mas). null si nadie ha venido. */
  returnRate: number | null;
  /** inasistencias / (realizadas + inasistencias). null si no hay datos. */
  noShowRate: number | null;
  atRisk: number;
  lost: number;
  /** Citas pasadas por cerrar (de todos los clientes). */
  toClose: number;
}

export interface CustomerList {
  items: CustomerRow[];
  /** Cuantos cumplen la busqueda y el filtro (antes de paginar). */
  total: number;
  summary: CustomersSummary;
}

const txt = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const when = (v: unknown): Date | null => (v ? new Date(String(v)) : null);
const num = (v: unknown): number => Number(v ?? 0);

function nickOf(profile: unknown): string | null {
  const p = (profile ?? {}) as Record<string, unknown>;
  return txt(p.whatsapp_name) ?? txt(p.messenger_name) ?? txt(p.instagram_name);
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export type CustomerFilter = CustomerSegment | "inasistencias";
export const CUSTOMER_FILTERS: CustomerFilter[] = ["prospecto", "nuevo", "recurrente", "en_riesgo", "perdido", "inasistencias"];

export async function listCustomers(
  db: Database,
  ctx: PanelContext,
  options: { q?: string; filter?: CustomerFilter | null; limit?: number; offset?: number; now?: Date } = {},
): Promise<CustomerList> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const q = (options.q ?? "").trim().slice(0, 80);

  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const like = `%${likeEscape(q)}%`;
    const digits = q.replace(/\D/g, "");
    const search = q
      ? sql`and (c.display_name ilike ${like} or c.email ilike ${like} or c.profile->>'whatsapp_name' ilike ${like}
              or c.profile->>'messenger_name' ilike ${like} or c.profile->>'instagram_name' ilike ${like}
              ${digits.length >= 3 ? sql`or regexp_replace(coalesce(c.phone_e164, ''), '\\D', '', 'g') like ${`%${digits}%`}` : sql``})`
      : sql``;

    const nowIso = now.toISOString();
    const raw = (await tx.execute(sql`
      select c.id, c.display_name, c.phone_e164, c.email, c.tags, c.profile, c.opted_out_at, c.created_at,
        count(a.id) filter (where a.status = 'done')::int as visits,
        count(a.id) filter (where a.status = 'no_show')::int as no_shows,
        count(a.id) filter (where a.status = 'cancelled')::int as cancelled,
        count(a.id) filter (where a.status in ('pending', 'confirmed') and a.ends_at < ${nowIso}::timestamptz)::int as unclosed,
        count(a.id) filter (where a.status in ('pending', 'confirmed') and a.ends_at >= ${nowIso}::timestamptz)::int as upcoming,
        max(a.starts_at) filter (where a.status = 'done') as last_visit,
        min(a.starts_at) filter (where a.status in ('pending', 'confirmed') and a.ends_at >= ${nowIso}::timestamptz) as next_appt
      from contacts c
      left join appointments a on a.contact_id = c.id and a.tenant_id = c.tenant_id
      where c.tenant_id = ${ctx.tenantId}
        and not (
          exists (select 1 from conversations cv join channels ch on ch.id = cv.channel_id where cv.contact_id = c.id and ch.type = 'playground')
          and not exists (select 1 from conversations cv join channels ch on ch.id = cv.channel_id where cv.contact_id = c.id and ch.type <> 'playground')
        )
        ${search}
      group by c.id
    `)) as unknown as Array<Record<string, unknown>>;

    const chRows = raw.length
      ? await tx
          .select({ contactId: conversations.contactId, type: channels.type })
          .from(conversations)
          .innerJoin(channels, eq(channels.id, conversations.channelId))
          .where(and(inArray(conversations.contactId, raw.map((r) => String(r.id))), ne(channels.type, "playground")))
      : [];
    const chBy = new Map<string, Set<string>>();
    for (const r of chRows) (chBy.get(r.contactId) ?? chBy.set(r.contactId, new Set()).get(r.contactId)!).add(r.type);

    const all: CustomerRow[] = raw.map((r) => {
      const visits = num(r.visits);
      const noShows = num(r.no_shows);
      const lastVisit = when(r.last_visit);
      const nick = nickOf(r.profile);
      const name = txt(r.display_name);
      return {
        id: String(r.id),
        name: name ?? nick ?? txt(r.phone_e164) ?? "Cliente",
        hasRealName: Boolean(name),
        phone: txt(r.phone_e164),
        email: txt(r.email),
        tags: (r.tags as string[] | null) ?? [],
        channels: [...(chBy.get(String(r.id)) ?? [])].sort(),
        segment: segmentOf({ visits, upcoming: num(r.upcoming), unclosed: num(r.unclosed), lastVisit }, now),
        frequentNoShow: noShows >= 2,
        visits,
        noShows,
        cancelled: num(r.cancelled),
        unclosed: num(r.unclosed),
        lastVisitAt: lastVisit,
        nextAppointmentAt: when(r.next_appt),
        optedOut: Boolean(r.opted_out_at),
        createdAt: new Date(String(r.created_at)),
      };
    });

    // Numeros de la cabecera: siempre sobre TODOS los clientes que cumplen la busqueda, no sobre la pagina.
    const visited = all.filter((c) => c.visits >= 1);
    const sumVisits = all.reduce((s, c) => s + c.visits, 0);
    const sumNoShows = all.reduce((s, c) => s + c.noShows, 0);
    const summary: CustomersSummary = {
      total: all.length,
      newLast30: all.filter((c) => now.getTime() - c.createdAt.getTime() <= 30 * DAY_MS).length,
      recurring: all.filter((c) => c.segment === "recurrente").length,
      returnRate: visited.length ? visited.filter((c) => c.visits >= 2).length / visited.length : null,
      noShowRate: sumVisits + sumNoShows > 0 ? sumNoShows / (sumVisits + sumNoShows) : null,
      atRisk: all.filter((c) => c.segment === "en_riesgo").length,
      lost: all.filter((c) => c.segment === "perdido").length,
      toClose: all.reduce((s, c) => s + c.unclosed, 0),
    };

    const filter = options.filter && CUSTOMER_FILTERS.includes(options.filter) ? options.filter : null;
    const filtered = filter ? all.filter((c) => (filter === "inasistencias" ? c.frequentNoShow : c.segment === filter)) : all;
    // Los que vinieron mas recientemente primero; sin visita, por fecha de alta.
    filtered.sort((a, b) => (b.lastVisitAt ?? b.createdAt).getTime() - (a.lastVisitAt ?? a.createdAt).getTime());
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, summary };
  });
}

// ------------------------------------------------------------------------------ ficha

export interface CustomerAppointment {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: "pending" | "confirmed" | "cancelled" | "no_show" | "done";
  /** Terminó y sigue pendiente o confirmada: falta marcar si vino. */
  needsClosing: boolean;
  service: string;
  staff: string;
  priceCents: number | null;
}

export interface CustomerStats {
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  visits: number;
  noShows: number;
  cancelled: number;
  upcoming: number;
  unclosed: number;
  /** Promedio de dias entre visitas realizadas. null con menos de 2 visitas. */
  avgDaysBetweenVisits: number | null;
  daysSinceLastVisit: number | null;
  topService: { name: string; count: number } | null;
  /** Suma de precios de las citas realizadas, con el precio ACTUAL del servicio (estimado, no es un cobro real). */
  estimatedSpendCents: number;
  currency: string;
  /** Ya volvio: tiene 2 o mas citas realizadas. */
  returned: boolean;
}

export interface CustomerDetail {
  id: string;
  name: string;
  hasRealName: boolean;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  tags: string[];
  notes: string;
  optedOut: boolean;
  createdAt: Date;
  segment: CustomerSegment;
  frequentNoShow: boolean;
  channels: string[];
  /** Conversaciones (sin las del probador), la mas reciente primero. */
  conversations: Array<{ id: string; channel: string; lastMessageAt: Date | null }>;
  appointments: CustomerAppointment[];
  stats: CustomerStats;
  /** Posibles duplicados (mismo nombre o telefono por otra red), para unirlos desde la bandeja. */
  possibleSame: Array<{ contactId: string; name: string; phone: string | null; reason: MatchReason }>;
  otherPhones: string[];
}

export async function getCustomer(
  db: Database,
  ctx: PanelContext,
  contactId: string,
  options: { now?: Date } = {},
): Promise<Success<{ customer: CustomerDetail }> | Failure<"not_found">> {
  const now = options.now ?? new Date();
  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [c] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!c) return fail("not_found" as const);

    const [convs, appts] = await Promise.all([
      tx
        .select({ id: conversations.id, channel: channels.type, lastMessageAt: conversations.lastMessageAt })
        .from(conversations)
        .innerJoin(channels, eq(channels.id, conversations.channelId))
        .where(and(eq(conversations.contactId, c.id), ne(channels.type, "playground")))
        .orderBy(desc(conversations.lastMessageAt)),
      tx
        .select({ a: appointments, service: services.name, price: services.priceCents, currency: services.currency, staff: staff.name })
        .from(appointments)
        .innerJoin(services, eq(services.id, appointments.serviceId))
        .innerJoin(staff, eq(staff.id, appointments.staffId))
        .where(eq(appointments.contactId, c.id))
        .orderBy(desc(appointments.startsAt)),
    ]);

    const history: CustomerAppointment[] = appts.map(({ a, service, price, staff: member }) => ({
      id: a.id,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      status: a.status,
      needsClosing: (a.status === "pending" || a.status === "confirmed") && a.endsAt.getTime() < now.getTime(),
      service,
      staff: member,
      priceCents: price,
    }));

    const done = appts.filter((r) => r.a.status === "done").sort((x, y) => x.a.startsAt.getTime() - y.a.startsAt.getTime());
    const upcoming = history.filter((h) => (h.status === "pending" || h.status === "confirmed") && !h.needsClosing).length;
    const unclosed = history.filter((h) => h.needsClosing).length;
    const lastVisit = done.at(-1)?.a.startsAt ?? null;

    let avg: number | null = null;
    if (done.length >= 2) {
      const span = done.at(-1)!.a.startsAt.getTime() - done[0]!.a.startsAt.getTime();
      avg = Math.round(span / (done.length - 1) / DAY_MS);
    }
    const byService = new Map<string, number>();
    for (const r of done) byService.set(r.service, (byService.get(r.service) ?? 0) + 1);
    const top = [...byService].sort((x, y) => y[1] - x[1])[0];

    const visits = done.length;
    const noShows = history.filter((h) => h.status === "no_show").length;
    const profile = (c.profile ?? {}) as Record<string, unknown>;
    const rel = await contactRelations(tx, c.id, now);

    const customer: CustomerDetail = {
      id: c.id,
      name: c.displayName ?? nickOf(c.profile) ?? c.phoneE164 ?? "Cliente",
      hasRealName: Boolean(c.displayName),
      displayName: c.displayName,
      phone: c.phoneE164,
      email: c.email,
      tags: c.tags,
      notes: c.notes ?? "",
      optedOut: Boolean(c.optedOutAt),
      createdAt: c.createdAt,
      segment: segmentOf({ visits, upcoming, unclosed, lastVisit }, now),
      frequentNoShow: noShows >= 2,
      channels: [...new Set(convs.map((v) => v.channel))].sort(),
      conversations: convs,
      appointments: history,
      stats: {
        firstVisitAt: done[0]?.a.startsAt ?? null,
        lastVisitAt: lastVisit,
        visits,
        noShows,
        cancelled: history.filter((h) => h.status === "cancelled").length,
        upcoming,
        unclosed,
        avgDaysBetweenVisits: avg,
        daysSinceLastVisit: lastVisit ? Math.floor((now.getTime() - lastVisit.getTime()) / DAY_MS) : null,
        topService: top ? { name: top[0], count: top[1] } : null,
        estimatedSpendCents: done.reduce((s, r) => s + (r.price ?? 0), 0),
        currency: done[0]?.currency ?? appts[0]?.currency ?? "MXN",
        returned: visits >= 2,
      },
      possibleSame: rel.possibleSame.map((p) => ({ contactId: p.contactId, name: p.name, phone: p.phone, reason: p.reason })),
      otherPhones: Array.isArray(profile.otros_telefonos) ? (profile.otros_telefonos as string[]).filter((p) => typeof p === "string") : [],
    };
    return { ok: true as const, customer };
  });
}

// ------------------------------------------------------------------------- editar / crear

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export type CustomerError = "forbidden" | "not_found" | "invalid";
export type CustomerInvalid = Failure<"invalid"> & { details: string[] };
export type PhoneTaken = Failure<"phone_taken"> & { otherId: string; otherName: string };

export interface CustomerInput {
  displayName?: unknown;
  phone?: unknown;
  email?: unknown;
  tags?: unknown;
  notes?: unknown;
  optedOut?: unknown;
}

interface Clean {
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  tags?: string[];
  notes?: string | null;
  optedOut?: boolean;
}

/** Limpia y valida solo lo que viene en la peticion; lo que falta no se toca. */
function clean(input: CustomerInput): { ok: true; data: Clean } | { ok: false; details: string[] } {
  const details: string[] = [];
  const data: Clean = {};
  if (input.displayName !== undefined) {
    const v = typeof input.displayName === "string" ? input.displayName.trim() : "";
    if (v.length > 120) details.push("El nombre es demasiado largo (máximo 120 caracteres).");
    data.displayName = v || null;
  }
  if (input.phone !== undefined) {
    const raw = typeof input.phone === "string" ? input.phone.trim() : "";
    if (!raw) data.phone = null;
    else {
      const p = normalizePhone(raw);
      if (!p) details.push("El teléfono no es válido. Escríbelo a 10 dígitos (por ejemplo 999 123 4567) o con lada internacional (+1…).");
      else data.phone = p;
    }
  }
  if (input.email !== undefined) {
    const v = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    if (v && (!EMAIL.test(v) || v.length > 200)) details.push("El correo no es válido.");
    data.email = v || null;
  }
  if (input.tags !== undefined) {
    const list = Array.isArray(input.tags) ? input.tags : [];
    const tags = [...new Set(list.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))];
    if (tags.length > 20) details.push("Máximo 20 etiquetas.");
    if (tags.some((t) => t.length > 30)) details.push("Cada etiqueta puede tener hasta 30 caracteres.");
    data.tags = tags;
  }
  if (input.notes !== undefined) {
    const v = typeof input.notes === "string" ? input.notes.trim() : "";
    if (v.length > 2000) details.push("Las notas son demasiado largas (máximo 2000 caracteres).");
    data.notes = v || null;
  }
  if (input.optedOut !== undefined) data.optedOut = input.optedOut === true;
  return details.length ? { ok: false, details } : { ok: true, data };
}

const invalid = (details: string[]): CustomerInvalid => ({ ok: false, error: "invalid", details });

/** ¿Otro contacto del negocio ya usa este telefono (en cualquiera de sus dos formas de celular de Mexico)? */
async function phoneOwner(tx: Tx, phone: string, exceptId?: string) {
  const rows = await tx.select().from(contacts).where(inArray(contacts.phoneE164, phoneVariants(phone)));
  return rows.find((r) => r.id !== exceptId) ?? null;
}

const nameOf = (c: typeof contacts.$inferSelect) => c.displayName ?? nickOf(c.profile) ?? c.phoneE164 ?? "Cliente";

export async function updateCustomer(
  db: Database,
  ctx: PanelContext,
  contactId: string,
  input: CustomerInput,
  now = new Date(),
): Promise<Success | Failure<"forbidden" | "not_found"> | CustomerInvalid | PhoneTaken> {
  if (!can(ctx.role, "manage_appointments")) return fail("forbidden");
  const v = clean(input);
  if (!v.ok) return invalid(v.details);
  const d = v.data;

  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    const [me] = await tx.select().from(contacts).where(eq(contacts.id, contactId));
    if (!me) return fail("not_found" as const);

    const set: Partial<typeof contacts.$inferInsert> = {};
    const changed: string[] = [];
    if (d.displayName !== undefined && d.displayName !== me.displayName) { set.displayName = d.displayName; changed.push("nombre"); }
    if (d.email !== undefined && d.email !== me.email) { set.email = d.email; changed.push("correo"); }
    if (d.tags !== undefined && d.tags.join("\u0000") !== me.tags.join("\u0000")) { set.tags = d.tags; changed.push("etiquetas"); }
    if (d.notes !== undefined && d.notes !== me.notes) { set.notes = d.notes; changed.push("notas"); }
    if (d.phone !== undefined) {
      // Si es el mismo celular escrito de otra forma (+521… o +52…), se deja el que ya estaba guardado.
      const same = d.phone !== null && me.phoneE164 !== null && phoneVariants(me.phoneE164).includes(d.phone);
      if (!same && d.phone !== me.phoneE164) {
        if (d.phone) {
          const other = await phoneOwner(tx, d.phone, me.id);
          if (other) return { ok: false as const, error: "phone_taken" as const, otherId: other.id, otherName: nameOf(other) };
        }
        set.phoneE164 = d.phone;
        changed.push("teléfono");
      }
    }
    if (d.optedOut !== undefined && d.optedOut !== Boolean(me.optedOutAt)) {
      set.optedOutAt = d.optedOut ? now : null;
      if (d.optedOut) set.optInMarketing = false;
      changed.push(d.optedOut ? "no contactar" : "volver a contactar");
    }

    if (changed.length === 0) return { ok: true as const };
    await tx.update(contacts).set({ ...set, updatedAt: now }).where(eq(contacts.id, me.id));
    // La bitacora guarda QUE se cambio, no los datos personales.
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: "customer.updated", entity: "contact", entityId: me.id, diff: { campos: changed } });
    return { ok: true as const };
  });
}

export async function createCustomer(
  db: Database,
  ctx: PanelContext,
  input: CustomerInput,
): Promise<Success<{ id: string }> | Failure<"forbidden"> | CustomerInvalid | PhoneTaken> {
  if (!can(ctx.role, "manage_appointments")) return fail("forbidden");
  const v = clean(input);
  if (!v.ok) return invalid(v.details);
  const d = v.data;
  if (!d.displayName) return invalid(["Escribe el nombre del cliente."]);
  if (!d.phone && !d.email) return invalid(["Escribe al menos un teléfono o un correo para poder contactarlo."]);

  return withTenant(db, { tenantId: ctx.tenantId, userId: ctx.userId }, async (tx) => {
    if (d.phone) {
      const other = await phoneOwner(tx, d.phone);
      if (other) return { ok: false as const, error: "phone_taken" as const, otherId: other.id, otherName: nameOf(other) };
    }
    const [row] = await tx
      .insert(contacts)
      .values({
        tenantId: ctx.tenantId,
        displayName: d.displayName,
        phoneE164: d.phone ?? null,
        email: d.email ?? null,
        tags: d.tags ?? [],
        notes: d.notes ?? null,
      })
      .returning({ id: contacts.id });
    await tx.insert(auditLog).values({ tenantId: ctx.tenantId, userId: ctx.userId, action: "customer.created", entity: "contact", entityId: row!.id, diff: { origen: "panel" } });
    return { ok: true as const, id: row!.id };
  });
}

// --------------------------------------------------------------------- citas por cerrar

/** Citas que ya terminaron y siguen "pendientes" o "confirmadas": falta marcar si vino o no. Las mas recientes primero. */
export async function listAppointmentsToClose(db: Database, ctx: PanelContext, options: { now?: Date } = {}): Promise<AppointmentView[]> {
  const now = options.now ?? new Date();
  const rows = await listAppointments(db, ctx, { from: new Date(now.getTime() - 120 * DAY_MS), to: now, limit: 500, now });
  return rows.filter((a) => a.endsAt.getTime() < now.getTime()).sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
}
