import { phoneVariants, type MatchReason } from "@empleado/agent";
import { appointments, auditLog, channels, contacts, conversations, orderItems, orders, reservations, services, staff, tenants, withTenant, type Database, type OrderStatus, type ReservationStatus, type Tx } from "@empleado/db";
import { hasModule, modulesFor } from "@empleado/shared";
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
 *
 * Restaurantes: una "visita" es un pedido ENTREGADO o una reservacion COMPLETADA, y una inasistencia es una reservacion en
 * "no llego". Cada fuente que el negocio no usa aporta cero, asi que las mismas cifras sirven para citas, restaurantes o ambos.
 */

/** Dias sin venir para considerar a un cliente "en riesgo" y "perdido". */
export const RISK_DAYS = 60;
export const LOST_DAYS = 120;
/** Un restaurante se enfria antes que una clinica: 30 y 60 dias. */
export const RESTAURANT_RISK_DAYS = 30;
export const RESTAURANT_LOST_DAYS = 60;

export interface SegmentLimits {
  risk: number;
  lost: number;
}
const APPOINTMENT_LIMITS: SegmentLimits = { risk: RISK_DAYS, lost: LOST_DAYS };
const RESTAURANT_LIMITS: SegmentLimits = { risk: RESTAURANT_RISK_DAYS, lost: RESTAURANT_LOST_DAYS };

/** Los restaurantes (sin agenda de citas) usan plazos mas cortos. */
export const limitsFor = (modules: readonly string[]): SegmentLimits => (hasModule(modules, "restaurante") && !hasModule(modules, "citas") ? RESTAURANT_LIMITS : APPOINTMENT_LIMITS);
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
export function segmentOf(f: SegmentFacts, now: Date, limits: SegmentLimits = APPOINTMENT_LIMITS): CustomerSegment {
  if (f.visits === 0) return f.upcoming > 0 || f.unclosed > 0 ? "nuevo" : "prospecto";
  if (f.upcoming === 0 && f.lastVisit) {
    const days = (now.getTime() - f.lastVisit.getTime()) / DAY_MS;
    if (days > limits.lost) return "perdido";
    if (days > limits.risk) return "en_riesgo";
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
  /** Citas realizadas + pedidos entregados + reservaciones completadas. */
  visits: number;
  noShows: number;
  cancelled: number;
  unclosed: number;
  lastVisitAt: Date | null;
  /** Proxima cita o reservacion. */
  nextAppointmentAt: Date | null;
  /** Restaurante: pedidos entregados, reservaciones completadas y lo gastado en pedidos entregados (centavos). */
  orders: number;
  reservations: number;
  spendCents: number;
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
    const [tenant] = await tx.select({ vertical: tenants.vertical, profile: tenants.profile }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const limits = limitsFor(modulesFor(tenant?.vertical, tenant?.profile?.modules));
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
        min(a.starts_at) filter (where a.status in ('pending', 'confirmed') and a.ends_at >= ${nowIso}::timestamptz) as next_appt,
        (select count(*) from orders o where o.contact_id = c.id and o.status = 'delivered')::int as orders_done,
        coalesce((select sum(o.total_cents) from orders o where o.contact_id = c.id and o.status = 'delivered'), 0)::bigint as orders_spend,
        (select count(*) from orders o where o.contact_id = c.id and o.status = 'cancelled')::int as orders_cancelled,
        (select count(*) from orders o where o.contact_id = c.id and o.status in ('new', 'preparing', 'ready', 'on_the_way') and o.created_at >= ${nowIso}::timestamptz - interval '1 day')::int as orders_open,
        (select max(coalesce(o.delivered_at, o.created_at)) from orders o where o.contact_id = c.id and o.status = 'delivered') as last_order,
        (select count(*) from reservations r where r.contact_id = c.id and r.status = 'completed')::int as res_done,
        (select count(*) from reservations r where r.contact_id = c.id and r.status = 'no_show')::int as res_no_show,
        (select count(*) from reservations r where r.contact_id = c.id and r.status = 'cancelled')::int as res_cancelled,
        (select count(*) from reservations r where r.contact_id = c.id and r.status in ('confirmed', 'seated') and r.ends_at < ${nowIso}::timestamptz)::int as res_unclosed,
        (select count(*) from reservations r where r.contact_id = c.id and r.status in ('confirmed', 'seated') and r.ends_at >= ${nowIso}::timestamptz)::int as res_upcoming,
        (select max(r.starts_at) from reservations r where r.contact_id = c.id and r.status = 'completed') as last_res,
        (select min(r.starts_at) from reservations r where r.contact_id = c.id and r.status in ('confirmed', 'seated') and r.ends_at >= ${nowIso}::timestamptz) as next_res
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
      const ordersDone = num(r.orders_done);
      const resDone = num(r.res_done);
      const visits = num(r.visits) + ordersDone + resDone;
      const noShows = num(r.no_shows) + num(r.res_no_show);
      const unclosed = num(r.unclosed) + num(r.res_unclosed);
      const upcoming = num(r.upcoming) + num(r.res_upcoming) + num(r.orders_open);
      const latest = (...ds: Array<Date | null>) => ds.reduce<Date | null>((m, d) => (d && (!m || d > m) ? d : m), null);
      const earliest = (...ds: Array<Date | null>) => ds.reduce<Date | null>((m, d) => (d && (!m || d < m) ? d : m), null);
      const lastVisit = latest(when(r.last_visit), when(r.last_order), when(r.last_res));
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
        segment: segmentOf({ visits, upcoming, unclosed, lastVisit }, now, limits),
        frequentNoShow: noShows >= 2,
        visits,
        noShows,
        cancelled: num(r.cancelled) + num(r.orders_cancelled) + num(r.res_cancelled),
        unclosed,
        lastVisitAt: lastVisit,
        nextAppointmentAt: earliest(when(r.next_appt), when(r.next_res)),
        orders: ordersDone,
        reservations: resDone,
        spendCents: num(r.orders_spend),
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

/** Un pedido del cliente (restaurante). `items` ya viene armado: "3 × Taco al pastor, 1 × Horchata". */
export interface CustomerOrder {
  id: string;
  number: number;
  createdAt: Date;
  status: OrderStatus;
  mode: "pickup" | "delivery";
  channel: string;
  totalCents: number;
  items: string;
}

/** Una reservacion del cliente (restaurante). */
export interface CustomerReservation {
  id: string;
  number: number;
  startsAt: Date;
  status: ReservationStatus;
  partySize: number;
  notes: string | null;
  /** Ya paso su hora y sigue confirmada o sentada: falta cerrarla (llego / no llego). */
  needsClosing: boolean;
}

export interface CustomerStats {
  firstVisitAt: Date | null;
  lastVisitAt: Date | null;
  /** Citas realizadas + pedidos entregados + reservaciones completadas. */
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
  /** Ya volvio: tiene 2 o mas visitas. */
  returned: boolean;
  /** Restaurante: pedidos entregados, lo gastado en ellos (real, centavos), ticket promedio y platillo mas pedido. */
  orders: number;
  spendCents: number;
  avgTicketCents: number | null;
  topDish: { name: string; count: number } | null;
  reservationsDone: number;
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
  /** Los 50 pedidos y las 50 reservaciones mas recientes (las estadisticas cuentan todos). */
  orders: CustomerOrder[];
  reservations: CustomerReservation[];
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

    const [tenant] = await tx.select({ vertical: tenants.vertical, profile: tenants.profile }).from(tenants).where(eq(tenants.id, ctx.tenantId));
    const limits = limitsFor(modulesFor(tenant?.vertical, tenant?.profile?.modules));
    const [convs, appts, ords, ress] = await Promise.all([
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
      tx.select().from(orders).where(eq(orders.contactId, c.id)).orderBy(desc(orders.createdAt)),
      tx.select().from(reservations).where(eq(reservations.contactId, c.id)).orderBy(desc(reservations.startsAt)),
    ]);

    // Lo que pidio en cada pedido (de todos los entregados para el platillo favorito; de los 50 mas recientes para mostrar).
    const needItems = [...new Set([...ords.slice(0, 50), ...ords.filter((o) => o.status === "delivered")].map((o) => o.id))];
    const lines = needItems.length ? await tx.select().from(orderItems).where(inArray(orderItems.orderId, needItems)).orderBy(orderItems.sortOrder) : [];
    const itemsText = (orderId: string) => lines.filter((l) => l.orderId === orderId).map((l) => `${l.quantity} × ${l.name}`).join(", ");
    const dishes = new Map<string, number>();
    for (const o of ords.filter((x) => x.status === "delivered")) for (const l of lines.filter((x) => x.orderId === o.id)) dishes.set(l.name, (dishes.get(l.name) ?? 0) + l.quantity);
    const topDish = [...dishes].sort((x, y) => y[1] - x[1])[0];

    const openOrderStates: OrderStatus[] = ["new", "preparing", "ready", "on_the_way"];
    const resHistory: CustomerReservation[] = ress.map((r) => ({
      id: r.id,
      number: r.number,
      startsAt: r.startsAt,
      status: r.status,
      partySize: r.partySize,
      notes: r.notes,
      needsClosing: (r.status === "confirmed" || r.status === "seated") && r.endsAt.getTime() < now.getTime(),
    }));
    const deliveredOrders = ords.filter((o) => o.status === "delivered");
    const openOrders = ords.filter((o) => openOrderStates.includes(o.status) && now.getTime() - o.createdAt.getTime() <= DAY_MS).length;

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
    const upcoming = history.filter((h) => (h.status === "pending" || h.status === "confirmed") && !h.needsClosing).length + resHistory.filter((r) => (r.status === "confirmed" || r.status === "seated") && !r.needsClosing).length + openOrders;
    const unclosed = history.filter((h) => h.needsClosing).length + resHistory.filter((r) => r.needsClosing).length;

    // Una visita es una cita realizada, un pedido entregado o una reservacion completada.
    const visitDates = [
      ...done.map((r) => r.a.startsAt),
      ...deliveredOrders.map((o) => o.deliveredAt ?? o.createdAt),
      ...ress.filter((r) => r.status === "completed").map((r) => r.startsAt),
    ].sort((x, y) => x.getTime() - y.getTime());
    const lastVisit = visitDates.at(-1) ?? null;

    let avg: number | null = null;
    if (visitDates.length >= 2) {
      const span = visitDates.at(-1)!.getTime() - visitDates[0]!.getTime();
      avg = Math.round(span / (visitDates.length - 1) / DAY_MS);
    }
    const byService = new Map<string, number>();
    for (const r of done) byService.set(r.service, (byService.get(r.service) ?? 0) + 1);
    const top = [...byService].sort((x, y) => y[1] - x[1])[0];

    const visits = visitDates.length;
    const noShows = history.filter((h) => h.status === "no_show").length + resHistory.filter((r) => r.status === "no_show").length;
    const ordersSpend = deliveredOrders.reduce((sum, o) => sum + o.totalCents, 0);
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
      segment: segmentOf({ visits, upcoming, unclosed, lastVisit }, now, limits),
      frequentNoShow: noShows >= 2,
      channels: [...new Set(convs.map((v) => v.channel))].sort(),
      conversations: convs,
      appointments: history,
      orders: ords.slice(0, 50).map((o) => ({ id: o.id, number: o.number, createdAt: o.createdAt, status: o.status, mode: o.mode, channel: o.channel, totalCents: o.totalCents, items: itemsText(o.id) })),
      reservations: resHistory.slice(0, 50),
      stats: {
        firstVisitAt: visitDates[0] ?? null,
        lastVisitAt: lastVisit,
        visits,
        noShows,
        cancelled: history.filter((h) => h.status === "cancelled").length + ords.filter((o) => o.status === "cancelled").length + resHistory.filter((r) => r.status === "cancelled").length,
        upcoming,
        unclosed,
        avgDaysBetweenVisits: avg,
        daysSinceLastVisit: lastVisit ? Math.floor((now.getTime() - lastVisit.getTime()) / DAY_MS) : null,
        topService: top ? { name: top[0], count: top[1] } : null,
        estimatedSpendCents: done.reduce((s, r) => s + (r.price ?? 0), 0),
        currency: done[0]?.currency ?? appts[0]?.currency ?? "MXN",
        returned: visits >= 2,
        orders: deliveredOrders.length,
        spendCents: ordersSpend,
        avgTicketCents: deliveredOrders.length > 0 ? Math.round(ordersSpend / deliveredOrders.length) : null,
        topDish: topDish ? { name: topDish[0], count: topDish[1] } : null,
        reservationsDone: ress.filter((r) => r.status === "completed").length,
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
