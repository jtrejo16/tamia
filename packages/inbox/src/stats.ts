import { withTenant, type Database, type Tx } from "@empleado/db";
import { sql } from "drizzle-orm";
import type { PanelContext } from "./types";

/**
 * Estadisticas del negocio (un negocio = sus propios numeros, bajo el aislamiento por negocio de la base).
 * Todo se calcula con consultas agregadas sobre las tablas existentes: no hay tablas nuevas que mantener.
 * Los dias se cuentan en la zona horaria del negocio. Las llamadas telefonicas se miden aparte de los mensajes.
 */

export const STATS_RANGES = [7, 30, 90] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

const DAY_MS = 86_400_000;

export interface Delta {
  value: number;
  /** Mismo dato del periodo anterior de igual duracion. */
  previous: number;
}

export interface StatsView {
  range: { days: number; from: string; to: string; timezone: string };
  /** Cifras clave con comparacion contra el periodo anterior. */
  headline: {
    inbound: Delta;
    botReplies: Delta;
    humanReplies: Delta;
    activeConversations: Delta;
    handoffs: Delta;
    appointmentsCreated: Delta;
  };
  messages: {
    inbound: number;
    botReplies: number;
    humanReplies: number;
    templates: number;
    outbound: number;
    delivered: number;
    read: number;
    failed: number;
    /** Entregados / enviados (0-1), null si no se envio nada. */
    deliveryRate: number | null;
    readRate: number | null;
    byChannel: Array<{ channel: string; inbound: number; outbound: number }>;
    /** Mensajes por dia (en la zona del negocio), con ceros en los dias vacios. */
    daily: Array<{ day: string; inbound: number; bot: number; human: number }>;
    /** Mensajes entrantes por hora del dia (0-23). */
    byHour: number[];
    /** Mensajes entrantes por dia de la semana (0 = domingo). */
    byWeekday: number[];
  };
  response: {
    /** Segundos hasta la primera respuesta (mediana y percentil 90), null si no hay datos. */
    medianSeconds: number | null;
    p90Seconds: number | null;
    measured: number;
    /** Mensajes de clientes (primero de cada racha) a los que nunca se contesto. */
    unanswered: number;
  };
  conversations: {
    active: number;
    created: number;
    /** El asistente atendio sin que una persona interviniera ni se escalara. */
    resolvedByAssistant: number;
    resolvedRate: number | null;
    handoffs: number;
    handoffRate: number | null;
    urgentHandoffs: number;
    openHandoffs: number;
    medianHandoffResolutionMinutes: number | null;
    recentReasons: Array<{ reason: string; urgency: string; at: string }>;
    /** Escalaciones tomadas por cada persona del equipo. */
    takenByPerson: Array<{ name: string; count: number }>;
  };
  approvals: {
    total: number;
    approved: number;
    edited: number;
    discarded: number;
    pending: number;
    /** Aprobados tal cual / revisados (0-1). */
    approvedAsIsRate: number | null;
  };
  appointments: {
    created: number;
    byAssistant: number;
    manual: number;
    assistantShare: number | null;
    /** Citas cuya hora cae en el periodo, por resultado. */
    outcomes: { confirmed: number; pending: number; cancelled: number; noShow: number; done: number };
    cancelRate: number | null;
    noShowRate: number | null;
    upcoming7d: number;
    upcomingUnconfirmed7d: number;
    avgLeadDays: number | null;
    /** Ingreso estimado de citas confirmadas o realizadas (precio de lista del servicio), en pesos. */
    estimatedRevenue: number;
    topServices: Array<{ name: string; count: number }>;
    byWeekday: number[];
    byHour: number[];
    dailyCreated: Array<{ day: string; count: number }>;
  };
  followUp: {
    remindersSent24h: number;
    remindersSent2h: number;
    /** Citas ya pasadas del periodo que recibieron al menos un recordatorio / todas las no canceladas. */
    reminderCoverage: number | null;
    /** De las que recibieron recordatorio, cuantas el cliente confirmo. */
    confirmedAfterReminder: number | null;
    noShowRateWithReminder: number | null;
    noShowRateWithoutReminder: number | null;
    /** Clientes con 2 o mas citas / clientes con al menos una. */
    returningClients: number;
    clientsWithAppointments: number;
    returningRate: number | null;
  };
  contacts: {
    total: number;
    created: number;
    optedOut: number;
    marketingOptIn: number;
  };
  calls: {
    total: number;
    failed: number;
    avgDurationSeconds: number | null;
    totalMinutes: number;
    sentiment: { positive: number; neutral: number; negative: number; unknown: number };
    transferred: number;
  };
  /** Solo para el dueño: lo demas lo ve todo el equipo. */
  ai: null | {
    costUsd: number;
    tokensIn: number;
    tokensOut: number;
    costPerConversationUsd: number | null;
    byKind: Array<{ kind: string; costUsd: number }>;
  };
}

// ----------------------------------------------------------------- utilidades

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const nOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
const iso = (d: Date) => d.toISOString();

async function rows<T extends Record<string, unknown>>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(q)) as unknown as T[];
}
async function one<T extends Record<string, unknown>>(tx: Tx, q: ReturnType<typeof sql>): Promise<T> {
  return (await rows<T>(tx, q))[0] ?? ({} as T);
}

/** Lista de dias YYYY-MM-DD (zona del negocio) entre dos instantes, para rellenar con ceros. */
function dayKeys(from: Date, to: Date, tz: string): string[] {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const keys: string[] = [];
  for (let t = from.getTime(); t <= to.getTime() + DAY_MS; t += DAY_MS) {
    const k = fmt.format(new Date(t));
    if (keys[keys.length - 1] !== k) keys.push(k);
    if (keys.length > 120) break;
  }
  return Array.from(new Set(keys));
}

const histogram = (size: number, items: Array<{ k: unknown; c: unknown }>): number[] => {
  const out = Array.from({ length: size }, () => 0);
  for (const i of items) {
    const k = Number(i.k);
    if (Number.isInteger(k) && k >= 0 && k < size) out[k] = n(i.c);
  }
  return out;
};

// ----------------------------------------------------------------- cifras base (periodo actual y anterior)

interface Core {
  inbound: number;
  bot: number;
  human: number;
  active: number;
  handoffs: number;
  appts: number;
}

/** Mensajes de texto/plantilla de canales de chat (la voz se mide aparte, por llamada). */
async function core(tx: Tx, tenantId: string, a: Date, b: Date): Promise<Core> {
  const m = await one<{ inbound: number; bot: number; human: number; active: number }>(
    tx,
    sql`select
          count(*) filter (where m.direction = 'in')::int as inbound,
          count(*) filter (where m.direction = 'out' and m.sender = 'bot')::int as bot,
          count(*) filter (where m.direction = 'out' and m.sender = 'human')::int as human,
          count(distinct m.conversation_id)::int as active
        from messages m join channels c on c.id = m.channel_id and c.type in ('whatsapp','messenger','instagram')
        where m.tenant_id = ${tenantId} and m.created_at >= ${iso(a)}::timestamptz and m.created_at < ${iso(b)}::timestamptz`,
  );
  const h = await one<{ c: number }>(tx, sql`select count(*)::int as c from handoffs where tenant_id = ${tenantId} and created_at >= ${iso(a)}::timestamptz and created_at < ${iso(b)}::timestamptz`);
  const ap = await one<{ c: number }>(tx, sql`select count(*)::int as c from appointments where tenant_id = ${tenantId} and created_at >= ${iso(a)}::timestamptz and created_at < ${iso(b)}::timestamptz`);
  return { inbound: n(m.inbound), bot: n(m.bot), human: n(m.human), active: n(m.active), handoffs: n(h.c), appts: n(ap.c) };
}

// ----------------------------------------------------------------- consulta principal

export async function getStats(
  db: Database,
  ctx: PanelContext,
  opts: { days?: number; now?: Date } = {},
): Promise<StatsView> {
  const days = (STATS_RANGES as readonly number[]).includes(opts.days ?? 30) ? (opts.days ?? 30) : 30;
  const to = opts.now ?? new Date();
  const from = new Date(to.getTime() - days * DAY_MS);
  const prevFrom = new Date(from.getTime() - days * DAY_MS);
  const t = ctx.tenantId;
  const A = iso(from);
  const B = iso(to);
  const isOwner = ctx.role === "owner";

  return withTenant(db, { tenantId: t, userId: ctx.userId }, async (tx) => {
    const [tenant] = await rows<{ tz: string }>(tx, sql`select timezone as tz from tenants where id = ${t}`);
    const tz = tenant?.tz ?? "America/Merida";

    const [cur, prev] = [await core(tx, t, from, to), await core(tx, t, prevFrom, from)];
    const delta = (value: number, previous: number): Delta => ({ value, previous });

    // ---- mensajes
    const msg = await one<Record<string, number>>(
      tx,
      sql`select
            count(*) filter (where m.direction = 'out' and m.type = 'template')::int as templates,
            count(*) filter (where m.direction = 'out')::int as outbound,
            count(*) filter (where m.direction = 'out' and m.status in ('sent','delivered','read'))::int as sent,
            count(*) filter (where m.direction = 'out' and m.status in ('delivered','read'))::int as delivered,
            count(*) filter (where m.direction = 'out' and m.status = 'read')::int as read,
            count(*) filter (where m.direction = 'out' and m.status = 'failed')::int as failed
          from messages m join channels c on c.id = m.channel_id and c.type in ('whatsapp','messenger','instagram')
          where m.tenant_id = ${t} and m.created_at >= ${A}::timestamptz and m.created_at < ${B}::timestamptz`,
    );
    const byChannel = await rows<{ channel: string; inbound: number; outbound: number }>(
      tx,
      sql`select c.type as channel,
            count(*) filter (where m.direction = 'in')::int as inbound,
            count(*) filter (where m.direction = 'out')::int as outbound
          from messages m join channels c on c.id = m.channel_id and c.type in ('whatsapp','messenger','instagram')
          where m.tenant_id = ${t} and m.created_at >= ${A}::timestamptz and m.created_at < ${B}::timestamptz
          group by c.type order by count(*) desc`,
    );
    const dailyRows = await rows<{ day: string; inbound: number; bot: number; human: number }>(
      tx,
      sql`select to_char((m.created_at at time zone ${tz})::date, 'YYYY-MM-DD') as day,
            count(*) filter (where m.direction = 'in')::int as inbound,
            count(*) filter (where m.direction = 'out' and m.sender = 'bot')::int as bot,
            count(*) filter (where m.direction = 'out' and m.sender = 'human')::int as human
          from messages m join channels c on c.id = m.channel_id and c.type in ('whatsapp','messenger','instagram')
          where m.tenant_id = ${t} and m.created_at >= ${A}::timestamptz and m.created_at < ${B}::timestamptz
          group by 1`,
    );
    const dailyMap = new Map(dailyRows.map((r) => [r.day, r]));
    const daily = dayKeys(from, to, tz).map((day) => ({ day, inbound: n(dailyMap.get(day)?.inbound), bot: n(dailyMap.get(day)?.bot), human: n(dailyMap.get(day)?.human) }));
    const hourRows = await rows<{ k: number; c: number }>(
      tx,
      sql`select extract(hour from m.created_at at time zone ${tz})::int as k, count(*)::int as c
          from messages m join channels c on c.id = m.channel_id and c.type in ('whatsapp','messenger','instagram')
          where m.tenant_id = ${t} and m.direction = 'in' and m.created_at >= ${A}::timestamptz and m.created_at < ${B}::timestamptz group by 1`,
    );
    const wdRows = await rows<{ k: number; c: number }>(
      tx,
      sql`select extract(dow from m.created_at at time zone ${tz})::int as k, count(*)::int as c
          from messages m join channels c on c.id = m.channel_id and c.type in ('whatsapp','messenger','instagram')
          where m.tenant_id = ${t} and m.direction = 'in' and m.created_at >= ${A}::timestamptz and m.created_at < ${B}::timestamptz group by 1`,
    );

    // ---- tiempo de respuesta: primer mensaje de cada racha del cliente -> siguiente mensaje nuestro
    const resp = await one<{ p50: number | null; p90: number | null; measured: number; unanswered: number }>(
      tx,
      sql`with ordered as (
            select m.id, m.conversation_id, m.direction, m.created_at,
              lag(m.direction) over (partition by m.conversation_id order by m.created_at, m.id) as prev_dir
            from messages m join channels c on c.id = m.channel_id and c.type in ('whatsapp','messenger','instagram')
            where m.tenant_id = ${t} and m.created_at >= ${A}::timestamptz and m.created_at < ${B}::timestamptz
          ), firsts as (select * from ordered where direction = 'in' and prev_dir is distinct from 'in'),
          timed as (
            select f.created_at as at, nx.t as reply_at,
              extract(epoch from (nx.t - f.created_at)) as secs
            from firsts f
            cross join lateral (
              select min(o.created_at) as t from messages o
              where o.conversation_id = f.conversation_id and o.direction = 'out' and o.created_at > f.created_at
            ) nx
          )
          select
            percentile_cont(0.5) within group (order by secs) filter (where reply_at is not null and secs < 86400) as p50,
            percentile_cont(0.9) within group (order by secs) filter (where reply_at is not null and secs < 86400) as p90,
            count(*) filter (where reply_at is not null and secs < 86400)::int as measured,
            count(*) filter (where reply_at is null and at < ${B}::timestamptz - interval '15 minutes')::int as unanswered
          from timed`,
    );

    // ---- conversaciones y escalaciones
    const conv = await one<{ created: number; resolved: number; active: number }>(
      tx,
      sql`with act as (
            select distinct m.conversation_id from messages m join channels c on c.id = m.channel_id and c.type in ('whatsapp','messenger','instagram')
            where m.tenant_id = ${t} and m.created_at >= ${A}::timestamptz and m.created_at < ${B}::timestamptz
          )
          select
            (select count(*)::int from conversations cv join channels c on c.id = cv.channel_id and c.type in ('whatsapp','messenger','instagram')
              where cv.tenant_id = ${t} and cv.created_at >= ${A}::timestamptz and cv.created_at < ${B}::timestamptz) as created,
            (select count(*)::int from act) as active,
            (select count(*)::int from act a where
               exists (select 1 from messages x where x.conversation_id = a.conversation_id and x.direction = 'out' and x.sender = 'bot' and x.created_at >= ${A}::timestamptz and x.created_at < ${B}::timestamptz)
               and not exists (select 1 from messages x where x.conversation_id = a.conversation_id and x.sender = 'human' and x.created_at >= ${A}::timestamptz and x.created_at < ${B}::timestamptz)
               and not exists (select 1 from handoffs h where h.conversation_id = a.conversation_id and h.created_at >= ${A}::timestamptz and h.created_at < ${B}::timestamptz)) as resolved`,
    );
    const ho = await one<{ urgent: number; open: number; med_min: number | null }>(
      tx,
      sql`select
            count(*) filter (where urgency = 'alta' and created_at >= ${A}::timestamptz and created_at < ${B}::timestamptz)::int as urgent,
            count(*) filter (where resolved_at is null)::int as open,
            percentile_cont(0.5) within group (order by extract(epoch from (resolved_at - created_at)) / 60)
              filter (where resolved_at is not null and created_at >= ${A}::timestamptz and created_at < ${B}::timestamptz) as med_min
          from handoffs where tenant_id = ${t}`,
    );
    const reasons = await rows<{ reason: string; urgency: string; at: Date }>(
      tx,
      sql`select reason, urgency, created_at as at from handoffs where tenant_id = ${t} and created_at >= ${A}::timestamptz and created_at < ${B}::timestamptz order by created_at desc limit 5`,
    );
    const takers = await rows<{ name: string | null; c: number }>(
      tx,
      sql`select coalesce(u.name, u.email, 'Persona') as name, count(*)::int as c
          from handoffs h join users u on u.id = h.taken_by
          where h.tenant_id = ${t} and h.created_at >= ${A}::timestamptz and h.created_at < ${B}::timestamptz
          group by 1 order by 2 desc limit 8`,
    );

    // ---- borradores del asistente (modo copiloto / semi)
    const ap = await one<{ approved: number; edited: number; discarded: number; pending: number }>(
      tx,
      sql`select
            count(*) filter (where status = 'approved')::int as approved,
            count(*) filter (where status = 'edited')::int as edited,
            count(*) filter (where status = 'discarded')::int as discarded,
            count(*) filter (where status = 'pending')::int as pending
          from approvals where tenant_id = ${t} and created_at >= ${A}::timestamptz and created_at < ${B}::timestamptz`,
    );

    // ---- citas
    const ac = await one<{ created: number; by_assistant: number; lead_days: number | null }>(
      tx,
      sql`select count(*)::int as created,
            count(*) filter (where source_conversation_id is not null)::int as by_assistant,
            avg(extract(epoch from (starts_at - created_at)) / 86400) as lead_days
          from appointments where tenant_id = ${t} and created_at >= ${A}::timestamptz and created_at < ${B}::timestamptz`,
    );
    const out = await one<Record<string, number>>(
      tx,
      sql`select
            count(*) filter (where status = 'confirmed')::int as confirmed,
            count(*) filter (where status = 'pending')::int as pending,
            count(*) filter (where status = 'cancelled')::int as cancelled,
            count(*) filter (where status = 'no_show')::int as no_show,
            count(*) filter (where status = 'done')::int as done
          from appointments where tenant_id = ${t} and starts_at >= ${A}::timestamptz and starts_at < ${B}::timestamptz`,
    );
    const up = await one<{ total: number; unconfirmed: number }>(
      tx,
      sql`select count(*)::int as total, count(*) filter (where confirmed_by_contact = false)::int as unconfirmed
          from appointments where tenant_id = ${t} and status in ('pending','confirmed') and starts_at >= ${B}::timestamptz and starts_at < ${B}::timestamptz + interval '7 days'`,
    );
    const rev = await one<{ cents: number | string | null }>(
      tx,
      sql`select coalesce(sum(s.price_cents), 0) as cents
          from appointments a join services s on s.id = a.service_id
          where a.tenant_id = ${t} and a.status in ('confirmed','done') and a.starts_at >= ${A}::timestamptz and a.starts_at < ${B}::timestamptz`,
    );
    const top = await rows<{ name: string; c: number }>(
      tx,
      sql`select s.name, count(*)::int as c from appointments a join services s on s.id = a.service_id
          where a.tenant_id = ${t} and a.status <> 'cancelled' and a.created_at >= ${A}::timestamptz and a.created_at < ${B}::timestamptz
          group by s.name order by 2 desc, 1 limit 5`,
    );
    const apWd = await rows<{ k: number; c: number }>(
      tx,
      sql`select extract(dow from starts_at at time zone ${tz})::int as k, count(*)::int as c from appointments
          where tenant_id = ${t} and status <> 'cancelled' and starts_at >= ${A}::timestamptz and starts_at < ${B}::timestamptz group by 1`,
    );
    const apHr = await rows<{ k: number; c: number }>(
      tx,
      sql`select extract(hour from starts_at at time zone ${tz})::int as k, count(*)::int as c from appointments
          where tenant_id = ${t} and status <> 'cancelled' and starts_at >= ${A}::timestamptz and starts_at < ${B}::timestamptz group by 1`,
    );
    const apDaily = await rows<{ day: string; c: number }>(
      tx,
      sql`select to_char((created_at at time zone ${tz})::date, 'YYYY-MM-DD') as day, count(*)::int as c from appointments
          where tenant_id = ${t} and created_at >= ${A}::timestamptz and created_at < ${B}::timestamptz group by 1`,
    );
    const apDailyMap = new Map(apDaily.map((r) => [r.day, n(r.c)]));

    // ---- seguimiento: recordatorios y clientes que regresan
    const fu = await one<Record<string, number>>(
      tx,
      sql`select
            count(*) filter (where reminder_24h_sent_at >= ${A}::timestamptz and reminder_24h_sent_at < ${B}::timestamptz)::int as sent24,
            count(*) filter (where reminder_2h_sent_at >= ${A}::timestamptz and reminder_2h_sent_at < ${B}::timestamptz)::int as sent2,
            count(*) filter (where starts_at < ${B}::timestamptz and status <> 'cancelled')::int as past_total,
            count(*) filter (where starts_at < ${B}::timestamptz and status <> 'cancelled' and (reminder_24h_sent_at is not null or reminder_2h_sent_at is not null))::int as past_reminded,
            count(*) filter (where (reminder_24h_sent_at is not null or reminder_2h_sent_at is not null) and status <> 'cancelled')::int as reminded,
            count(*) filter (where (reminder_24h_sent_at is not null or reminder_2h_sent_at is not null) and status <> 'cancelled' and confirmed_by_contact)::int as reminded_confirmed,
            count(*) filter (where status = 'no_show' and (reminder_24h_sent_at is not null or reminder_2h_sent_at is not null))::int as ns_with,
            count(*) filter (where status in ('done','no_show') and (reminder_24h_sent_at is not null or reminder_2h_sent_at is not null))::int as closed_with,
            count(*) filter (where status = 'no_show' and reminder_24h_sent_at is null and reminder_2h_sent_at is null)::int as ns_without,
            count(*) filter (where status in ('done','no_show') and reminder_24h_sent_at is null and reminder_2h_sent_at is null)::int as closed_without
          from appointments where tenant_id = ${t} and starts_at >= ${A}::timestamptz and starts_at < ${B}::timestamptz`,
    );
    const ret = await one<{ returning: number; total: number }>(
      tx,
      sql`select count(*) filter (where c >= 2)::int as returning, count(*)::int as total from (
            select contact_id, count(*) as c from appointments where tenant_id = ${t} and status in ('confirmed','done') group by contact_id
          ) q`,
    );

    // ---- contactos
    const ct = await one<{ total: number; created: number; opted_out: number; marketing: number }>(
      tx,
      sql`select count(*)::int as total,
            count(*) filter (where created_at >= ${A}::timestamptz and created_at < ${B}::timestamptz)::int as created,
            count(*) filter (where opted_out_at is not null)::int as opted_out,
            count(*) filter (where opt_in_marketing and opted_out_at is null)::int as marketing
          from contacts where tenant_id = ${t}`,
    );

    // ---- llamadas
    const cl = await one<Record<string, number | null>>(
      tx,
      sql`select count(*)::int as total,
            count(*) filter (where status = 'failed')::int as failed,
            avg(duration_seconds) filter (where duration_seconds is not null) as avg_sec,
            coalesce(sum(duration_seconds), 0) as sum_sec,
            count(*) filter (where sentiment = 'Positive')::int as pos,
            count(*) filter (where sentiment = 'Neutral')::int as neu,
            count(*) filter (where sentiment = 'Negative')::int as neg,
            count(*) filter (where sentiment is null)::int as unk,
            count(*) filter (where disconnection_reason ilike '%transfer%')::int as transferred
          from calls where tenant_id = ${t} and coalesce(started_at, created_at) >= ${A}::timestamptz and coalesce(started_at, created_at) < ${B}::timestamptz`,
    );

    // ---- costo de IA (solo dueño)
    let ai: StatsView["ai"] = null;
    if (isOwner) {
      const u = await rows<{ kind: string; micros: number | string; tin: number | string; tout: number | string }>(
        tx,
        sql`select kind::text as kind, coalesce(sum(cost_usd_micros), 0) as micros, coalesce(sum(tokens_in), 0) as tin, coalesce(sum(tokens_out), 0) as tout
            from usage_events where tenant_id = ${t} and created_at >= ${A}::timestamptz and created_at < ${B}::timestamptz group by kind order by 2 desc`,
      );
      const costUsd = u.reduce((s, r) => s + n(r.micros), 0) / 1_000_000;
      ai = {
        costUsd,
        tokensIn: u.reduce((s, r) => s + n(r.tin), 0),
        tokensOut: u.reduce((s, r) => s + n(r.tout), 0),
        costPerConversationUsd: cur.active > 0 ? costUsd / cur.active : null,
        byKind: u.map((r) => ({ kind: r.kind, costUsd: n(r.micros) / 1_000_000 })),
      };
    }

    const sentOut = n(msg.sent);
    const closedWith = n(fu.closed_with);
    const closedWithout = n(fu.closed_without);
    const apTotal = n(ac.created);
    const outcomes = {
      confirmed: n(out.confirmed),
      pending: n(out.pending),
      cancelled: n(out.cancelled),
      noShow: n(out.no_show),
      done: n(out.done),
    };

    return {
      range: { days, from: A, to: B, timezone: tz },
      headline: {
        inbound: delta(cur.inbound, prev.inbound),
        botReplies: delta(cur.bot, prev.bot),
        humanReplies: delta(cur.human, prev.human),
        activeConversations: delta(cur.active, prev.active),
        handoffs: delta(cur.handoffs, prev.handoffs),
        appointmentsCreated: delta(cur.appts, prev.appts),
      },
      messages: {
        inbound: cur.inbound,
        botReplies: cur.bot,
        humanReplies: cur.human,
        templates: n(msg.templates),
        outbound: n(msg.outbound),
        delivered: n(msg.delivered),
        read: n(msg.read),
        failed: n(msg.failed),
        deliveryRate: rate(n(msg.delivered), sentOut),
        readRate: rate(n(msg.read), sentOut),
        byChannel: byChannel.map((r) => ({ channel: r.channel, inbound: n(r.inbound), outbound: n(r.outbound) })),
        daily,
        byHour: histogram(24, hourRows),
        byWeekday: histogram(7, wdRows),
      },
      response: {
        medianSeconds: nOrNull(resp.p50),
        p90Seconds: nOrNull(resp.p90),
        measured: n(resp.measured),
        unanswered: n(resp.unanswered),
      },
      conversations: {
        active: n(conv.active),
        created: n(conv.created),
        resolvedByAssistant: n(conv.resolved),
        resolvedRate: rate(n(conv.resolved), n(conv.active)),
        handoffs: cur.handoffs,
        handoffRate: rate(cur.handoffs, n(conv.active)),
        urgentHandoffs: n(ho.urgent),
        openHandoffs: n(ho.open),
        medianHandoffResolutionMinutes: nOrNull(ho.med_min),
        recentReasons: reasons.map((r) => ({ reason: r.reason, urgency: r.urgency, at: new Date(r.at).toISOString() })),
        takenByPerson: takers.map((r) => ({ name: r.name ?? "Persona", count: n(r.c) })),
      },
      approvals: {
        total: n(ap.approved) + n(ap.edited) + n(ap.discarded) + n(ap.pending),
        approved: n(ap.approved),
        edited: n(ap.edited),
        discarded: n(ap.discarded),
        pending: n(ap.pending),
        approvedAsIsRate: rate(n(ap.approved), n(ap.approved) + n(ap.edited) + n(ap.discarded)),
      },
      appointments: {
        created: apTotal,
        byAssistant: n(ac.by_assistant),
        manual: apTotal - n(ac.by_assistant),
        assistantShare: rate(n(ac.by_assistant), apTotal),
        outcomes,
        cancelRate: rate(outcomes.cancelled, outcomes.confirmed + outcomes.pending + outcomes.cancelled + outcomes.noShow + outcomes.done),
        noShowRate: rate(outcomes.noShow, outcomes.noShow + outcomes.done),
        upcoming7d: n(up.total),
        upcomingUnconfirmed7d: n(up.unconfirmed),
        avgLeadDays: nOrNull(ac.lead_days),
        estimatedRevenue: n(rev.cents) / 100,
        topServices: top.map((r) => ({ name: r.name, count: n(r.c) })),
        byWeekday: histogram(7, apWd),
        byHour: histogram(24, apHr),
        dailyCreated: dayKeys(from, to, tz).map((day) => ({ day, count: apDailyMap.get(day) ?? 0 })),
      },
      followUp: {
        remindersSent24h: n(fu.sent24),
        remindersSent2h: n(fu.sent2),
        reminderCoverage: rate(n(fu.past_reminded), n(fu.past_total)),
        confirmedAfterReminder: rate(n(fu.reminded_confirmed), n(fu.reminded)),
        noShowRateWithReminder: rate(n(fu.ns_with), closedWith),
        noShowRateWithoutReminder: rate(n(fu.ns_without), closedWithout),
        returningClients: n(ret.returning),
        clientsWithAppointments: n(ret.total),
        returningRate: rate(n(ret.returning), n(ret.total)),
      },
      contacts: { total: n(ct.total), created: n(ct.created), optedOut: n(ct.opted_out), marketingOptIn: n(ct.marketing) },
      calls: {
        total: n(cl.total),
        failed: n(cl.failed),
        avgDurationSeconds: nOrNull(cl.avg_sec),
        totalMinutes: Math.round(n(cl.sum_sec) / 60),
        sentiment: { positive: n(cl.pos), neutral: n(cl.neu), negative: n(cl.neg), unknown: n(cl.unk) },
        transferred: n(cl.transferred),
      },
      ai,
    };
  });
}
